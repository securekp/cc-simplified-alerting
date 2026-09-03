/**
 * Filtering, ranking, and summarising the coverage table. Pure, so it is testable.
 */

import { isUnhealthy } from './feeds.ts';
import type { Direction, Feed, FeedCoverage } from './types.ts';

export interface FilterState {
  /** `null` means every group. */
  group: string | null;
  /** `null` means both directions. */
  direction: Direction | null;
  uncoveredOnly: boolean;
  unhealthyOnly: boolean;
  hasErrorOnly: boolean;
  /**
   * Not Green **or** carrying an error — the union, not the intersection.
   *
   * It exists because `urgent` in the summary is the app's headline finding and the other two
   * filters cannot express it: they AND together, so `unhealthyOnly` alone drops the Green feeds
   * that carry an error and combining them drops nearly everything. Without this the app could
   * report "5 feeds are in trouble with nothing watching" and offer no way to see those 5.
   */
  troubledOnly: boolean;
  search: string;
}

export const DEFAULT_FILTERS: FilterState = {
  group: null,
  direction: null,
  uncoveredOnly: false,
  unhealthyOnly: false,
  hasErrorOnly: false,
  troubledOnly: false,
  search: '',
};

/** Is this feed visibly not fine? Health and `status.error` both count; a feed can be Green and carry one. */
export function isTroubled(feed: Feed): boolean {
  return isUnhealthy(feed.health) || feed.errorMessage !== null;
}

/** Is any filter narrowing the table right now? Drives whether a "clear" affordance is offered. */
export function hasActiveFilters(filters: FilterState): boolean {
  return (
    filters.group !== null ||
    filters.direction !== null ||
    filters.uncoveredOnly ||
    filters.unhealthyOnly ||
    filters.hasErrorOnly ||
    filters.troubledOnly ||
    filters.search.trim() !== ''
  );
}

/**
 * Is anything actually watching this feed?
 *
 * One intent means one question, so this is the app's only coverage predicate. A disabled
 * alert is not coverage — counting it would report a watched feed that nothing is watching
 * — and neither is an `unclassified` one, which lands in `coverage.other`.
 */
export function isCovered(coverage: FeedCoverage | undefined): boolean {
  if (!coverage) return false;
  return coverage.alerts.some((alert) => !alert.disabled);
}

/**
 * Rank a row. Higher sorts first.
 *
 * The ordering encodes the app's whole point: a feed that is visibly in trouble and has
 * nothing watching it is the most important row, and it goes to the top without the admin
 * having to sort for it. Health and `status.error` both count as trouble — a feed can be
 * Green and still carry an error.
 */
export function rowPriority(feed: Feed, coverage: FeedCoverage | undefined): number {
  let score = 0;
  const troubled = isTroubled(feed);
  const covered = isCovered(coverage);
  if (troubled && !covered) score += 1000;
  if (isUnhealthy(feed.health)) score += 100;
  if (feed.errorMessage) score += 50;
  if (!covered) score += 20;
  return score;
}

export function matchesFilters(
  feed: Feed,
  coverage: FeedCoverage | undefined,
  filters: FilterState,
): boolean {
  if (filters.group && feed.group !== filters.group) return false;
  if (filters.direction && feed.direction !== filters.direction) return false;
  if (filters.unhealthyOnly && !isUnhealthy(feed.health)) return false;
  if (filters.hasErrorOnly && !feed.errorMessage) return false;
  if (filters.troubledOnly && !isTroubled(feed)) return false;
  if (filters.uncoveredOnly && isCovered(coverage)) return false;
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = `${feed.id} ${feed.type} ${feed.group}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

export interface CoverageSummary {
  total: number;
  unhealthy: number;
  withError: number;
  uncovered: number;
  /** In trouble *and* unwatched — the number that should worry the admin. */
  urgent: number;
}

export function summarise(
  feeds: readonly Feed[],
  coverage: ReadonlyMap<string, FeedCoverage>,
): CoverageSummary {
  const summary: CoverageSummary = {
    total: feeds.length,
    unhealthy: 0,
    withError: 0,
    uncovered: 0,
    urgent: 0,
  };
  for (const feed of feeds) {
    const entry = coverage.get(feed.rowId);
    const unhealthy = isUnhealthy(feed.health);
    const covered = isCovered(entry);
    if (unhealthy) summary.unhealthy++;
    if (feed.errorMessage) summary.withError++;
    if (!covered) summary.uncovered++;
    if (isTroubled(feed) && !covered) summary.urgent++;
  }
  return summary;
}
