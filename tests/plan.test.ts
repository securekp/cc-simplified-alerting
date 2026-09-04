/**
 * The plan. This is what the mandatory preview renders and what apply sends, so these
 * tests are about the promise the preview makes: every selected feed is accounted for,
 * and nothing that cannot be created is presented as if it could be.
 *
 * There are two mechanisms now, so a second promise is under test: the two fail
 * independently. A denied monitor write must not block a Notification item, and a monitor
 * must never be planned unless it could actually fire.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyCoverage } from '../src/lib/attribution.ts';
import {
  buildPlan,
  countPlan,
  DEFAULT_SETTINGS,
  indexFeedIdentities,
  mechanismFor,
  type PlanContext,
  type PlannedAlert,
  type TemplateSettings,
} from '../src/lib/plan.ts';
import type { Monitor } from '../src/api/monitors.ts';
import type { Direction, FeedCoverage, Mechanism, NotificationCondition } from '../src/lib/types.ts';
import { blocked, CAPABLE } from '../src/lib/types.ts';
import { makeAlert, makeFeed, makeMonitor } from './fixtures.ts';

const unhealthyDest: NotificationCondition = {
  id: 'unhealthy-dest',
  name: 'Unhealthy Destination',
  category: 'destinations',
  schema: {
    properties: {
      name: { type: 'string' },
      timeWindow: { type: 'string', duration: { min: '60s' } },
      notifyOnResolution: { type: 'boolean' },
    },
  },
};
/**
 * The Source volume condition, read live from `GET /conditions?category=sources`.
 *
 * Note the asymmetry with `unhealthy-dest`, which is real and not a simplification of the
 * fixture: Sources have volume conditions and no health condition, Destinations have a
 * health condition and no volume condition. One intent, two conditions — which is exactly
 * why the condition is chosen per direction.
 */
const lowVolume: NotificationCondition = {
  id: 'low-volume',
  name: 'Low Data Volume',
  category: 'sources',
  type: 'metric',
  schema: {
    properties: {
      name: { type: 'string' },
      dataVolume: { type: 'number' },
      timeWindow: { type: 'string', duration: { min: '60s' } },
      notifyOnResolution: { type: 'boolean' },
    },
  },
};
const conditions = new Map([
  [unhealthyDest.id, unhealthyDest],
  [lowVolume.id, lowVolume],
]);

const source = makeFeed({ id: 'in_syslog', type: 'syslog' });
const dest = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination' });

const inBytes = makeMonitor({ id: 'source_data_in_rate' });
const outBytes = makeMonitor({
  id: 'destination_data_out_rate',
  query: 'sum(rate(total_out_bytes{namespace=""}[5m])) by (output)',
});

function settings(overrides: Partial<TemplateSettings> = {}): TemplateSettings {
  return {
    ...DEFAULT_SETTINGS,
    // `DEFAULT_SETTINGS` prefers monitors, which is the app's default. These suites are about
    // the Notification arm, so they opt into it explicitly and `asMonitor` opts back out.
    mechanismBy: { source: 'notification', destination: 'notification' },
    conditionBy: { source: 'low-volume', destination: 'unhealthy-dest' },
    ...overrides,
  };
}

const noCoverage = new Map<string, FeedCoverage>();
const noTemplates: Record<Direction, Monitor[]> = { source: [], destination: [] };

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    conditions,
    coverage: noCoverage,
    alerting: CAPABLE,
    monitors: CAPABLE,
    monitorHost: 'default_search',
    monitorTemplates: { source: [inBytes], destination: [outBytes] },
    // The ordinary case: each feed tag exists in exactly one group, and no two feeds share an id.
    feedIdentities: indexFeedIdentities([source, dest]),
    ...overrides,
  };
}

/** Narrow to the Notification arm, failing the test rather than silently reading `undefined`. */
function notificationOf(item: PlannedAlert) {
  assert.equal(item.write?.kind, 'notification');
  assert.ok(item.write && item.write.kind === 'notification');
  return item.write.notification;
}

function monitorOf(item: PlannedAlert) {
  assert.equal(item.write?.kind, 'monitor', item.blocked ?? 'expected a monitor write');
  assert.ok(item.write && item.write.kind === 'monitor');
  return item.write;
}

