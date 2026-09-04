/** The table's row model. Pure, so ordering and coverage logic stay testable. */

import { rowPriority } from './filters.ts';
import type { AttributedAlert, Direction, Feed, FeedCoverage } from './types.ts';

export interface CoverageRow {
  /** The feed's `rowId`; also the table's selection key. */
  id: string;
  feed: Feed;
  name: string;
  group: string;
  /** The Pack's display name, or `''` for a group-level feed. Sorted and searched as text. */
  pack: string;
  direction: Direction;
  health: string;
  error: string;
  /** Alerts that count as watching this feed. */
  alerts: AttributedAlert[];
  /** Attributed but not delivery coverage — backpressure, queue usage, and the like. */
  other: AttributedAlert[];
  /** Higher sorts first: in trouble and unwatched at the top. */
  priority: number;
  [key: string]: unknown;
}

/** `group/pack` — the key a Pack display name is looked up by. Packs are only unique per group. */
export function packKey(group: string, pack: string): string {
  return `${group}/${pack}`;
}

/**
 * @param packNames Pack display names by `packKey`. Optional, and a miss falls back to the Pack
 *   id: the id is always right, just less friendly, and a row must never render blank because a
 *   name lookup came up empty.
 */
export function buildRows(
  feeds: readonly Feed[],
  coverage: ReadonlyMap<string, FeedCoverage>,
  packNames: ReadonlyMap<string, string> = new Map(),
): CoverageRow[] {
  return feeds.map((feed) => {
    const entry = coverage.get(feed.rowId);
    return {
      id: feed.rowId,
      feed,
      name: feed.id,
      group: feed.group,
      pack: feed.pack ? (packNames.get(packKey(feed.group, feed.pack)) ?? feed.pack) : '',
      direction: feed.direction,
      health: feed.health,
      error: feed.errorMessage ?? '',
      alerts: entry?.alerts ?? [],
      other: entry?.other ?? [],
      priority: rowPriority(feed, entry),
    };
  });
}

/** Human description of a selection, for the sticky action bar and the preview. */
export function describeSelection(
  rows: readonly CoverageRow[],
  selected: ReadonlySet<string>,
): string {
  const chosen = rows.filter((row) => selected.has(row.id));
  const sources = chosen.filter((row) => row.direction === 'source').length;
  const destinations = chosen.length - sources;
  const parts: string[] = [];
  if (sources > 0) parts.push(`${sources} ${sources === 1 ? 'Source' : 'Sources'}`);
  if (destinations > 0) {
    parts.push(`${destinations} ${destinations === 1 ? 'Destination' : 'Destinations'}`);
  }
  return parts.join(' and ') || 'nothing';
}
