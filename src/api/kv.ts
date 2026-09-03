/**
 * App-scoped KV store.
 *
 * This is the app's only persistence. Browser storage is never used: the app runs in a
 * sandboxed iframe where `localStorage` and friends can be partitioned or cleared, and
 * are never shared across users, devices, or sessions.
 *
 * The registry stored here is a **cache, not the truth**. It is always reconciled
 * against `GET /notifications` before it drives the coverage column, because a stale entry
 * that made an uncovered feed look covered would hide exactly the gap this app exists to
 * find.
 */

import { apiDelete, apiGet, apiPost, apiPut, mapLimit } from './client.ts';
import type { Direction, ManagedRecord, Signal } from '../lib/types.ts';

/*
 * The key prefix, which is not the app scoping.
 *
 * Scoping is the platform's: `/kvstore/{key}` is rewritten to `/a/{appId}/kvstore/{key}`, so a
 * renamed app reads a *different* store and there is nothing here to migrate — the app's earlier
 * name (`ally-monitoring`) is deliberately not read as a fallback, because those keys are not
 * reachable from this app id at all. No alert is lost by that: the registry is a cache, coverage
 * is read live from Cribl, and an alert whose record is gone still proves its own authorship
 * through the reserved id namespace or the monitor description marker.
 */
const NAMESPACE = 'cc-simplified-alerting';
const REGISTRY_PREFIX = `${NAMESPACE}/managed`;
const TEMPLATE_DEFAULTS_KEY = `${NAMESPACE}/template-defaults`;

/**
 * The registry is split by mechanism, and it has to be.
 *
 * `alertId` and `monitorId` deliberately produce the *same* string for a given feed — the two
 * objects live in different Cribl collections, so sharing the reserved id namespace is fine
 * there. One KV path is not: a monitor record would overwrite the Notification record for the
 * same feed, and the app would forget which mechanism it used and which host group it wrote to.
 *
 * `notification` stays first and is still listed, so keys written before the monitor mechanism
 * existed read back unchanged. No migration is performed.
 */
export type RegistryKind = 'notification' | 'monitor';
const REGISTRY_KINDS: readonly RegistryKind[] = ['notification', 'monitor'];

/** Which half of the registry a record belongs in, read from the settings it recorded. */
export function registryKindOf(record: Pick<ManagedRecord, 'settings'>): RegistryKind {
  return record.settings?.mechanism === 'monitor' ? 'monitor' : 'notification';
}

/** Bounded so a large registry can never fan out an unbounded number of requests. */
const MAX_REGISTRY_KEYS = 300;
const READ_CONCURRENCY = 6;

function keyFor(id: string, kind: RegistryKind): string {
  return `${REGISTRY_PREFIX}/${kind}/${id}`;
}

