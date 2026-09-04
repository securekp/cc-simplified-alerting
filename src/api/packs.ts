/**
 * Pack discovery.
 *
 * A Pack is a second scope inside a worker group, and it is genuinely invisible from the
 * group-level calls: a Source defined inside a Pack has **no row** in
 * `/m/:gid/system/inputs`, only in `/m/:gid/p/:pack/system/inputs`. It still carries traffic —
 * verified live, where `datagen:cribl-palo-alto-networks.palo_traffic` moved 33 MB in an hour —
 * so a coverage table built from the group-level calls alone reports full coverage while a whole
 * Pack goes unwatched.
 *
 * This module answers only "which Packs are there?". The feeds inside them come from
 * `api/feeds.ts` with a `FeedScope` naming the Pack, because the payload and every rule that
 * applies to it are identical once the path is right.
 */

import { fetchAllUnique } from './client.ts';
import { toPacks, type Pack, type RawPack } from '../lib/feeds.ts';

function idOf(item: { id?: unknown }): string | null {
  return typeof item.id === 'string' && item.id ? item.id : null;
}

/**
 * Group-prefixed, because Packs are installed per worker group.
 *
 * `openapi.json` documents this as `/packs`, which is the single-instance form — the same
 * omission as `/system/inputs` and `/alert/monitors`, both of which answer only under
 * `/m/{gid}/` on a distributed deployment.
 */
export function packsPath(group: string): string {
  return `/m/${encodeURIComponent(group)}/packs`;
}

/**
 * Every enabled Pack in one worker group.
 *
 * Paged to exhaustion like every other list endpoint: `/packs` takes `offset`/`limit`, and a
 * first-page-only read would silently drop the Packs that sort last.
 */
export async function fetchPacks(group: string, signal?: AbortSignal): Promise<Pack[]> {
  const raw = await fetchAllUnique<RawPack>(packsPath(group), idOf, { signal });
  return toPacks(raw, group);
}
