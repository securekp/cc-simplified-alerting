/**
 * Insights monitors: choosing a query to copy, building the two objects, finding the group
 * that hosts them, and reading one back into coverage.
 *
 * The recurring risk in this mechanism is a monitor that exists and cannot fire — wrong
 * group, wrong tag, threshold switched off, no routing. Every test here is about refusing
 * or reporting one of those rather than creating it and calling it coverage.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { discoverMonitorHost, type Monitor } from '../src/api/monitors.ts';
import { attributeMonitors, bridgedMonitorId, classifyMonitorQuery, type RawNotification } from '../src/lib/attribution.ts';
import {
  APP_MONITOR_MARK,
  bridgeNotificationId,
  buildBridgeNotification,
  buildMonitor,
  defaultMonitorOptions,
  feedTag,
  isAppMonitorDescription,
  monitorId,
  tagLabelFor,
  templateCandidates,
} from '../src/lib/monitorPayload.ts';
import { DEFAULT_ROUTING } from '../src/lib/routing.ts';
import { coerceMechanism, coerceMonitorSettings, DEFAULT_MONITOR_SETTINGS } from '../src/lib/plan.ts';
import type { ManagedRecord } from '../src/lib/types.ts';
import { makeFeed, makeMonitor } from './fixtures.ts';

const source = makeFeed({ id: 'ZscalerWeb', type: 'datagen' });
const dest = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination' });

const inBytes = makeMonitor({ id: 'source_data_in_rate' });
const inEvents = makeMonitor({
  id: 'source_events_in_rate',
  query: 'sum(rate(total_in_events{namespace=""}[5m])) by (input)',
});
const outBytes = makeMonitor({
  id: 'destination_data_out_rate',
  query: 'sum(rate(total_out_bytes{namespace=""}[5m])) by (output)',
});

describe('templateCandidates', () => {
  it('offers only the shipped Stream monitors for the direction, bytes first', () => {
    const candidates = templateCandidates([inEvents, inBytes, outBytes], 'source');
    assert.deepEqual(
      candidates.map((monitor) => monitor.id),
      ['source_data_in_rate', 'source_events_in_rate'],
    );
    assert.deepEqual(
      templateCandidates([inEvents, inBytes, outBytes], 'destination').map((m) => m.id),
      ['destination_data_out_rate'],
    );
  });

  it('will not copy a query from a monitor somebody else authored or edited', () => {
    // An admin's own monitor may be scoped or filtered in ways this app cannot see, and a
    // copy would silently inherit that scope.
    const custom = makeMonitor({ id: 'my_own_in_bytes', isDefault: false });
    assert.deepEqual(templateCandidates([custom], 'source'), []);
  });

  it('does not mistake a non-throughput monitor for a throughput one', () => {
    const queue = makeMonitor({ id: 'pq', query: 'max(pq_buffered_events{namespace=""}) by (input)' });
    const search = makeMonitor({ id: 'searches', query: 'sum(rate(search_in_bytes[5m]))', product: 'search' });
    assert.deepEqual(templateCandidates([queue, search], 'source'), []);
  });
});

describe('buildMonitor', () => {
  const monitor = buildMonitor(source, {
    ...defaultMonitorOptions(inBytes),
    threshold: 5,
    firingAfter: 600,
  });

  it('copies the query verbatim rather than composing PromQL', () => {
    // Hand-authored PromQL that matched no series would produce a monitor that silently
    // never fires, which is worse than no monitor at all.
    assert.equal(monitor.query, inBytes.query);
  });

  it('scopes the monitor to the feed through includedTags, using the type:id form', () => {
    assert.deepEqual(monitor.rules[0].includedTags, { input: ['datagen:ZscalerWeb'] });
    assert.deepEqual(monitor.rules[0].excludedTags, {});
  });

  it('writes exactly one enabled threshold, so it can actually fire', () => {
    // Every monitor Cribl ships stacks three severities with `enabled: false` on each. One
    // enabled condition is the difference between coverage and decoration.
    assert.equal(monitor.rules.length, 1);
    assert.deepEqual(monitor.rules[0].conditions, [
      {
        condition: { type: 'less_than', threshold: 5 },
        enabled: true,
        labels: { severity: 'critical' },
      },
    ]);
    assert.equal(monitor.enabled, true);
  });

  it('never claims to be one of Cribl’s defaults', () => {
    assert.equal(monitor.isDefault, false);
  });

  it('carries the timing the template asked for', () => {
    assert.equal(monitor.firing_after, 600);
    assert.equal(monitor.ok_after, 60);
    assert.equal(monitor.schedule_interval_seconds, 60);
  });

  it('names a monitor after the metric it copies and the feed it watches', () => {
    // What the admin asked for, and what the Insights edit URL ends in:
    // /insights/alerts/monitors/edit/source_data_in_rate_ZscalerWeb
    assert.equal(monitorId(source, inBytes), 'source_data_in_rate_ZscalerWeb');
    assert.equal(monitor.id, 'source_data_in_rate_ZscalerWeb');
    assert.equal(monitor.name, monitor.id, 'the list row and the URL should read alike');
    assert.ok(monitorId(makeFeed({ id: 'x'.repeat(200), type: 'datagen' }), inBytes).length <= 100);
  });

  it('marks the description so an app-created monitor is still recognisable without the registry', () => {
    // The id does not carry the reserved prefix, so this marker is the only evidence of authorship
    // left when a registry write fails — and without it the config view would tell an admin that an
    // alert they just watched the app create was not created by the app.
    assert.ok(isAppMonitorDescription(monitor.description));
    assert.ok(!isAppMonitorDescription('Watches something else.'));
    assert.ok(!isAppMonitorDescription(undefined));
  });

  it('still recognises the mark written under the app’s previous name', () => {
    // The app was renamed; the monitors it already created were not. For a monitor the mark is
    // the only authorship evidence there is, so dropping the old sentence would make every
    // pre-rename monitor report as "not created by this app".
    assert.ok(
      isAppMonitorDescription(
        'Created by the Ally Monitoring app. Watches the source "ZscalerWeb" in worker group "default".',
      ),
    );
  });

  it('records the worker group in the description, since the id no longer separates groups', () => {
    // Two groups holding a feed of the same name share one monitor id. `plan.ts` refuses the
    // clashing case; the description is what tells an admin which feed this one was built for.
    assert.match(monitor.description ?? '', /worker group "default"/);
  });

  it('uses the output label for a destination', () => {
    const built = buildMonitor(dest, defaultMonitorOptions(outBytes));
    assert.deepEqual(built.rules[0].includedTags, { output: ['splunk:out_splunk'] });
    assert.equal(feedTag(dest), 'splunk:out_splunk');
  });

  it('prefers the tag label the template itself uses', () => {
    // A deployment that names the dimension differently still works, because the template's
    // own tag keys win over this app's default.
    const odd = makeMonitor({
      id: 'odd',
      rules: [{ conditions: [], includedTags: { output: ['splunk:a'] } }],
    });
    assert.equal(tagLabelFor('source', odd), 'output');
    assert.equal(tagLabelFor('source'), 'input');
    assert.equal(tagLabelFor('destination'), 'output');
  });
});

describe('buildBridgeNotification', () => {
  it('matches Cribl’s own convention field for field in policy mode', () => {
    const bridge = buildBridgeNotification('ally-default-in_syslog', false, DEFAULT_ROUTING);
    assert.deepEqual(bridge, {
      id: 'monitor-ally-default-in_syslog',
      condition: 'monitor-alerts',
      mode: 'policy',
      disabled: false,
      // Empty on purpose: this is the shape Cribl's own Insights UI posts, and a
      // policy-routed notification names nothing.
      targets: [],
      templateTargetPairs: [],
      conf: {},
    });
    assert.equal(bridgeNotificationId('x'), 'monitor-x');
  });

  it('carries the admin’s target choice when they route by target instead', () => {
    // The bridge is a Notification like any other, so the routing choice reaches it. Without
    // this a deployment with no policy could only create monitors that deliver nowhere.
    const bridge = buildBridgeNotification('m', false, {
      mode: 'targets',
      targets: ['system_notifications'],
      templateByTarget: {},
      recipient: '',
    });
    assert.deepEqual(bridge.targets, ['system_notifications']);
    assert.equal(bridge.mode, undefined);
    assert.equal(bridge.templateTargetPairs, undefined);
  });

  it('reproduces the bridge Cribl’s own UI wrote to repair a policy-routed monitor', () => {
    // Byte for byte from the capture: this is the object that made a monitor on a policy-less
    // deployment actually deliver, and it is what the app now writes for the same choice.
    assert.deepEqual(
      buildBridgeNotification('search_errors', false, {
        mode: 'targets',
        targets: ['system_email'],
        templateByTarget: { system_email: 'default-email' },
        recipient: 'someone@example.com',
      }),
      {
        id: 'monitor-search_errors',
        condition: 'monitor-alerts',
        mode: 'direct',
        disabled: false,
        targets: [],
        templateTargetPairs: [{ targetId: 'system_email', templateId: 'default-email' }],
        conf: {},
      },
    );
  });

  it('disables the bridge alongside a monitor created for a dry run', () => {
    assert.equal(buildBridgeNotification('m', true, DEFAULT_ROUTING).disabled, true);
  });
});

describe('the email recipient, which lives on the monitor', () => {
  it('writes it to params.to, alongside the unit copied from the template', () => {
    // `default-email` renders `"to": "{{metadata.to}}"` and `system_email` holds no address, so
    // this field is the difference between an email that arrives and one that goes to nobody.
    // Cribl's own UI wrote `params: {"to": "…", "unit": "none"}` for exactly this reason.
    const built = buildMonitor(source, {
      ...defaultMonitorOptions(inBytes),
      recipient: 'someone@example.com',
    });
    assert.deepEqual(built.params, { ...inBytes.params, to: 'someone@example.com' });
  });

  it('leaves the shipped params untouched when no recipient was given', () => {
    const built = buildMonitor(source, { ...defaultMonitorOptions(inBytes), recipient: '' });
    assert.deepEqual(built.params, inBytes.params);
    assert.equal('to' in (built.params ?? {}), false);
  });
});

describe('classifyMonitorQuery', () => {
  it('counts only a throughput query as watching for a delivery stop', () => {
    assert.equal(classifyMonitorQuery(inBytes.query), 'volume');
    assert.equal(classifyMonitorQuery(outBytes.query), 'volume');
    assert.equal(classifyMonitorQuery('avg(health_inputs) by (input)'), 'health');
    // Real monitors, but neither detects a feed that went quiet.
    assert.equal(classifyMonitorQuery('max(pq_buffered_events) by (input)'), 'unclassified');
    assert.equal(classifyMonitorQuery('sum(blocked_outputs) by (output)'), 'unclassified');
  });
});

describe('bridgedMonitorId', () => {
  it('recognises the routing half of a monitor and nothing else', () => {
    assert.equal(bridgedMonitorId({ id: 'monitor-abc', condition: 'monitor-alerts' }), 'abc');
    assert.equal(bridgedMonitorId({ id: 'abc', condition: 'monitor-alerts' }), null);
    assert.equal(bridgedMonitorId({ id: 'monitor-abc', condition: 'no-data' }), null);
  });
});

describe('attributeMonitors', () => {
  const feeds = [source, dest];
  const noRegistry = new Map<string, ManagedRecord>();
  const noBridges = new Map<string, RawNotification>();
  const perFeed = (overrides: Partial<Monitor> = {}): Monitor =>
    makeMonitor({
      id: 'ally-default-ZscalerWeb',
      isDefault: false,
      rules: [
        {
          conditions: [{ condition: { type: 'less_than', threshold: 1 }, enabled: true }],
          includedTags: { input: ['datagen:ZscalerWeb'] },
        },
      ],
      ...overrides,
    });

  it('joins a monitor to the feed named in its tags', () => {
    const outcome = attributeMonitors([perFeed()], 'default_search', feeds, noBridges, noRegistry);
    assert.equal(outcome.attributed.length, 1);
    assert.equal(outcome.attributed[0].rowId, source.rowId);
    assert.equal(outcome.attributed[0].mechanism, 'monitor');
    assert.equal(outcome.attributed[0].signal, 'volume');
    assert.equal(outcome.attributed[0].hostGroup, 'default_search');
    assert.equal(outcome.attributed[0].group, source.group, 'the feed’s group, not the host');
  });

  it('reports a monitor with no routing as unrouted rather than as delivered coverage', () => {
    const unrouted = attributeMonitors([perFeed()], 'default_search', feeds, noBridges, noRegistry);
    assert.equal(unrouted.attributed[0].routed, false);

    const bridges = new Map<string, RawNotification>([
      ['ally-default-ZscalerWeb', { id: 'monitor-ally-default-ZscalerWeb', condition: 'monitor-alerts' }],
    ]);
    const routed = attributeMonitors([perFeed()], 'default_search', feeds, bridges, noRegistry);
    assert.equal(routed.attributed[0].routed, true);

    // A disabled bridge routes nowhere either.
    const off = new Map<string, RawNotification>([
      ['ally-default-ZscalerWeb', { id: 'monitor-x', condition: 'monitor-alerts', disabled: true }],
    ]);
    assert.equal(attributeMonitors([perFeed()], 'd', feeds, off, noRegistry).attributed[0].routed, false);
  });

  it('treats a monitor whose thresholds are all switched off as disabled', () => {
    // The shipped monitors are exactly this shape: `enabled: true` on the object, `false` on
    // every threshold. Counting one as coverage would mark most feeds watched by nothing.
    const inert = perFeed({
      rules: [
        {
          conditions: [{ condition: { type: 'greater_than', threshold: 1 }, enabled: false }],
          includedTags: { input: ['datagen:ZscalerWeb'] },
        },
      ],
    });
    assert.equal(attributeMonitors([inert], 'd', feeds, noBridges, noRegistry).attributed[0].disabled, true);
    const off = perFeed({ enabled: false });
    assert.equal(attributeMonitors([off], 'd', feeds, noBridges, noRegistry).attributed[0].disabled, true);
  });

  it('skips the monitors Cribl ships instead of listing them against every row', () => {
    const outcome = attributeMonitors([inBytes], 'd', feeds, noBridges, noRegistry);
    assert.deepEqual(outcome.attributed, []);
    assert.deepEqual(outcome.unattributed, []);
  });

  it('reports a deployment-wide monitor as unattributed rather than spreading it over rows', () => {
    const wide = perFeed({ id: 'wide', rules: [{ conditions: [], includedTags: {} }] });
    const outcome = attributeMonitors([wide], 'd', feeds, noBridges, noRegistry);
    assert.deepEqual(outcome.attributed, []);
    assert.match(outcome.unattributed[0].reason, /whole deployment/);
  });

  it('reports a tag matching no enabled feed rather than guessing at one', () => {
    const orphan = perFeed({ rules: [{ conditions: [], includedTags: { input: ['datagen:gone'] } }] });
    const outcome = attributeMonitors([orphan], 'd', feeds, noBridges, noRegistry);
    assert.deepEqual(outcome.attributed, []);
    assert.match(outcome.unattributed[0].reason, /matches no enabled feed/);
  });

  it('matches tags exactly, never by prefix', () => {
    // A feed emits both a parent series and `:suffix` children carrying the same value, so a
    // prefix match would attribute one monitor to two feeds and double-count coverage.
    const child = makeFeed({ id: 'ZscalerWeb:sub', type: 'datagen' });
    const outcome = attributeMonitors([perFeed()], 'd', [source, child], noBridges, noRegistry);
    assert.equal(outcome.attributed.length, 1);
    assert.equal(outcome.attributed[0].rowId, source.rowId);
  });

  it('claims authorship from the registry, and admits when it cannot tell', () => {
    const registry = new Map<string, ManagedRecord>([
      [
        'ally-default-ZscalerWeb',
        {
          id: 'ally-default-ZscalerWeb',
          group: 'default',
          feedId: 'ZscalerWeb',
          direction: 'source',
          signal: 'volume',
          settings: { mechanism: 'monitor' },
          createdAt: 0,
        },
      ],
    ]);
    assert.equal(
      attributeMonitors([perFeed()], 'd', feeds, noBridges, registry).attributed[0].ownership,
      'registry',
    );
    // No registry entry, but the id is in the reserved namespace an earlier build used.
    assert.equal(
      attributeMonitors([perFeed()], 'd', feeds, noBridges, new Map()).attributed[0].ownership,
      'id',
    );
    // No registry entry and a current-form id, which carries no namespace at all: the marker
    // this app writes into the description is what is left, and it has to be enough.
    const current = perFeed({
      id: 'source_data_in_rate_ZscalerWeb',
      description: `${APP_MONITOR_MARK} Watches the source "ZscalerWeb" in worker group "default".`,
    });
    assert.equal(
      attributeMonitors([current], 'd', feeds, noBridges, new Map()).attributed[0].ownership,
      'id',
    );
    // Same id shape, somebody else's monitor: no marker, so no claim.
    assert.equal(
      attributeMonitors(
        [perFeed({ id: 'source_data_in_rate_ZscalerWeb', description: 'mine, thanks' })],
        'd',
        feeds,
        noBridges,
        new Map(),
      ).attributed[0].ownership,
      'external',
    );
    // Registry unreadable: never claim, and never deny.
    const outside = perFeed({ id: 'someone-elses-monitor' });
    assert.equal(
      attributeMonitors([outside], 'd', feeds, noBridges, new Map(), false).attributed[0].ownership,
      'unknown',
    );
  });
});

describe('discoverMonitorHost', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  /** Serve a monitor collection per group; anything absent from the map 404s. */
  function installGroups(byGroup: Record<string, Monitor[] | number>) {
    globalThis.window = { CRIBL_API_URL: 'https://cribl.test/api/v1' } as unknown as Window &
      typeof globalThis;
    globalThis.fetch = ((url: string) => {
      const group = decodeURIComponent(new URL(url).pathname.split('/')[4] ?? '');
      const served = byGroup[group];
      if (served === undefined || typeof served === 'number') {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Cannot GET' }), {
            status: typeof served === 'number' ? served : 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
      return Promise.resolve(
        new Response(JSON.stringify({ items: offset === 0 ? served : [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;
  }

  it('prefers the group holding Cribl’s shipped Stream monitors', async () => {
    // The monitor host is not the feed's group: on the verification org the monitors live in
    // `default_search` while the feeds live in `default`. A monitor written where nothing
    // evaluates it is an alert that silently never fires.
    installGroups({ default: [], default_search: [inBytes] });
    const { host, probes } = await discoverMonitorHost(['default', 'default_search']);
    assert.equal(host?.group, 'default_search');
    assert.equal(host?.monitors.length, 1);
    assert.deepEqual(probes.map((probe) => probe.group), ['default']);
    assert.match(probes[0].reason, /another group holds the Stream monitors/);
  });

  it('names the 404 rather than reporting the route as missing everywhere', async () => {
    installGroups({ default_search: [inBytes] });
    const { host, probes } = await discoverMonitorHost(['default', 'default_search']);
    assert.equal(host?.group, 'default_search');
    assert.match(probes[0].reason, /\/m\/default\/alert\/monitors returned 404/);
  });

  it('reports no host at all when nothing answers', async () => {
    installGroups({});
    const { host, probes } = await discoverMonitorHost(['default', 'other']);
    assert.equal(host, null);
    assert.equal(probes.length, 2);
  });

  it('falls back to a group that answers with an empty collection', async () => {
    installGroups({ default: [] });
    const { host } = await discoverMonitorHost(['default']);
    assert.equal(host?.group, 'default');
    assert.deepEqual(host?.monitors, []);
  });

  it('distinguishes a denial from a missing route', async () => {
    installGroups({ default: 403 });
    const { host, probes } = await discoverMonitorHost(['default']);
    assert.equal(host, null);
    assert.doesNotMatch(probes[0].reason, /hosts no monitor collection/);
  });
});

describe('reading the template back out of the KV store', () => {
  it('takes a stored mechanism only when it names one', () => {
    assert.equal(coerceMechanism('monitor'), 'monitor');
    assert.equal(coerceMechanism('notification'), 'notification');
    assert.equal(coerceMechanism('metric-monitor'), null);
    assert.equal(coerceMechanism(undefined), null);
  });

  it('validates monitor settings field by field, falling back per field', () => {
    // The stored template is the one input to a write that this app cannot re-validate
    // against a platform schema, so a value from an older build must not become a threshold
    // nobody chose.
    const settings = coerceMonitorSettings({
      templateId: 'source_data_in_rate',
      conditionType: 'nonsense',
      threshold: 12,
      severity: 'warning',
      firingAfter: -5,
      okAfter: 'soon',
    });
    assert.equal(settings.templateId, 'source_data_in_rate');
    assert.equal(settings.conditionType, DEFAULT_MONITOR_SETTINGS.conditionType);
    assert.equal(settings.threshold, 12);
    assert.equal(settings.severity, 'warning');
    assert.equal(settings.firingAfter, DEFAULT_MONITOR_SETTINGS.firingAfter);
    assert.equal(settings.okAfter, DEFAULT_MONITOR_SETTINGS.okAfter);
  });

  it('returns the defaults for anything that is not an object', () => {
    assert.deepEqual(coerceMonitorSettings(null), DEFAULT_MONITOR_SETTINGS);
    assert.deepEqual(coerceMonitorSettings('{"threshold":1}'), DEFAULT_MONITOR_SETTINGS);
  });

  it('watches for a floor by default, because a stopped feed is an absence', () => {
    assert.equal(DEFAULT_MONITOR_SETTINGS.conditionType, 'less_than');
    assert.equal(DEFAULT_MONITOR_SETTINGS.threshold, 1);
  });
});