function asMonitor(direction: Direction): Partial<TemplateSettings> {
  const mechanismBy: Record<Direction, Mechanism> = { source: 'notification', destination: 'notification' };
  mechanismBy[direction] = 'monitor';
  return { mechanismBy };
}

describe('buildPlan with Notifications', () => {
  it('builds a Notification per direction from that direction’s own condition', () => {
    const plan = buildPlan([source, dest], settings(), context());
    assert.equal(plan.length, 2);
    assert.match(plan[0].label, /Notification on "Low Data Volume"/);
    assert.match(plan[1].label, /Notification on "Unhealthy Destination"/);
    assert.equal(plan[0].signal, 'volume');
    assert.equal(plan[1].signal, 'health');
    assert.equal(plan[0].mechanism, 'notification');
  });

  it('pins conf.name to the feed rather than the template', () => {
    const plan = buildPlan(
      [source],
      settings({ confBy: { source: { name: 'somebody_else', dataVolume: 1024 }, destination: {} } }),
      context(),
    );
    const payload = notificationOf(plan[0]);
    assert.equal(payload.conf.name, 'in_syslog');
    assert.equal(payload.conf.dataVolume, 1024);
  });

  it('prunes conf against the chosen condition’s own schema', () => {
    const plan = buildPlan(
      [dest],
      settings({
        confBy: {
          source: {},
          // `dataVolume` belongs to the Source condition and `invented` to nothing; neither
          // has any business in an `unhealthy-dest` payload.
          destination: { timeWindow: '60s', notifyOnResolution: true, dataVolume: 5, invented: 'x' },
        },
      }),
      context(),
    );
    assert.deepEqual(Object.keys(notificationOf(plan[0]).conf).sort(), [
      'name',
      'notifyOnResolution',
      'timeWindow',
    ]);
  });

  it('accounts for an already-watched feed as skipped rather than dropping it', () => {
    const coverage = new Map<string, FeedCoverage>([[dest.rowId, emptyCoverage()]]);
    coverage.get(dest.rowId)?.alerts.push(makeAlert(dest.rowId, 'health'));
    const plan = buildPlan([dest], settings(), context({ coverage }));
    assert.equal(plan.length, 1);
    assert.match(plan[0].skipped ?? '', /Already has an enabled alert/);
  });

  it('shows no payload at all for a direction the catalogue cannot cover', () => {
    // Never substitute a condition that would not detect a stop, and never invent an id.
    const plan = buildPlan(
      [source],
      settings({ conditionBy: { source: null, destination: 'unhealthy-dest' } }),
      context(),
    );
    assert.equal(plan[0].write, null);
    assert.match(plan[0].blocked ?? '', /offers nothing that detects a source/);
  });

  it('refuses a condition id that is not in the discovered catalogue', () => {
    const plan = buildPlan(
      [source],
      settings({ conditionBy: { source: 'invented-condition', destination: null } }),
      context(),
    );
    assert.equal(plan[0].write, null);
    assert.ok(plan[0].blocked);
  });

  it('blocks every item when the Notification write is denied, keeping the payload visible', () => {
    const reason = 'notification writes denied';
    const plan = buildPlan([source, dest], settings(), context({ alerting: blocked(reason) }));
    for (const item of plan) {
      assert.equal(item.blocked, reason);
      assert.ok(item.write, 'the exact object is still shown, so the admin sees what is gated');
    }
  });

  it('produces one item per feed, with distinct keys', () => {
    const plan = buildPlan([source, dest], settings(), context());
    assert.equal(new Set(plan.map((item) => item.key)).size, 2);
  });
});

