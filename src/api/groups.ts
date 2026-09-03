import { fetchAllPages } from './client.ts';
import { toStreamGroups, type RawGroup } from '../lib/feeds.ts';
import type { WorkerGroup } from '../lib/types.ts';

/**
 * List Stream worker groups.
 *
 * `product=stream` is passed as a hint only. Asking the API for Stream groups was
 * observed to return `outpost`-type groups as well, so `toStreamGroups` filters on
 * `type === 'stream'` in app code and that filter is the one that counts.
 */
export async function fetchWorkerGroups(signal?: AbortSignal): Promise<WorkerGroup[]> {
  const raw = await fetchAllPages<RawGroup>('/master/groups', {
    query: { product: 'stream' },
    signal,
  });
  return toStreamGroups(raw);
}

/**
 * Every group id, unfiltered — the candidate list for finding the monitor host.
 *
 * Deliberately **not** filtered to `type === 'stream'`. The monitors that alert on Stream
 * feeds were observed living in `default_search`, a Search group, which the Stream-filtered
 * list above correctly excludes. Filtering here would rule out the only group that answers.
 */
export async function fetchAllGroupIds(signal?: AbortSignal): Promise<string[]> {
  const raw = await fetchAllPages<RawGroup>('/master/groups', { signal });
  const ids = raw.flatMap((group) =>
    typeof group.id === 'string' && group.id ? [group.id] : [],
  );
  return [...new Set(ids)];
}
