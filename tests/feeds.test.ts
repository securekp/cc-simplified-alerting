/**
 * Discovery rules proven against a live deployment. Each assertion here corresponds to
 * a way the coverage table silently goes wrong if the rule is dropped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  feedMetricKey,
  isUnhealthy,
  normalizeHealth,
  toFeeds,
  toStreamGroups,
} from '../src/lib/feeds.ts';

describe('normalizeHealth', () => {
  it('reads the platform verdict as-is, case-insensitively', () => {
    assert.deepEqual(normalizeHealth('Green'), { health: 'Green', known: true });
    assert.deepEqual(normalizeHealth('red'), { health: 'Red', known: true });
    assert.deepEqual(normalizeHealth('Yellow'), { health: 'Yellow', known: true });
    assert.deepEqual(normalizeHealth('Unknown'), { health: 'Unknown', known: true });
  });

  it('treats a missing health as Unknown, never as healthy', () => {
    // The synthetic `default` destination returns `status: {}`. Reading that as
    // falsy-therefore-Green would report a feed healthy on no evidence.
    for (const raw of [undefined, null, '', 'nonsense', {}, true]) {
      assert.deepEqual(
        normalizeHealth(raw),
        { health: 'Unknown', known: false },
        `${JSON.stringify(raw) ?? 'undefined'} must not read as healthy`,
      );
    }
  });

  it('accepts the numeric encoding, where 0 is Green and 2 is Red', () => {
    assert.deepEqual(normalizeHealth(0), { health: 'Green', known: true });
    assert.deepEqual(normalizeHealth(2), { health: 'Red', known: true });
  });
});

describe('isUnhealthy', () => {
  it('counts anything that is not Green, including Unknown', () => {
    assert.equal(isUnhealthy('Green'), false);
    assert.equal(isUnhealthy('Yellow'), true);
    assert.equal(isUnhealthy('Red'), true);
    assert.equal(isUnhealthy('Unknown'), true);
  });
});

describe('feedMetricKey', () => {
  it('is constructed from type and id, so ids containing colons survive', () => {
    // `syslog:in_syslog:udp` is type `syslog`, id `in_syslog:udp`. Splitting a dimension
    // value on every colon would produce the wrong key and an uncovered-looking feed.
    assert.equal(feedMetricKey('syslog', 'in_syslog:udp'), 'syslog:in_syslog:udp');
    assert.equal(feedMetricKey('cribl_lake', 'palo_traffic'), 'cribl_lake:palo_traffic');
  });
});

describe('toStreamGroups', () => {
  it('drops non-stream groups even though the API was asked for stream only', () => {
    const groups = toStreamGroups([
      { id: 'default', name: 'default', type: 'stream', workerCount: 2 },
      { id: 'edge_fleet', name: 'Edge', type: 'outpost', workerCount: 9 },
    ]);
    assert.deepEqual(
      groups.map((group) => group.id),
      ['default'],
    );
  });

  it('keeps an absent workerCount as null rather than zero, and defaults name to the id', () => {
    // Observed live: the `defaultHybrid` Stream group omits `workerCount` entirely. Zero
    // would make the engine check block monitor creation for a group that never said it
    // had no Workers.
    const [group] = toStreamGroups([{ id: 'g1', type: 'stream' }]);
    assert.equal(group.name, 'g1');
    assert.equal(group.workerCount, null);
  });

  it('keeps a real zero workerCount, reported faithfully but never acted on', () => {
    const [group] = toStreamGroups([{ id: 'default', type: 'stream', workerCount: 0 }]);
    assert.equal(group.workerCount, 0);
  });

  it('skips entries with no usable id', () => {
    assert.deepEqual(toStreamGroups([{ name: 'nameless', type: 'stream' }, { id: '', type: 'stream' }]), []);
  });
});

describe('toFeeds', () => {
  const raw = [
    { id: 'in_syslog:udp', type: 'syslog', status: { health: 'Green' } },
    { id: 'in_disabled', type: 'http', disabled: true, status: { health: 'Green' } },
    { id: 'in_no_status', type: 'tcp', status: {} },
    {
      id: 'out_splunk',
      type: 'splunk',
      status: { health: 'Green', error: { message: 'There is an issue with the underlying destinations.' } },
    },
  ];

  it('filters on disabled, not on health', () => {
    // Disabled feeds still report health, so health is never the enabled test.
    const feeds = toFeeds(raw, 'default', 'source');
    assert.deepEqual(
      feeds.map((feed) => feed.id),
      ['in_syslog:udp', 'in_no_status', 'out_splunk'],
    );
  });

  it('carries a Green feed’s error message through, because Green does not mean fine', () => {
    const feeds = toFeeds(raw, 'default', 'destination');
    const splunk = feeds.find((feed) => feed.id === 'out_splunk');
    assert.ok(splunk);
    assert.equal(splunk.health, 'Green');
    assert.equal(splunk.errorMessage, 'There is an issue with the underlying destinations.');
  });

  it('marks a feed with no status.health as Unknown and not known', () => {
    const feed = toFeeds(raw, 'default', 'source').find((entry) => entry.id === 'in_no_status');
    assert.ok(feed);
    assert.equal(feed.health, 'Unknown');
    assert.equal(feed.healthKnown, false);
  });

  it('keys rows by direction, group, and id, since feed ids repeat across groups', () => {
    const [first] = toFeeds([{ id: 'in_x', type: 'tcp' }], 'groupA', 'source');
    const [second] = toFeeds([{ id: 'in_x', type: 'tcp' }], 'groupB', 'source');
    assert.notEqual(first.rowId, second.rowId);
  });
});