describe('buildPlan with Insights monitors', () => {
  it('plans a monitor plus the notification that routes it, scoped by feed tag', () => {
    const plan = buildPlan([source], settings(asMonitor('source')), context());
    const write = monitorOf(plan[0]);
    assert.equal(plan[0].mechanism, 'monitor');
    assert.equal(plan[0].signal, 'volume');
    assert.equal(write.hostGroup, 'default_search', 'the host group, not the feed’s group');
    assert.equal(write.templateId, 'source_data_in_rate');
    assert.equal(write.monitor.query, inBytes.query, 'copied verbatim, never composed');
    assert.deepEqual(write.monitor.rules[0].includedTags, { input: ['syslog:in_syslog'] });
    assert.equal(write.bridge.id, `monitor-${write.monitor.id}`);
    assert.equal(write.bridge.condition, 'monitor-alerts');
  });

  it('mixes mechanisms per direction in one plan', () => {
    const plan = buildPlan([source, dest], settings(asMonitor('destination')), context());
    assert.equal(notificationOf(plan[0]).condition, 'low-volume');
    assert.equal(monitorOf(plan[1]).templateId, 'destination_data_out_rate');
  });

  it('does not let a denied monitor write block a Notification item in the same run', () => {
    // The two mechanisms fail for separate reasons. Collapsing them would report a
    // creatable Notification as blocked and the admin would never try it.
    const plan = buildPlan(
      [source, dest],
      settings(asMonitor('destination')),
      context({ monitors: blocked('monitor writes denied') }),
    );
    assert.equal(plan[0].blocked, undefined);
    assert.equal(plan[1].blocked, 'monitor writes denied');
    assert.ok(plan[1].write, 'still shown, so the admin sees exactly what is gated');
  });

  it('does not let a denied Notification write block a monitor item', () => {
    // `alerting` reflects whether the *condition catalogue* is readable, which a monitor
    // never consults: its bridge uses the fixed `monitor-alerts` condition.
    const plan = buildPlan(
      [source],
      settings(asMonitor('source')),
      context({ alerting: blocked('notification writes denied') }),
    );
    assert.equal(plan[0].blocked, undefined);
  });

  it('creates nothing when no group hosts a monitor collection', () => {
    const plan = buildPlan(
      [source],
      settings(asMonitor('source')),
      context({ monitorHost: null, monitors: blocked('no monitor collection answered') }),
    );
    assert.equal(plan[0].write, null);
    assert.match(plan[0].blocked ?? '', /no monitor collection answered/);
  });

  it('creates nothing when the direction has no shipped query to copy', () => {
    const plan = buildPlan(
      [source],
      settings(asMonitor('source')),
      context({ monitorTemplates: noTemplates }),
    );
    assert.equal(plan[0].write, null);
    assert.match(plan[0].blocked ?? '', /No monitor shipped on "default_search"/);
  });

  it('names the template that went missing rather than substituting another', () => {
    const plan = buildPlan(
      [source],
      settings({
        ...asMonitor('source'),
        monitorBy: {
          ...DEFAULT_SETTINGS.monitorBy,
          source: { ...DEFAULT_SETTINGS.monitorBy.source, templateId: 'retired_monitor' },
        },
      }),
      context(),
    );
    assert.equal(plan[0].write, null);
    assert.match(plan[0].blocked ?? '', /"retired_monitor"/);
  });

  it('refuses a template whose query would never count as coverage', () => {
    // A monitor on queue depth is a perfectly good monitor, but it does not detect a feed
    // that went quiet — so it would be created and then never counted. Refuse instead.
    const queueDepth = makeMonitor({
      id: 'pq_depth',
      query: 'max(pq_buffered_events{namespace=""}) by (input)',
    });
    const plan = buildPlan(
      [source],
      settings(asMonitor('source')),
      context({ monitorTemplates: { source: [queueDepth], destination: [] } }),
    );
    assert.equal(plan[0].write, null);
    assert.match(plan[0].blocked ?? '', /does not measure throughput/);
  });

  it('carries createDisabled through to both halves of the write', () => {
    const plan = buildPlan(
      [source],
      settings({ ...asMonitor('source'), createDisabled: true }),
      context(),
    );
    const write = monitorOf(plan[0]);
    // Note the inverted sense: monitors carry `enabled`, Notifications carry `disabled`.
    assert.equal(write.monitor.enabled, false);
    assert.equal(write.bridge.disabled, true);
  });
});

