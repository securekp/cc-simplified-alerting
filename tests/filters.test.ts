/** Filtering, ranking, and the summary counters. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyCoverage } from '../src/lib/attribution.ts';
import {
  DEFAULT_FILTERS,
  hasActiveFilters,
  isCovered,
  isTroubled,
  matchesFilters,
  rowPriority,
  summarise,
} from '../src/lib/filters.ts';
import type { FeedCoverage, Signal } from '../src/lib/types.ts';
import { makeAlert, makeFeed } from './fixtures.ts';

function coverageFor(
  rowId: string,
  options: { signal?: Signal; disabled?: boolean } = {},
): FeedCoverage {
  const entry: FeedCoverage = emptyCoverage();
  const signal = options.signal ?? 'volume';
  const alert = makeAlert(rowId, signal, { disabled: options.disabled ?? false });
  if (signal === 'unclassified') entry.other.push(alert);
  else entry.alerts.push(alert);
  return entry;
}

describe('coverage predicates', () => {
  const feed = makeFeed({ id: 'in_syslog', type: 'syslog' });

  it('counts one enabled alert as covered, whichever signal it watches', () => {
    // One intent, two acceptable signals: a Source is covered by `no-data`, a Destination
    // by `unhealthy-dest`. Requiring both would mark every feed on a real deployment
    // uncovered, since neither direction offers both.
    assert.equal(isCovered(coverageFor(feed.rowId, { signal: 'volume' })), true);
    assert.equal(isCovered(coverageFor(feed.rowId, { signal: 'health' })), true);
  });

  it('does not count a disabled alert as coverage', () => {
    // Counting one would report a watched feed that nothing is actually watching.
    assert.equal(isCovered(coverageFor(feed.rowId, { disabled: true })), false);
  });

  it('does not count an unclassified alert as coverage', () => {
    // `backpressure-dest` and `persistent-queue-usage` land here. Neither detects a feed
    // that stopped delivering, so neither answers the question this column asks.
    assert.equal(isCovered(coverageFor(feed.rowId, { signal: 'unclassified' })), false);
  });

  it('treats a missing coverage entry as uncovered', () => {
    assert.equal(isCovered(undefined), false);
  });
});

describe('rowPriority', () => {
  it('puts an unhealthy feed with nothing watching it above everything else', () => {
    const unwatched = makeFeed({ id: 'a', type: 'tcp', health: 'Red' });
    const watched = makeFeed({ id: 'b', type: 'tcp', health: 'Red' });
    const healthyUnwatched = makeFeed({ id: 'c', type: 'tcp' });
    const scores = [
      rowPriority(unwatched, emptyCoverage()),
      rowPriority(watched, coverageFor(watched.rowId)),
      rowPriority(healthyUnwatched, emptyCoverage()),
    ];
    assert.ok(scores[0] > scores[1], 'unhealthy + unwatched must outrank unhealthy + watched');
    assert.ok(scores[1] > scores[2], 'unhealthy must outrank healthy');
  });

  it('lifts a Green feed that carries an error above a clean one', () => {
    const green = makeFeed({ id: 'a', type: 'splunk', direction: 'destination' });
    const greenWithError = makeFeed({
      id: 'b',
      type: 'splunk',
      direction: 'destination',
      errorMessage: 'There is an issue with the underlying destinations.',
    });
    const covered = coverageFor('x');
    assert.ok(rowPriority(greenWithError, covered) > rowPriority(green, covered));
  });
});

describe('matchesFilters', () => {
  const feed = makeFeed({ id: 'in_syslog', type: 'syslog', group: 'default', health: 'Red' });
  const covered = coverageFor(feed.rowId);

  it('passes everything through by default', () => {
    assert.equal(matchesFilters(feed, covered, DEFAULT_FILTERS), true);
  });

  it('filters on group, direction, health, error, and coverage', () => {
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, group: 'groupB' }), false);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, direction: 'destination' }), false);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, unhealthyOnly: true }), true);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, hasErrorOnly: true }), false);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, uncoveredOnly: true }), false);
    assert.equal(matchesFilters(feed, emptyCoverage(), { ...DEFAULT_FILTERS, uncoveredOnly: true }), true);
  });

  it('filters on the union of health and error, which the narrow filters cannot express', () => {
    // The reason `troubledOnly` exists: the other two AND together, so a Green feed carrying
    // an error is dropped by `unhealthyOnly` and a Red feed with no error is dropped by
    // `hasErrorOnly`. The urgent count in the summary measures the union, so a filter that
    // could not reproduce it would offer no way to see the rows the app just flagged.
    const red = makeFeed({ id: 'a', type: 'tcp', health: 'Red' });
    const greenWithError = makeFeed({ id: 'b', type: 'tcp', errorMessage: 'boom' });
    const clean = makeFeed({ id: 'c', type: 'tcp' });
    const filters = { ...DEFAULT_FILTERS, troubledOnly: true };
    assert.equal(matchesFilters(red, covered, filters), true);
    assert.equal(matchesFilters(greenWithError, covered, filters), true);
    assert.equal(matchesFilters(clean, covered, filters), false);
    // And the narrow pair really does drop one each, which is what made the union necessary.
    assert.equal(
      matchesFilters(greenWithError, covered, { ...DEFAULT_FILTERS, unhealthyOnly: true }),
      false,
    );
    assert.equal(matchesFilters(red, covered, { ...DEFAULT_FILTERS, hasErrorOnly: true }), false);
  });

  it('searches id, type, and group, case-insensitively', () => {
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, search: 'SYSLOG' }), true);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, search: ' default ' }), true);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, search: 'kafka' }), false);
  });

  it('searches the Pack too, because that is part of how an admin names a feed', () => {
    // With Packs in the table, "palo" is as likely to mean the Pack as the feed inside it.
    const inPack = makeFeed({ id: 'traffic', type: 'datagen', pack: 'cribl-palo-alto-networks' });
    assert.equal(matchesFilters(inPack, covered, { ...DEFAULT_FILTERS, search: 'palo' }), true);
    assert.equal(matchesFilters(feed, covered, { ...DEFAULT_FILTERS, search: 'palo' }), false);
  });
});

describe('isTroubled', () => {
  it('counts a Green feed carrying an error as troubled', () => {
    // Verified live: feeds read "Green" while holding a `status.error`. Health alone is not
    // the test, which is why the summary's urgent count and this filter both use the union.
    assert.equal(isTroubled(makeFeed({ id: 'a', type: 'tcp', errorMessage: 'boom' })), true);
    assert.equal(isTroubled(makeFeed({ id: 'b', type: 'tcp', health: 'Red' })), true);
    assert.equal(isTroubled(makeFeed({ id: 'c', type: 'tcp', health: 'Unknown' })), true);
    assert.equal(isTroubled(makeFeed({ id: 'd', type: 'tcp' })), false);
  });
});

describe('hasActiveFilters', () => {
  it('is false only when nothing is narrowing the table', () => {
    // Drives whether "Clear filters" is offered at all; a stray true would leave a
    // permanent button that does nothing.
    assert.equal(hasActiveFilters(DEFAULT_FILTERS), false);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, search: '   ' }), false);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, group: 'default' }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, direction: 'source' }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, uncoveredOnly: true }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, unhealthyOnly: true }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, hasErrorOnly: true }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, troubledOnly: true }), true);
    assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, search: 'syslog' }), true);
  });
});

describe('summarise', () => {
  it('counts the urgent case separately from plain unhealthy', () => {
    const urgent = makeFeed({ id: 'a', type: 'tcp', health: 'Red' });
    const unhealthyButWatched = makeFeed({ id: 'b', type: 'tcp', health: 'Yellow' });
    const greenWithError = makeFeed({ id: 'c', type: 'tcp', errorMessage: 'boom' });
    const coverage = new Map([
      [urgent.rowId, emptyCoverage()],
      [unhealthyButWatched.rowId, coverageFor(unhealthyButWatched.rowId)],
      [greenWithError.rowId, coverageFor(greenWithError.rowId)],
    ]);
    const summary = summarise([urgent, unhealthyButWatched, greenWithError], coverage);
    assert.deepEqual(summary, {
      total: 3,
      unhealthy: 2,
      withError: 1,
      uncovered: 1,
      urgent: 1,
    });
  });
});
