/**
 * Source and Destination discovery.
 *
 * Health arrives inline with discovery: `/m/:gid/system/inputs` and `/system/outputs`
 * already carry `status.health`, so one call per group per direction fills the whole
 * coverage table. The `/system/status/*` endpoints are a lazy enhancement, fetched
 * only when a row is expanded for the per-Worker-Process breakdown.
 *
 * There are **two scopes**, and neither is reachable from the other. A group's own feeds live
 * under `/m/:gid/system/…`; a Pack's live under `/m/:gid/p/:pack/system/…` and appear in the
 * group-level response not at all. That is why a `FeedScope` is threaded through every call
 * here rather than a bare group id: an app that only knew about groups would render a table
 * that looks complete while a Pack carrying real traffic is missing from it.
 */

import { fetchAllUnique } from './client.ts';
import { normalizeHealth, toFeeds, type RawFeed } from '../lib/feeds.ts';
import type { Direction, Feed, Health } from '../lib/types.ts';

function idOf(item: { id?: unknown }): string | null {
  return typeof item.id === 'string' && item.id ? item.id : null;
}

/**
 * Where a set of feeds is read from: a worker group, optionally narrowed to one Pack inside it.
 *
 * Packs are group-scoped objects, so the Pack prefix is always *inside* the group prefix — the
 * root-level `/p/{pack}/…` paths `openapi.json` documents are the single-instance form and are
 * the same trap as `/system/inputs` and `/alert/monitors`.
 */
export interface FeedScope {
  group: string;
  pack: string | null;
}

export function groupScope(group: string): FeedScope {
  return { group, pack: null };
}

/** `/m/{group}` or `/m/{group}/p/{pack}`. */
export function scopePrefix(scope: FeedScope): string {
  const base = `/m/${encodeURIComponent(scope.group)}`;
  return scope.pack ? `${base}/p/${encodeURIComponent(scope.pack)}` : base;
}

function discoveryPath(scope: FeedScope, direction: Direction): string {
  return `${scopePrefix(scope)}/system/${direction === 'source' ? 'inputs' : 'outputs'}`;
}

function statusPath(scope: FeedScope, direction: Direction): string {
  return `${scopePrefix(scope)}/system/status/${direction === 'source' ? 'inputs' : 'outputs'}`;
}

export async function fetchFeeds(
  scope: FeedScope,
  direction: Direction,
  signal?: AbortSignal,
): Promise<Feed[]> {
  const raw = await fetchAllUnique<RawFeed>(discoveryPath(scope, direction), idOf, { signal });
  return toFeeds(raw, scope.group, direction, scope.pack);
}

/** Per-Worker-Process health breakdown, shown when a health cell is expanded. */
export interface HealthDetail {
  health: Health;
  /** State → number of Worker Processes reporting it. */
  healthCounts: Record<string, number>;
  error: string | null;
  /** Persistent-queue status, surfaced as-is; not interpreted here. */
  pq: unknown;
  timestamp: number | null;
}

interface RawStatus {
  id?: unknown;
  health?: unknown;
  status?: { health?: unknown; healthCounts?: unknown; error?: unknown; pq?: unknown };
  healthCounts?: unknown;
  error?: unknown;
  pq?: unknown;
  timestamp?: unknown;
}

function readCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
  }
  return counts;
}

function readError(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw && typeof raw === 'object') {
    const message = (raw as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}

/**
 * Fetch the status detail for one direction of one scope, keyed by feed id.
 *
 * Called on expand only. A failure here degrades that one cell to "unavailable" —
 * the base health column comes from discovery and is unaffected.
 */
export async function fetchHealthDetail(
  scope: FeedScope,
  direction: Direction,
  signal?: AbortSignal,
): Promise<Map<string, HealthDetail>> {
  const raw = await fetchAllUnique<RawStatus>(statusPath(scope, direction), idOf, { signal });
  const byId = new Map<string, HealthDetail>();
  for (const entry of raw) {
    const id = idOf(entry);
    if (!id) continue;
    // The shape has been observed both flat and nested under `status`; accept either
    // rather than guessing, since this is a display-only enhancement.
    const nested = entry.status ?? {};
    byId.set(id, {
      health: normalizeHealth(nested.health ?? entry.health).health,
      healthCounts: readCounts(nested.healthCounts ?? entry.healthCounts),
      error: readError(nested.error ?? entry.error),
      pq: nested.pq ?? entry.pq ?? null,
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null,
    });
  }
  return byId;
}
