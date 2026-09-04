/**
 * The one write payload. The preview shows exactly this object, so a change here is a
 * change to what the admin confirmed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alertId, buildNotification, isAppAlertId, sanitizeIdPart } from '../src/lib/payloads.ts';
import { DEFAULT_ROUTING, type RoutingSettings } from '../src/lib/routing.ts';
import { makeFeed } from './fixtures.ts';

/** Routing is the admin's choice; these tests are about `conf` and identity, so pin one. */
const toTargets: RoutingSettings = {
  mode: 'targets',
  targets: ['system_notifications'],
  templateByTarget: {},
  recipient: '',
};

const source = makeFeed({ id: 'in_syslog:udp', type: 'syslog' });
const dest = makeFeed({ id: 'out_splunk', type: 'splunk', direction: 'destination' });

describe('sanitizeIdPart', () => {
  it('reduces the characters feed ids allow but object ids do not', () => {
    assert.equal(sanitizeIdPart('in_syslog:udp'), 'in_syslog_udp');
    assert.equal(sanitizeIdPart('pack.feed/one'), 'pack_feed_one');
    assert.equal(sanitizeIdPart(':leading:'), 'leading');
  });
});

describe('alertId', () => {
  it('includes the group, because feed ids repeat across groups', () => {
    const other = makeFeed({ id: 'in_syslog:udp', type: 'syslog', group: 'groupB' });
    assert.notEqual(alertId(source), alertId(other));
  });

  it('stays within a conservative id length', () => {
    const long = makeFeed({ id: 'x'.repeat(200), type: 'syslog' });
    assert.ok(alertId(long).length <= 100);
  });

  it('names the Pack, so a Pack feed and a group feed of one name are two alerts', () => {
    // Without the segment the second write would be an edit of the first, and one of the two
    // feeds would end up watched by an alert scoped to the other.
    const inPack = makeFeed({ id: 'palo_traffic', type: 'datagen', pack: 'cribl-palo-alto-networks' });
    const atGroup = makeFeed({ id: 'palo_traffic', type: 'datagen' });
    assert.notEqual(alertId(inPack), alertId(atGroup));
    assert.equal(alertId(inPack), 'csa-default-cribl-palo-alto-networks-palo_traffic');
  });

  it('spells a group-level id exactly as it always has', () => {
    // The KV registry is keyed on these strings. Re-spelling one would make every alert this
    // app has already created read as unmanaged.
    assert.equal(alertId(dest), 'csa-default-out_splunk');
  });
});

describe('isAppAlertId', () => {
  it('claims the current namespace and the bridge Cribl derives from it', () => {
    assert.ok(isAppAlertId(alertId(source)));
    assert.ok(isAppAlertId('csa-default-in_syslog'));
    assert.ok(isAppAlertId('monitor-csa-default-in_syslog'));
  });

  it('still claims the namespace used before the app was renamed', () => {
    // Alerts created under the old name are still this app's, and the coverage chip reads
    // "(owner unknown)" the moment it stops recognising them.
    assert.ok(isAppAlertId('ally-default-in_syslog'));
    assert.ok(isAppAlertId('ally-thru-default-ZscalerWeb'));
    assert.ok(isAppAlertId('monitor-ally-default-in_syslog'));
  });

  it('never claims an id it did not mint', () => {
    for (const id of ['in_syslog', 'allysomething', 'monitor-event_volume_in_rate', 'csafoo']) {
      assert.ok(!isAppAlertId(id), `${id} must not read as app-created`);
    }
  });
});

describe('buildNotification', () => {
  const payload = buildNotification(dest, {
    conditionId: 'unhealthy-dest',
    conf: { timeWindow: '60s', notifyOnResolution: true },
    routing: toTargets,
    createDisabled: false,
  });

  it('sets conf.name to the feed id, which is what makes it per-feed', () => {
    assert.equal(payload.conf.name, 'out_splunk');
  });

  it('scopes itself with the group field that only Notifications have', () => {
    assert.equal(payload.group, 'default');
  });

  it('uses the inverted disabled sense of the Notification engine', () => {
    assert.equal(payload.disabled, false);
    assert.equal(
      buildNotification(dest, {
        conditionId: 'unhealthy-dest',
        conf: {},
        routing: DEFAULT_ROUTING,
        createDisabled: true,
      }).disabled,
      true,
    );
  });

  it('cannot be overridden into watching a different feed', () => {
    // A template-supplied `name` would otherwise point every alert in a bulk run at one
    // feed. `conf.name` is applied last for exactly that reason.
    const hijacked = buildNotification(dest, {
      conditionId: 'unhealthy-dest',
      conf: { name: 'somebody_elses_feed' },
      routing: DEFAULT_ROUTING,
      createDisabled: false,
    });
    assert.equal(hijacked.conf.name, 'out_splunk');
  });

  it('carries the condition id it was given and never invents one', () => {
    assert.equal(payload.condition, 'unhealthy-dest');
  });

  it('carries whichever route the admin chose, and only its own fields', () => {
    assert.deepEqual(payload.targets, ['system_notifications']);
    assert.equal(payload.mode, undefined);

    const byPolicy = buildNotification(dest, {
      conditionId: 'unhealthy-dest',
      conf: {},
      routing: DEFAULT_ROUTING,
      createDisabled: false,
    });
    assert.equal(byPolicy.mode, 'policy');
    assert.deepEqual(byPolicy.targets, []);
  });

  it('builds the same shape for a Source on a volume condition', () => {
    // The proof that one builder is enough: the two directions differ only in `condition`
    // and `conf`, which is why the app needs one engine rather than two.
    const sourcePayload = buildNotification(source, {
      conditionId: 'no-data',
      conf: { timeWindow: '300s' },
      // The same routing as `payload`, because the key comparison below is about the two
      // directions and routing legitimately changes which keys are present.
      routing: toTargets,
      createDisabled: false,
    });
    assert.equal(sourcePayload.condition, 'no-data');
    assert.equal(sourcePayload.conf.name, 'in_syslog:udp');
    assert.deepEqual(Object.keys(sourcePayload).sort(), Object.keys(payload).sort());
  });
});
