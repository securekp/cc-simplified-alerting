/** The table's row model. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyCoverage } from '../src/lib/attribution.ts';
import { buildRows, describeSelection } from '../src/lib/rows.ts';
import type { FeedCoverage } from '../src/lib/types.ts';
import { makeAlert, makeFeed } from './fixtures.ts';

const unwatchedRed = makeFeed({ id: 'in_syslog', type: 'syslog', health: 'Red' });
const watchedGreen = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination' });

const coverage = new Map<string, FeedCoverage>([
  [unwatchedRed.rowId, emptyCoverage()],
  [watchedGreen.rowId, emptyCoverage()],
]);
coverage.get(watchedGreen.rowId)?.alerts.push(makeAlert(watchedGreen.rowId, 'health'));

describe('buildRows', () => {
  const rows = buildRows([unwatchedRed, watchedGreen], coverage);

  it('keys rows by the feed rowId, which is also the selection key', () => {
    assert.deepEqual(
      rows.map((row) => row.id),
      [unwatchedRed.rowId, watchedGreen.rowId],
    );
  });

  it('ranks an unhealthy, unwatched feed above a healthy watched one', () => {
    assert.ok(rows[0].priority > rows[1].priority);
  });

  it('renders a feed with no coverage entry as having no alerts, not as a crash', () => {
    const orphan = makeFeed({ id: 'in_new', type: 'tcp' });
    const [row] = buildRows([orphan], new Map());
    assert.deepEqual(row.alerts, []);
    assert.deepEqual(row.other, []);
    assert.equal(row.error, '');
  });
});

describe('describeSelection', () => {
  const rows = buildRows([unwatchedRed, watchedGreen], coverage);

  it('counts each direction and pluralises', () => {
    assert.equal(describeSelection(rows, new Set([unwatchedRed.rowId])), '1 Source');
    assert.equal(
      describeSelection(rows, new Set([unwatchedRed.rowId, watchedGreen.rowId])),
      '1 Source and 1 Destination',
    );
  });

  it('says nothing rather than an empty string when the selection is empty', () => {
    assert.equal(describeSelection(rows, new Set()), 'nothing');
  });

  it('ignores selected ids that are no longer visible', () => {
    // Narrowing a filter must not leave a hidden feed queued up for creation.
    assert.equal(describeSelection(rows, new Set(['source|other|ghost'])), 'nothing');
  });
});
