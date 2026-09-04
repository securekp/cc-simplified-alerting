/**
 * Attribution. The governing rule is: never guess. An alert that cannot be pinned to
 * exactly one feed is reported as unattributed — not silently dropped, and never counted
 * twice — so most of these tests assert on *refusals*.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attributeNotifications,
  buildCoverage,
  classifyCondition,
  directionFromCategory,
  groupScoped,
  indexRegistry,
  ownershipDetail,
  ownershipLabel,
  staleRegistryEntries,
} from '../src/lib/attribution.ts';
import type { ManagedRecord, NotificationCondition, Signal } from '../src/lib/types.ts';
import { makeAlert, makeFeed } from './fixtures.ts';

const unhealthyDest: NotificationCondition = {
  id: 'unhealthy-dest',
  name: 'Unhealthy Destination',
  category: 'destinations',
};
const noData: NotificationCondition = {
  id: 'no-data',
  name: 'No Data Received',
  category: 'sources',
  type: 'metric',
};
const conditions = new Map([
  [unhealthyDest.id, unhealthyDest],
  [noData.id, noData],
]);
const noRegistry = new Map<string, ManagedRecord>();

describe('classifyCondition', () => {
  it('labels a health condition and a volume one, both of which are coverage', () => {
    // The label is not a routing decision any more — both signals satisfy the app's one
    // intent. It exists so the UI can say what a condition watches, and so the
    // watches-neither cases below never count as coverage.
    assert.equal(classifyCondition(unhealthyDest), 'health');
    assert.equal(classifyCondition(noData), 'volume');
  });

  it('refuses to classify an unrecognised condition rather than claiming coverage', () => {
    assert.equal(classifyCondition(undefined), 'unclassified');
    assert.equal(classifyCondition({ id: 'license-expiry', name: 'License Expiry' }), 'unclassified');
  });

  it('classifies the live catalogue exactly, and does not count metric-typed extras', () => {
    // The full 10 conditions returned by GET /conditions on the verification org.
    // `backpressure-dest` and both `persistent-queue-usage*` are `type: "metric"` but
    // watch neither health nor volume: a `type === 'metric'` fallback would file them as
    // coverage and mark a feed watched for a delivery stop nobody is watching.
    const live: [NotificationCondition, Signal][] = [
      [{ id: 'unhealthy-dest', name: 'Unhealthy Destination', type: 'metric' }, 'health'],
      [{ id: 'low-volume', name: 'Low Data Volume', type: 'metric' }, 'volume'],
      [{ id: 'high-volume', name: 'High Data Volume', type: 'metric' }, 'volume'],
      [{ id: 'no-data', name: 'No Data Received', type: 'metric' }, 'volume'],
      [{ id: 'backpressure-dest', name: 'Destination Backpressure Activated', type: 'metric' }, 'unclassified'],
      [{ id: 'persistent-queue-usage', name: 'Persistent Queue Usage', type: 'metric' }, 'unclassified'],
      [{ id: 'persistent-queue-usage-source', name: 'Persistent Queue Usage', type: 'metric' }, 'unclassified'],
      [{ id: 'monitor-alerts', name: 'Monitor Alerts', type: 'monitor-alerts' }, 'unclassified'],
      [{ id: 'search', name: 'Search Condition', type: 'search' }, 'unclassified'],
      [{ id: 'license-expiration', name: 'License Expiration', type: 'message' }, 'unclassified'],
    ];
    for (const [condition, expected] of live) {
      assert.equal(classifyCondition(condition), expected, condition.id);
    }
  });
});

describe('directionFromCategory', () => {
  it('reads only the two categories it knows', () => {
    assert.equal(directionFromCategory('sources'), 'source');
    assert.equal(directionFromCategory('destinations'), 'destination');
    assert.equal(directionFromCategory('packs'), null);
    assert.equal(directionFromCategory(undefined), null);
  });
});

describe('attributeNotifications', () => {
  const dest = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination' });

  it('attributes a Notification via conf.name plus the condition category', () => {
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } }]),
      [dest],
      conditions,
      noRegistry,
    );
    assert.deepEqual(outcome.unattributed, []);
    assert.equal(outcome.attributed.length, 1);
    assert.equal(outcome.attributed[0].rowId, dest.rowId);
    assert.equal(outcome.attributed[0].signal, 'health');
    assert.equal(outcome.attributed[0].ownership, 'external');
  });

  it('keeps the stored object, so the configuration view shows what is really there', () => {
    // The click-through config screen reads this rather than re-rendering the template the
    // admin filled in — which would be wrong for any alert edited in Cribl afterwards.
    const raw = {
      id: 'n1',
      condition: 'unhealthy-dest',
      group: 'default',
      targets: ['system_notifications'],
      conf: { name: 'out_splunk', timeWindow: '120s' },
    };
    const outcome = attributeNotifications(groupScoped([raw]), [dest], conditions, noRegistry);
    const alert = outcome.attributed[0];
    assert.equal(alert.conditionId, 'unhealthy-dest');
    assert.equal(alert.conditionName, 'Unhealthy Destination');
    assert.equal(alert.group, 'default');
    assert.deepEqual(alert.config, raw);
  });

  it('reports rather than guesses when conf.name is absent', () => {
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'unhealthy-dest', conf: {} }]),
      [dest],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed.length, 0);
    assert.match(outcome.unattributed[0].reason, /no conf\.name/);
  });

  it('reports rather than guesses when the condition is not in the catalogue', () => {
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'invented-condition', conf: { name: 'out_splunk' } }]),
      [dest],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed.length, 0);
    assert.match(outcome.unattributed[0].reason, /not in the discovered catalogue/);
  });

  it('refuses to pick a group when a groupless Notification matches two feeds', () => {
    // `conf.name` holds the bare id, so the same name in two groups is genuinely
    // ambiguous. Counting it toward both would mark two feeds covered by one alert.
    const other = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination', group: 'groupB' });
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'unhealthy-dest', conf: { name: 'out_splunk' } }]),
      [dest, other],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed.length, 0);
    assert.match(outcome.unattributed[0].reason, /2 groups/);
  });

  it('does not attribute a destination condition to a same-named source', () => {
    const source = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'source' });
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } }]),
      [source],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed.length, 0);
    assert.match(outcome.unattributed[0].reason, /no enabled destination/);
  });

  it('marks a registered alert as created here and takes its signal from the registry', () => {
    const record: ManagedRecord = {
      id: 'n1',
      signal: 'health',
      group: 'default',
      direction: 'destination',
      feedId: 'out_splunk',
      settings: {},
      createdAt: 0,
    };
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } }]),
      [dest],
      conditions,
      indexRegistry([record]),
    );
    assert.equal(outcome.attributed[0].ownership, 'registry');
    assert.equal(outcome.attributed[0].signal, 'health');
  });

  it('carries the disabled flag through, since a disabled alert is not coverage', () => {
    const outcome = attributeNotifications(
      groupScoped([
        {
          id: 'n1',
          condition: 'unhealthy-dest',
          group: 'default',
          disabled: true,
          conf: { name: 'out_splunk' },
        },
      ]),
      [dest],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed[0].disabled, true);
  });

  it('recognises the app’s own id namespace when the registry has no entry', () => {
    // The registry is a cache and it can be missing an entry — an alert created by an
    // earlier build, or one whose registry write failed. The id is not user prose, it is a
    // string this app generated, so saying "not created by this app" about it is false.
    const outcome = attributeNotifications(
      groupScoped([
        { id: 'ally-default-out_splunk', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } },
        // The pre-refactor id shape, still live on the verification org.
        {
          id: 'ally-thru-default-out_splunk',
          condition: 'unhealthy-dest',
          group: 'default',
          conf: { name: 'out_splunk' },
        },
      ]),
      [dest],
      conditions,
      noRegistry,
    );
    assert.deepEqual(
      outcome.attributed.map((alert) => alert.ownership),
      ['id', 'id'],
    );
  });

  it('matches a Pack alert to the Pack’s own feed and not to the group feed of that name', () => {
    // Scope is part of the identity, not a hint. Without it these two would be ambiguous and
    // this function's own rule — never guess — would drop coverage the deployment really has.
    const inPack = makeFeed({
      id: 'out_splunk',
      type: 'splunk',
      direction: 'destination',
      pack: 'cribl-palo-alto-networks',
    });
    const raw = { id: 'n1', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } };
    const outcome = attributeNotifications(
      [{ raw, pack: 'cribl-palo-alto-networks' }],
      [dest, inPack],
      conditions,
      noRegistry,
    );
    assert.deepEqual(outcome.unattributed, []);
    assert.equal(outcome.attributed[0].rowId, inPack.rowId);
    // Carried on the alert, because the object does not hold it: the configuration view needs it
    // to tell the admin where the alert is edited.
    assert.equal(outcome.attributed[0].pack, 'cribl-palo-alto-networks');
  });

  it('never lets a group-level alert reach inside a Pack', () => {
    const inPack = makeFeed({
      id: 'out_splunk',
      type: 'splunk',
      direction: 'destination',
      pack: 'cribl-palo-alto-networks',
    });
    const outcome = attributeNotifications(
      groupScoped([{ id: 'n1', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } }]),
      [inPack],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed.length, 0);
    assert.match(outcome.unattributed[0].reason, /no enabled destination named "out_splunk"/);
  });

  it('still refuses to guess between two Packs holding the same feed name', () => {
    // Same Pack id installed in two groups, one groupless alert. The scope narrows it to the
    // Pack; it does not say which group, so this is exactly as ambiguous as the group case.
    const packed = (group: string) =>
      makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination', group, pack: 'p' });
    const outcome = attributeNotifications(
      [{ raw: { id: 'n1', condition: 'unhealthy-dest', conf: { name: 'out_splunk' } }, pack: 'p' }],
      [packed('default'), packed('groupB')],
      conditions,
      noRegistry,
    );
    assert.equal(outcome.attributed.length, 0);
    assert.match(outcome.unattributed[0].reason, /in Pack p in 2 groups/);
  });

  it('says ownership is unknown, not foreign, when the registry could not be read', () => {
    const outcome = attributeNotifications(
      groupScoped([
        { id: 'someone-elses-alert', condition: 'unhealthy-dest', group: 'default', conf: { name: 'out_splunk' } },
      ]),
      [dest],
      conditions,
      noRegistry,
      false,
    );
    assert.equal(outcome.attributed[0].ownership, 'unknown');
  });
});

describe('ownership labelling', () => {
  it('only ever denies authorship when the registry actually answered', () => {
    assert.equal(ownershipLabel('registry'), 'Created by this app');
    assert.equal(ownershipLabel('id'), 'Created by this app');
    assert.equal(ownershipLabel('external'), 'Not created by this app');
    assert.equal(ownershipLabel('unknown'), 'Ownership unknown');
  });

  it('explains itself for the two states that are claims about the app’s own evidence', () => {
    assert.equal(ownershipDetail('registry'), null);
    assert.equal(ownershipDetail('external'), null);
    assert.match(ownershipDetail('id') ?? '', /reserved id/);
    assert.match(ownershipDetail('unknown') ?? '', /could not be read/);
  });
});

describe('buildCoverage', () => {
  it('counts both signals as coverage and files unclassified separately', () => {
    // The app has one intent, and a Source proving delivery with `no-data` is exactly as
    // covered as a Destination proving it with `unhealthy-dest`. What must never count is
    // an alert watching something else entirely.
    const feed = makeFeed({ id: 'in_syslog', type: 'syslog' });
    const coverage = buildCoverage(
      [feed],
      [
        makeAlert(feed.rowId, 'health'),
        makeAlert(feed.rowId, 'volume'),
        makeAlert(feed.rowId, 'unclassified'),
        makeAlert('source|other|ghost', 'volume'),
      ],
    );
    const entry = coverage.get(feed.rowId);
    assert.equal(entry?.alerts.length, 2);
    assert.equal(entry?.other.length, 1);
    assert.equal(coverage.size, 1);
  });
});

describe('staleRegistryEntries', () => {
  it('finds entries whose alert is gone, so a stale cache cannot fake coverage', () => {
    const records: ManagedRecord[] = [
      {
        id: 'n1',
        signal: 'volume',
        group: 'default',
        direction: 'source',
        feedId: 'a',
        settings: {},
        createdAt: 0,
      },
      {
        id: 'n2',
        signal: 'health',
        group: 'default',
        direction: 'destination',
        feedId: 'b',
        settings: {},
        createdAt: 0,
      },
    ];
    const stale = staleRegistryEntries(records, new Set(['n1']));
    assert.deepEqual(
      stale.map((record) => record.id),
      ['n2'],
    );
  });
});
