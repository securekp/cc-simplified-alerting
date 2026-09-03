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
 */
export function feedMetricKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function feedRowId(direction: Direction, group: string, id: string): string {
  return `${direction}|${group}|${id}`;
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
 * Turn a discovery payload into feeds.
 *
 * Disabled feeds are dropped on `disabled !== true` — they still report health, so
 * health is never the enabled test.
 */
export function toFeeds(raw: readonly RawFeed[], group: string, direction: Direction): Feed[] {
  const feeds: Feed[] = [];
  for (const entry of raw) {
    if (entry.disabled === true) continue;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const type = typeof entry.type === 'string' ? entry.type : '';
    const { health, known } = normalizeHealth(entry.status?.health);
    feeds.push({
      rowId: feedRowId(direction, group, entry.id),
      id: entry.id,
      type,
      group,
      direction,
      metricKey: feedMetricKey(type, entry.id),
      health,
      healthKnown: known,
      errorMessage: readErrorMessage(entry.status?.error),
    });
  }
  return feeds;
}