describe('a monitor whose feed tag is not unique', () => {
  // `includedTags` pins the tag and only the tag, so an identically typed and named feed in
  // another group is watched by the same monitor. That trade is deliberate — a worker-group
  // tag the deployment may not support would narrow the monitor to nothing — so the cost of
  // it has to reach the admin before they confirm, not after.
  const twin = makeFeed({ id: 'in_syslog', type: 'syslog', group: 'defaultHybrid' });
  const shared = indexFeedIdentities([source, twin, dest]);

  it('warns, naming the other group, and still creates the monitor', () => {
    const plan = buildPlan([source], settings(asMonitor('source')), context({ feedIdentities: shared }));
    assert.ok(plan[0].warning, 'expected a warning about the shared tag');
    assert.match(plan[0].warning ?? '', /syslog:in_syslog/);
    assert.match(plan[0].warning ?? '', /defaultHybrid/);
    assert.match(plan[0].warning ?? '', /2 feeds, not one/);
    // A warning is not a block: the monitor is the honest thing to create here.
    assert.equal(plan[0].blocked, undefined);
    const rule = monitorOf(plan[0]).monitor.rules[0];
    assert.ok(rule, 'expected exactly one rule on the monitor');
    assert.deepEqual(rule.includedTags?.input, ['syslog:in_syslog']);
    assert.deepEqual(countPlan(plan), { creatable: 1, blocked: 0, skipped: 0 });
  });

  it('says nothing when the tag is unique, which is the ordinary case', () => {
    const plan = buildPlan([source], settings(asMonitor('source')), context());
    assert.equal(plan[0].warning, undefined);
  });

  it('never warns on a Notification, which is scoped by group and feed id', () => {
    // `conf.name` plus the `group` field pin a Notification to one feed by construction, so
    // the hazard simply does not exist on that mechanism.
    const plan = buildPlan([source], settings(), context({ feedIdentities: shared }));
    assert.equal(plan[0].mechanism, 'notification');
    assert.equal(plan[0].warning, undefined);
  });
});

describe('indexFeedIdentities', () => {
  it('keys on the sanitized feed id, which is the segment a monitor id is built from', () => {
    const sourceFeed = makeFeed({ id: 'shared', type: 'cribl_lake' });
    const destFeed = makeFeed({ id: 'shared', type: 'cribl_lake', direction: 'destination' });
    const index = indexFeedIdentities([sourceFeed, destFeed]);
    assert.deepEqual(index.get('shared'), [
      { direction: 'destination', tag: 'cribl_lake:shared', groups: ['default'] },
      { direction: 'source', tag: 'cribl_lake:shared', groups: ['default'] },
    ]);
  });

  it('deduplicates and sorts groups so the warning reads the same on every render', () => {
    const feeds = [
      makeFeed({ id: 'in_syslog', type: 'syslog', group: 'zulu' }),
      makeFeed({ id: 'in_syslog', type: 'syslog', group: 'alpha' }),
      makeFeed({ id: 'in_syslog', type: 'syslog', group: 'alpha', health: 'Red' }),
    ];
    assert.deepEqual(indexFeedIdentities(feeds).get('in_syslog'), [
      { direction: 'source', tag: 'syslog:in_syslog', groups: ['alpha', 'zulu'] },
    ]);
  });

  it('keys a Pack feed under a Pack-aware segment, so it neither invents nor hides a collision', () => {
    // A Pack feed does get a monitor now, so it has to be in this index — but under the same
    // segment its monitor id uses. Keying on the bare id would report the group feed of that name
    // as a clash and block a real monitor over one that was never in danger.
    const inPack = makeFeed({ id: 'palo_traffic', type: 'datagen', pack: 'cribl-palo-alto-networks' });
    const atGroup = makeFeed({ id: 'palo_traffic', type: 'datagen' });
    const index = indexFeedIdentities([inPack, atGroup]);
    assert.deepEqual(index.get('palo_traffic'), [
      { direction: 'source', tag: 'datagen:palo_traffic', groups: ['default'] },
    ]);
    assert.deepEqual(index.get('cribl-palo-alto-networks_palo_traffic'), [
      {
        direction: 'source',
        tag: 'datagen:cribl-palo-alto-networks.palo_traffic',
        groups: ['default'],
      },
    ]);

    // Neither blocks the other: two buckets, two monitor ids.
    for (const feed of [inPack, atGroup]) {
      const plan = buildPlan([feed], settings(asMonitor('source')), context({ feedIdentities: index }));
      assert.equal(plan[0].blocked, undefined, `expected ${feed.rowId} not to be blocked`);
    }
  });

  it('still catches two Packs whose feeds would produce one monitor id', () => {
    // The reason the Pack has to be *in* the id rather than merely beside it: without it these two
    // are one object, and `upsertMonitor`'s PATCH recovery would point the first Pack's monitor at
    // the second Pack's feed.
    const first = makeFeed({ id: 'traffic', type: 'datagen', pack: 'pack.one' });
    const second = makeFeed({ id: 'one_traffic', type: 'datagen', pack: 'pack' });
    const index = indexFeedIdentities([first, second]);
    assert.equal(index.get('pack_one_traffic')?.length, 2);
    const plan = buildPlan([first], settings(asMonitor('source')), context({ feedIdentities: index }));
    assert.match(plan[0].blocked ?? '', /source_data_in_rate_pack_one_traffic/);
  });

  it('keeps two feeds of the same name but different types apart', () => {
    // Same id segment, different tags — which is exactly the monitor-id collision `plan.ts`
    // refuses, so the index has to keep them as two identities rather than merging them.
    const index = indexFeedIdentities([
      makeFeed({ id: 'app', type: 'syslog' }),
      makeFeed({ id: 'app', type: 'tcp' }),
    ]);
    assert.equal(index.get('app')?.length, 2);
  });
});