function kvPath(key: string): string {
  // Slashes are the KV store's own path separator, so they are not encoded; the
  // segments themselves are, since an alert id could still carry an odd character.
  return `/kvstore/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Read a stored value.
 *
 * Accepts both an object and a JSON string, because the store round-trips values as
 * text and a value written by an older build may be double-encoded. Returns `null`
 * for anything unreadable rather than throwing — a corrupt cache entry must not stop
 * the app loading.
 */
function decode<T>(body: unknown, key: string): T | null {
  if (body === undefined || body === null || body === '') return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as T;
    } catch {
      console.warn(`[cc-simplified-alerting] KV value at ${key} is not JSON; ignoring it.`);
      return null;
    }
  }
  return body as T;
}

export async function kvGet<T>(key: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const body = await apiGet<unknown>(kvPath(key), { signal });
    return decode<T>(body, key);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return null;
    throw error;
  }
}

/**
 * Write a value.
 *
 * Serialized to a string rather than sent as a bare object, per the Cribl Apps KV
 * guidance ("Don't store JSON objects, they must be serialized / deserialized as
 * strings"). `decode` above accepts both forms, so values written by an earlier build as
 * raw objects still read back correctly and no migration is needed.
 */
export function kvPut(key: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
  return apiPut<unknown>(kvPath(key), JSON.stringify(value), { signal });
}

export function kvDelete(key: string, signal?: AbortSignal): Promise<unknown> {
  return apiDelete<unknown>(kvPath(key), { signal });
}

/**
 * Pull the key list out of whatever envelope the store answered with.
 *
 * Returns `null` — not `[]` — for a shape it does not recognise. That distinction is the
 * whole point: an empty registry and an unparseable response are opposite facts, and
 * conflating them made every alert this app created report as "not created by this app"
 * with no warning anywhere. Only a genuinely empty list may read as empty.
 */
function extractKeys(body: unknown): string[] | null {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).items ?? (body as Record<string, unknown>).keys)
      : undefined;
  if (!Array.isArray(list)) return null;

  const keys: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      keys.push(entry);
      continue;
    }
    // Some list endpoints wrap each key in an object; take the first string that could be one.
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const key = [record.key, record.name, record.id].find((value) => typeof value === 'string');
      if (typeof key === 'string') keys.push(key);
    }
  }
  return keys;
}

export async function kvListKeys(prefix: string, signal?: AbortSignal): Promise<string[]> {
  const body = await apiPost<unknown>('/kvstore/keys', { prefix }, { signal });
  const keys = extractKeys(body);
  if (keys === null) {
    throw new Error(
      `POST /kvstore/keys answered with an unrecognised shape (${describeShape(body)}), so the ` +
        'registry of app-created alerts could not be listed.',
    );
  }
  // Returned verbatim. Whether the store echoes full keys or keys relative to the queried
  // prefix is not documented, so the caller normalises rather than this filtering on a
  // guess — a prefix filter on the wrong assumption is another silent empty registry.
  return keys;
}

function describeShape(body: unknown): string {
  if (body === null) return 'null';
  if (Array.isArray(body)) return 'array';
  if (typeof body !== 'object') return typeof body;
  const keys = Object.keys(body as object);
  return keys.length > 0 ? `object with keys ${keys.slice(0, 6).join(', ')}` : 'empty object';
}

// ---------------------------------------------------------------------------
// Registry of alerts this app created
// ---------------------------------------------------------------------------

function isManagedRecord(value: unknown): value is ManagedRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ManagedRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.group === 'string' &&
    (record.direction === 'source' || record.direction === 'destination')
  );
}

export interface RegistryLoad {
  records: ManagedRecord[];
  /** True when there were more keys than we are willing to read in one go. */
  truncated: boolean;
  /** Keys that existed but could not be read, so the UI can say so plainly. */
  unreadable: string[];
}

/**
 * Turn a listed key into one `kvGet` can read.
 *
 * The store may echo the full key or just the part after the queried prefix; both are
 * accepted, because guessing wrong here empties the registry without failing.
 */
export function normalizeRegistryKey(listed: string, kind: RegistryKind = 'notification'): string {
  const trimmed = listed.replace(/^\/+/, '');
  if (trimmed.startsWith(`${REGISTRY_PREFIX}/`)) return trimmed;
  for (const known of REGISTRY_KINDS) {
    if (trimmed.startsWith(`${known}/`)) return `${REGISTRY_PREFIX}/${trimmed}`;
  }
  return `${REGISTRY_PREFIX}/${kind}/${trimmed}`;
}

export async function loadRegistry(signal?: AbortSignal): Promise<RegistryLoad> {
  // One list call per kind. A failure in either fails the whole read: a half-listed registry
  // would report the app's own alerts as unmanaged without saying anything was missing.
  const perKind = await Promise.all(
    REGISTRY_KINDS.map(async (kind) => {
      const listed = await kvListKeys(`${REGISTRY_PREFIX}/${kind}`, signal);
      return listed.map((key) => normalizeRegistryKey(key, kind));
    }),
  );
  const keys = [...new Set(perKind.flat())];
  const truncated = keys.length > MAX_REGISTRY_KEYS;
  const wanted = truncated ? keys.slice(0, MAX_REGISTRY_KEYS) : keys;
  if (truncated) {
    console.warn(
      `[cc-simplified-alerting] registry has ${keys.length} keys; reading the first ${MAX_REGISTRY_KEYS}.`,
    );
  }

  const unreadable: string[] = [];
  const results = await mapLimit(wanted, READ_CONCURRENCY, async (key) => {
    try {
      const value = await kvGet<unknown>(key, signal);
      if (isManagedRecord(value)) return value;
      // Listed but unusable — including a value that read back empty or 404'd. Counted,
      // not skipped: a key the app wrote and cannot read back is exactly the condition
      // that makes an app-created alert look like somebody else's.
      unreadable.push(key);
      return null;
    } catch {
      unreadable.push(key);
      return null;
    }
  });

  return {
    records: results.filter((record): record is ManagedRecord => record !== null),
    truncated,
    unreadable,
  };
}

export interface RegistryEntryInput {
  id: string;
  signal: Signal;
  group: string;
  direction: Direction;
  feedId: string;
  settings: Record<string, unknown>;
}

export function saveRegistryEntry(
  entry: RegistryEntryInput,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const record: ManagedRecord = { ...entry, createdAt: Date.now() };
  return kvPut(keyFor(entry.id, registryKindOf(record)), record, abortSignal);
}

export function deleteRegistryEntry(
  id: string,
  kind: RegistryKind = 'notification',
  signal?: AbortSignal,
): Promise<unknown> {
  return kvDelete(keyFor(id, kind), signal);
}

/**
 * Drop registry entries whose alert no longer exists.
 *
 * Best-effort: a failed delete leaves a stale key, which is harmless because
 * reconciliation already excluded it from coverage this session.
 */
export async function pruneRegistry(
  stale: readonly ManagedRecord[],
  signal?: AbortSignal,
): Promise<void> {
  await mapLimit(stale, READ_CONCURRENCY, async (record) => {
    try {
      await deleteRegistryEntry(record.id, registryKindOf(record), signal);
    } catch (error) {
      console.warn(`[cc-simplified-alerting] could not prune stale registry entry ${record.id}:`, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Template defaults
// ---------------------------------------------------------------------------

/**
 * Last-used bulk-apply settings. Deliberately excludes view/filter state.
 *
 * Stored per direction, because the two directions land on different conditions with
 * different `conf` fields — a Source on `no-data`, a Destination on `unhealthy-dest` — so
 * one shared `conf` would carry a field the other condition does not declare.
 */
export interface TemplateDefaults {
  sourceConditionId?: string;
  sourceConf?: Record<string, unknown>;
  destinationConditionId?: string;
  destinationConf?: Record<string, unknown>;
  /**
   * The delivery choice: `'policy'` or `'targets'`, the target ids, and the template chosen per
   * target. Shared by both directions and both mechanisms, because a target and a policy are
   * deployment-wide objects — see `TemplateSettings.routing`.
   *
   * `notificationTargets` predates the choice and keeps its name and meaning, so a build that
   * only ever stored targets reads back as the targets it stored. `coerceRouting` treats a
   * stored target list with no stored mode as `'targets'` for exactly that reason.
   */
  routingMode?: string;
  notificationTargets?: string[];
  notificationTemplateByTarget?: Record<string, string>;
  /**
   * The address an email-templated alert is delivered to, written onto each monitor as
   * `params.to` because that is where Cribl's own UI puts it and where the shipped email
   * template reads it from (`{{metadata.to}}`).
   *
   * An address is not a secret, so it is stored unencrypted like every other value here — but it
   * is personal data, so it is stored *only* because it is a per-run setting an admin would
   * otherwise retype for every bulk apply.
   */
  notificationRecipient?: string;
  /**
   * Which mechanism was used last, per direction, and the monitor thresholds that went with it.
   *
   * Stored as loose shapes and validated on read: these come back from a store this app wrote
   * on an earlier version, so a missing or unrecognised value has to fall back to the current
   * default rather than being trusted into a write payload.
   */
  sourceMechanism?: string;
  destinationMechanism?: string;
  sourceMonitor?: Record<string, unknown>;
  destinationMonitor?: Record<string, unknown>;
}

export function loadTemplateDefaults(signal?: AbortSignal): Promise<TemplateDefaults | null> {
  return kvGet<TemplateDefaults>(TEMPLATE_DEFAULTS_KEY, signal);
}

export function saveTemplateDefaults(
  defaults: TemplateDefaults,
  signal?: AbortSignal,
): Promise<unknown> {
  return kvPut(TEMPLATE_DEFAULTS_KEY, defaults, signal);
}
