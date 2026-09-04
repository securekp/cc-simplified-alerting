/**
 * Discovery rules proven against a live deployment. Each assertion here corresponds to
 * a way the coverage table silently goes wrong if the rule is dropped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  feedMetricKey,
  feedRowId,
  isUnhealthy,
  normalizeHealth,
  packHasFeeds,
  toFeeds,
  toPacks,
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

  it('qualifies a Pack feed with its Pack, which is how the metric store names it', () => {
    // Verified live: `datagen:cribl-palo-alto-networks.palo_traffic` carried 33 MB in an hour
    // while no `datagen:palo_traffic` series existed at all. A bare key here would make every
    // Pack feed read as producing nothing.
    assert.equal(
      feedMetricKey('datagen', 'palo_traffic', 'cribl-palo-alto-networks'),
      'datagen:cribl-palo-alto-networks.palo_traffic',
    );
  });
});

describe('feedRowId', () => {
  it('keeps a Pack feed and a group feed of the same name apart', () => {
    // Both are real rows with their own coverage answer, so one key for the two would collapse
    // them and report the group feed's alert as watching the Pack's.
    assert.notEqual(
      feedRowId('source', 'default', 'palo_traffic'),
      feedRowId('source', 'default', 'palo_traffic', 'cribl-palo-alto-networks'),
    );
  });

  it('spells a group-level row the same way it always has, with an empty pack segment', () => {
    assert.equal(feedRowId('source', 'default', 'in_x'), 'source|default||in_x');
  });
});

describe('toPacks', () => {
  const raw = [
    { id: 'cribl-palo-alto-networks', displayName: 'Palo Alto Networks', inputs: 2, outputs: 0 },
    { id: 'anonymous', displayName: 'Off', isDisabled: true, inputs: 4 },
    { id: 'bare' },
  ];

  it('drops a disabled Pack and falls back to the id when there is no display name', () => {
    const packs = toPacks(raw, 'default');
    assert.deepEqual(
      packs.map((pack) => pack.id),
      ['bare', 'cribl-palo-alto-networks'],
      'sorted by id, so the sections read the same on every render',
    );
    assert.equal(packs[0].name, 'bare');
    assert.equal(packs[1].name, 'Palo Alto Networks');
    assert.equal(packs[0].group, 'default');
  });

  it('reads an absent count as null rather than zero', () => {
    // Zero is permission to skip a request. "Did not say" is not, and reading it as zero would
    // hide every feed in a Pack that simply omitted the field — the blind spot this exists to fix.
    const [bare, palo] = toPacks(raw, 'default');
    assert.equal(bare.inputs, null);
    assert.equal(bare.outputs, null);
    assert.equal(palo.inputs, 2);
    assert.equal(palo.outputs, 0);
  });

  it('skips entries with no usable id', () => {
    assert.deepEqual(toPacks([{ displayName: 'nameless' }, { id: '' }], 'default'), []);
  });
});

describe('packHasFeeds', () => {
  const pack = (inputs: number | null, outputs: number | null) => ({
    id: 'p',
    group: 'default',
    name: 'p',
    inputs,
    outputs,
  });

  it('says no only when the Pack reported a count and the count was zero', () => {
    assert.equal(packHasFeeds(pack(0, 3), 'source'), false);
    assert.equal(packHasFeeds(pack(0, 3), 'destination'), true);
    assert.equal(packHasFeeds(pack(2, 0), 'source'), true);
    assert.equal(packHasFeeds(pack(2, 0), 'destination'), false);
  });

  it('asks anyway when the count is absent', () => {
    assert.equal(packHasFeeds(pack(null, null), 'source'), true);
    assert.equal(packHasFeeds(pack(null, null), 'destination'), true);
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

  it('stamps the Pack from the scope it was read in, because the entries do not carry it', () => {
    // The Pack-level call returns feeds keyed on their bare id exactly as the group-level call
    // does, so nothing in the response distinguishes the two. Only the caller knows.
    const [feed] = toFeeds(
      [{ id: 'palo_traffic', type: 'datagen', status: { health: 'Green' } }],
      'default',
      'source',
      'cribl-palo-alto-networks',
    );
    assert.equal(feed.pack, 'cribl-palo-alto-networks');
    assert.equal(feed.metricKey, 'datagen:cribl-palo-alto-networks.palo_traffic');
    const [groupLevel] = toFeeds([{ id: 'palo_traffic', type: 'datagen' }], 'default', 'source');
    assert.equal(groupLevel.pack, null);
    assert.notEqual(feed.rowId, groupLevel.rowId);
  });

  it('drops a Pack’s default and devnull Destinations, whatever they are called', () => {
    // Every Pack ships both, and neither can answer "did this feed stop delivering data?" —
    // devnull discards by design and default forwards elsewhere. Matched on type, so a second
    // DevNull under a custom id goes too.
    const feeds = toFeeds(
      [
        { id: 'default', type: 'default', status: {} },
        { id: 'devnull', type: 'devnull', status: { health: 'Green' } },
        { id: 'my_bit_bucket', type: 'devnull', status: { health: 'Green' } },
        { id: 'out_lake', type: 'cribl_lake', status: { health: 'Green' } },
      ],
      'default',
      'destination',
      'cribl-palo-alto-networks',
    );
    assert.deepEqual(
      feeds.map((feed) => feed.id),
      ['out_lake'],
    );
  });

  it('keeps the group-level default and devnull, because there is one of each, not one per Pack', () => {
    const feeds = toFeeds(
      [
        { id: 'default', type: 'default', status: {} },
        { id: 'devnull', type: 'devnull', status: { health: 'Green' } },
      ],
      'default',
      'destination',
    );
    assert.deepEqual(
      feeds.map((feed) => feed.id),
      ['default', 'devnull'],
    );
  });
});
