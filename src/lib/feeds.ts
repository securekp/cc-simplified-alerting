/**
 * Pure transformation of the discovery payload (`/m/:gid/system/inputs|outputs`)
 * into `Feed` rows. Every rule here was proven against a live deployment; each one
 * silently produces a wrong-looking table if dropped, so they are tested.
 */

import type { Direction, Feed, Health, WorkerGroup } from './types.ts';

/** Raw shape of one entry from the discovery call. Only fields we rely on. */
export interface RawFeed {
  id?: unknown;
  type?: unknown;
  disabled?: unknown;
  status?: {
    health?: unknown;
    error?: unknown;
    metrics?: unknown;
  };
}

export interface RawGroup {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  workerCount?: unknown;
}

/** Raw `GET /m/:gid/packs` item. Only the fields this app relies on. */
export interface RawPack {
  id?: unknown;
  displayName?: unknown;
  isDisabled?: unknown;
  /** Counts of Sources / Destinations declared inside the Pack. Absent on some Packs. */
  inputs?: unknown;
  outputs?: unknown;
}

/**
 * One installed Pack in one worker group.
 *
 * The two counts are kept because they are the only way to avoid a pointless pair of requests
 * per Pack: a Pack that declares zero Sources and zero Destinations has nothing this app can
 * alert on. They are `number | null` rather than `number` because the field is not required by
 * the schema, and a missing count must mean "ask" rather than "zero" — reading absent as zero
 * would silently drop every feed in a Pack that simply did not report.
 */
export interface Pack {
  id: string;
  group: string;
  /** `displayName` when the Pack supplied one, else the id. */
  name: string;
  inputs: number | null;
  outputs: number | null;
}

const HEALTH_BY_NUMBER: Record<number, Health> = { 0: 'Green', 1: 'Yellow', 2: 'Red' };

/**
 * Normalise `status.health`.
 *
 * A missing `status.health` is `Unknown`, never healthy — the synthetic `default`
 * destination returns `status: {}`, and reading that as falsy-therefore-Green would
 * report a feed healthy on no evidence.
 */
export function normalizeHealth(raw: unknown): { health: Health; known: boolean } {
  if (typeof raw === 'string') {
    const canonical = raw.trim().toLowerCase();
    if (canonical === 'green') return { health: 'Green', known: true };
    if (canonical === 'yellow') return { health: 'Yellow', known: true };
    if (canonical === 'red') return { health: 'Red', known: true };
    if (canonical === 'unknown') return { health: 'Unknown', known: true };
    return { health: 'Unknown', known: false };
  }
  if (typeof raw === 'number' && raw in HEALTH_BY_NUMBER) {
    return { health: HEALTH_BY_NUMBER[raw], known: true };
  }
  return { health: 'Unknown', known: false };
}

/** Anything other than Green counts as unhealthy — including Unknown. See `health != 0`. */
export function isUnhealthy(health: Health): boolean {
  return health !== 'Green';
}

/**
 * The metric-store dimension value for a feed.
 *
 * Constructed from the config object, never parsed out of a dimension value:
 * ids can contain colons and protocol suffixes of their own.
 *
 * A feed inside a Pack is qualified `type:pack.id` — verified live, where
 * `datagen:cribl-palo-alto-networks.palo_traffic` carried 33 MB in an hour while no
 * `datagen:palo_traffic` series existed at all.
 */
export function feedMetricKey(type: string, id: string, pack: string | null = null): string {
  return `${type}:${pack ? `${pack}.` : ''}${id}`;
}

/**
 * The table's row key.
 *
 * The pack segment is always present, empty for a group-level feed, so the two scopes can never
 * produce the same key: a Pack and its group may each hold a Source called `palo_traffic`, and
 * they are two rows with two coverage answers.
 */
export function feedRowId(
  direction: Direction,
  group: string,
  id: string,
  pack: string | null = null,
): string {
  return `${direction}|${group}|${pack ?? ''}|${id}`;
}

function readErrorMessage(error: unknown): string | null {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}

/**
 * Keep only real Stream worker groups.
 *
 * Asking the API for Stream groups returns `outpost`-type groups too, so the filter
 * has to happen here rather than being delegated to the `product` request parameter.
 */