describe('a monitor id that two different feeds would share', () => {
  /*
   * A monitor id is `{template}_{feed}` — no worker group, no feed type — because that is what
   * makes it readable on the Insights alerts page. So two different feeds can land on one id.
   * `upsertMonitor` PATCHes on an id-exists rejection, so the second write would retarget the
   * first feed's monitor at the second feed and leave one feed watched by a monitor scoped to
   * the other. That is worse than creating nothing, so nothing is created.
   */
  const sameName = makeFeed({ id: 'in_syslog', type: 'tcp' });

  it('blocks both feeds and names the clash', () => {
    const shared = indexFeedIdentities([source, sameName]);
    const plan = buildPlan([source, sameName], settings(asMonitor('source')), context({ feedIdentities: shared }));
    for (const item of plan) {
      assert.ok(item.blocked, `expected ${item.feedId} to be blocked`);
      assert.match(item.blocked ?? '', /source_data_in_rate_in_syslog/);
      assert.equal(item.write, null, 'a blocked item must carry no payload');
    }
    assert.match(plan[0].blocked ?? '', /tcp:in_syslog/);
    assert.match(plan[1].blocked ?? '', /syslog:in_syslog/);
    assert.deepEqual(countPlan(plan), { creatable: 0, blocked: 2, skipped: 0 });
  });

  it('catches ids that differ only in a character the id sanitizer rewrites', () => {
    // `a.b` and `a_b` both sanitize to `a_b`, so they collide even though nothing about the
    // feeds looks alike.
    const dotted = makeFeed({ id: 'a.b', type: 'syslog' });
    const scored = makeFeed({ id: 'a_b', type: 'syslog' });
    const plan = buildPlan(
      [dotted],
      settings(asMonitor('source')),
      context({ feedIdentities: indexFeedIdentities([dotted, scored]) }),
    );
    assert.match(plan[0].blocked ?? '', /source_data_in_rate_a_b/);
  });

  it('leaves the Notification arm alone, which scopes by group and feed id', () => {
    const shared = indexFeedIdentities([source, sameName]);
    const plan = buildPlan([source], settings(), context({ feedIdentities: shared }));
    assert.equal(plan[0].blocked, undefined);
  });
});

describe('a feed inside a Pack', () => {
  /*
   * Both mechanisms, chosen by the admin exactly as for a group feed. The Pack-qualified metric tag
   * a monitor pins is verified live (2026-09-03): splitting the throughput metrics by `input` and
   * `output` returns `datagen:cribl-palo-alto-networks.palo_traffic` and no bare-id series at all,
   * and `namespace` is not a dimension, so the shipped `{namespace=""}` matcher treats both scopes
   * alike. Scope changes the collection and the ids, never the option set.
   */
  const packSource = makeFeed({ id: 'palo_traffic', type: 'datagen', pack: 'cribl-palo-alto-networks' });

  it('gets whichever mechanism the direction is set to, exactly like a group feed', () => {
    assert.equal(mechanismFor(packSource, settings()), 'notification');
    assert.equal(mechanismFor(packSource, settings(asMonitor('source'))), 'monitor');
    assert.equal(
      mechanismFor(packSource, settings(asMonitor('source'))),
      mechanismFor(source, settings(asMonitor('source'))),
      'scope must not change the mechanism',
    );
  });

  it('carries the Pack on the write, since that is the only thing that picks the collection', () => {
    const plan = buildPlan([packSource], settings(), context());
    assert.equal(plan[0].mechanism, 'notification');
    assert.ok(plan[0].write && plan[0].write.kind === 'notification');
    assert.equal(plan[0].write.pack, 'cribl-palo-alto-networks');
    assert.equal(plan[0].write.group, 'default');
    // The payload itself is byte-identical to a group-level one; the path is the difference.
    assert.equal(plan[0].write.notification.conf.name, 'palo_traffic');
    assert.match(plan[0].label, /inside Pack "cribl-palo-alto-networks"/);
  });

  it('pins the monitor to the Pack-qualified tag, which is the only form the metrics carry', () => {
    const plan = buildPlan([packSource], settings(asMonitor('source')), context());
    assert.equal(plan[0].blocked, undefined);
    assert.ok(plan[0].write && plan[0].write.kind === 'monitor');
    assert.deepEqual(plan[0].write.monitor.rules[0].includedTags, {
      input: ['datagen:cribl-palo-alto-networks.palo_traffic'],
    });
  });

  it('puts the Pack in the monitor id, so two Packs are two objects', () => {
    const plan = buildPlan([packSource], settings(asMonitor('source')), context());
    assert.ok(plan[0].write && plan[0].write.kind === 'monitor');
    assert.equal(
      plan[0].write.monitor.id,
      'source_data_in_rate_cribl-palo-alto-networks_palo_traffic',
    );
    // A group feed's id is untouched, so every monitor already written keeps resolving.
    const atGroup = buildPlan([source], settings(asMonitor('source')), context());
    assert.ok(atGroup[0].write && atGroup[0].write.kind === 'monitor');
    assert.equal(atGroup[0].write.monitor.id, 'source_data_in_rate_in_syslog');
  });

  it('is still gated on the Notification write being permitted', () => {
    const plan = buildPlan([packSource], settings(), context({ alerting: blocked('denied') }));
    assert.equal(plan[0].blocked, 'denied');
  });

  it('is gated on the monitor capability once it is asking for a monitor', () => {
    // The flip side of getting the choice: a Pack feed set to `monitor` now fails with the monitor
    // mechanism instead of quietly falling back to a Notification the admin did not pick.
    const plan = buildPlan(
      [packSource],
      settings(asMonitor('source')),
      context({ monitors: blocked('no monitor collection answered'), monitorHost: null }),
    );
    assert.match(plan[0].blocked ?? '', /no monitor collection answered/);
    assert.equal(plan[0].write, null);

    // Set to `notification`, the same feed is unaffected by that denial.
    const asNotification = buildPlan(
      [packSource],
      settings(),
      context({ monitors: blocked('no monitor collection answered'), monitorHost: null }),
    );
    assert.equal(asNotification[0].blocked, undefined);
    assert.ok(asNotification[0].write);
  });
});

describe('countPlan', () => {
  it('counts each item exactly once, skipped taking precedence over blocked', () => {
    const item = {
      rowId: 'r',
      feedId: 'f',
      group: 'g',
      direction: 'source' as const,
      mechanism: 'notification' as const,
      signal: 'volume' as const,
      label: '',
      write: null,
    };
    const counts = countPlan([
      { ...item, key: 'a' },
      { ...item, key: 'b', blocked: 'x' },
      { ...item, key: 'c', skipped: 'y', blocked: 'x' },
    ]);
    assert.deepEqual(counts, { creatable: 1, blocked: 1, skipped: 1 });
  });
});