export function toStreamGroups(raw: readonly RawGroup[]): WorkerGroup[] {
  const groups: WorkerGroup[] = [];
  for (const entry of raw) {
    if (entry.type !== 'stream') continue;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    groups.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      // A missing `workerCount` stays `null`, not `0`. Observed live: the `defaultHybrid`
      // Stream group omits the field entirely, and coercing that to zero would have the
      // engine check block monitor creation for a group that never claimed to be empty.
      workerCount: typeof entry.workerCount === 'number' ? entry.workerCount : null,
    });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Keep only the Packs worth reading feeds out of.
 *
 * `isDisabled !== true` mirrors the feed filter and for the same reason: a disabled Pack still
 * reports its contents, so its own state is the enabled test and not the feeds inside it.
 *
 * The counts are read but never trusted as data — only as permission to skip. See `packHasFeeds`.
 */
export function toPacks(raw: readonly RawPack[], group: string): Pack[] {
  const packs: Pack[] = [];
  for (const entry of raw) {
    if (entry.isDisabled === true) continue;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const count = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    packs.push({
      id: entry.id,
      group,
      name:
        typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : entry.id,
      inputs: count(entry.inputs),
      outputs: count(entry.outputs),
    });
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Is it worth asking this Pack for feeds of this direction?
 *
 * `false` **only** when the Pack reported a count and the count was zero. An absent count answers
 * `true`, because the field is optional in the schema and treating "did not say" as "has none"
 * would hide a whole Pack's feeds on no evidence — the exact failure mode this feature exists to
 * fix. The saving is real either way: most Packs ship a pipeline and no Sources at all.
 */
export function packHasFeeds(pack: Pack, direction: Direction): boolean {
  const count = direction === 'source' ? pack.inputs : pack.outputs;
  return count === null || count > 0;
}

/**
 * Destination types that are a sink rather than a delivery endpoint, dropped from the Pack rows.
 *
 * Every Pack ships a `default` and a `devnull` Destination whether it uses one or not, so on a
 * deployment with a dozen Packs these are two dozen rows nobody will ever alert on — enough to
 * make a Pack section's "N unwatched" count read as noise instead of as work. Neither can answer
 * the question this app asks: `devnull` discards by design, and `default` forwards to another
 * Destination rather than delivering anywhere itself, so "tell me when this stops delivering
 * data" is meaningless for both.
 *
 * Matched on `type`, not on `id`: a second DevNull under some other name is the same
 * non-delivery sink, and being one is what makes it unalertable — not what it is called.
 *
 * **Pack scope only.** A group has one of each rather than one per Pack, and the group-level
 * `default` Destination is a real row an admin may want in an audit; there is no volume of noise
 * there to justify hiding it.
 */
const UNALERTABLE_PACK_TYPES: ReadonlySet<string> = new Set(['default', 'devnull']);

/**
 * Turn a discovery payload into feeds.
 *
 * Disabled feeds are dropped on `disabled !== true` — they still report health, so
 * health is never the enabled test.
 *
 * `pack` is the scope the payload was read from, not something parsed out of the entries: the
 * Pack-level call returns feeds keyed on their **bare** id exactly as the group-level call does,
 * so nothing in the response distinguishes the two.
 */
export function toFeeds(
  raw: readonly RawFeed[],
  group: string,
  direction: Direction,
  pack: string | null = null,
): Feed[] {
  const feeds: Feed[] = [];
  for (const entry of raw) {
    if (entry.disabled === true) continue;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    if (pack !== null && typeof entry.type === 'string' && UNALERTABLE_PACK_TYPES.has(entry.type)) {
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : '';
    const { health, known } = normalizeHealth(entry.status?.health);
    feeds.push({
      rowId: feedRowId(direction, group, entry.id, pack),
      id: entry.id,
      type,
      group,
      direction,
      pack,
      metricKey: feedMetricKey(type, entry.id, pack),
      health,
      healthKnown: known,
      errorMessage: readErrorMessage(entry.status?.error),
    });
  }
  return feeds;
}
