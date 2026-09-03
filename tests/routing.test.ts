/**
 * Where an alert is delivered, now that the admin chooses.
 *
 * The failure mode this guards is an alert that exists and reaches nobody, in either
 * direction: a payload shape the schema rejects (so nothing is created), or a payload the
 * schema accepts that names no destination (so nothing is sent). Both are silent, which is
 * why every branch of `buildRouting` is pinned field for field here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NotificationTarget } from '../src/api/alerts.ts';
import type { NotificationTemplate } from '../src/api/routing.ts';
import {
  DEFAULT_ROUTING,
  buildRouting,
  coerceRouting,
  describeRouting,
  policyGap,
  recipientTargets,
  templatesForTarget,
} from '../src/lib/routing.ts';

// The verification org's own objects: `system_notifications` is `bulletin_message` and no
// template ships for it, which is the case that makes a template optional per target.
const email: NotificationTarget = { id: 'default-email-target', type: 'smtp' };
const bulletin: NotificationTarget = { id: 'system_notifications', type: 'bulletin_message' };
const slack: NotificationTarget = { id: 'team-slack', type: 'slack' };

const templates: NotificationTemplate[] = [
  { id: 'default-email', type: 'smtp' },
  { id: 'default-slack', type: 'slack' },
  { id: 'homegrown', type: 'unknown' },
];

describe('templatesForTarget', () => {
  it('pairs a template with a target of the same type', () => {
    assert.deepEqual(
      templatesForTarget(email, templates).map((template) => template.id),
      ['default-email', 'homegrown'],
    );
  });

  it('offers a template whose type could not be read, rather than hiding it', () => {
    // An unreadable `type` is not evidence of a mismatch, and a template the admin can see
    // in Cribl but not here would look like the app had lost it.
    assert.deepEqual(
      templatesForTarget(bulletin, templates).map((template) => template.id),
      ['homegrown'],
    );
  });
});

describe('buildRouting', () => {
  it('reproduces the captured policy shape field for field', () => {
    // Copied from Cribl's own Insights UI posting a monitor bridge. Sending anything else
    // here would move the only proven write off the shape that was proven.
    assert.deepEqual(buildRouting(DEFAULT_ROUTING), {
      targets: [],
      mode: 'policy',
      templateTargetPairs: [],
    });
  });

  it('reproduces the captured direct shape, target named only in its pair', () => {
    // The repair Cribl's own UI performed on a bridge that was delivering nothing, verbatim:
    // `targets: []` with the target inside the pair. An earlier build of this app listed the
    // target in both places, which is a shape the platform has never been seen to send.
    assert.deepEqual(
      buildRouting({
        mode: 'targets',
        targets: ['system_email'],
        templateByTarget: { system_email: 'default-email' },
        recipient: '',
      }),
      {
        targets: [],
        mode: 'direct',
        templateTargetPairs: [{ templateId: 'default-email', targetId: 'system_email' }],
      },
    );
  });

  it('omits mode entirely for targets with no template', () => {
    // The schema's `direct` branch requires `templateTargetPairs` with `minItems: 1`, so
    // `mode: "direct"` here would be rejected. The bare `targets` shape is the third branch,
    // and byte-for-byte what every alert this app created before the choice existed used.
    assert.deepEqual(
      buildRouting({
        mode: 'targets',
        targets: ['system_notifications'],
        templateByTarget: {},
        recipient: '',
      }),
      { targets: ['system_notifications'] },
    );
  });

  it('splits a mixed selection so no target is named twice', () => {
    const fields = buildRouting({
      mode: 'targets',
      targets: ['default-email-target', 'system_notifications'],
      templateByTarget: { 'default-email-target': 'default-email' },
      recipient: '',
    });
    assert.equal(fields.mode, 'direct');
    assert.deepEqual(fields.targets, ['system_notifications']);
    assert.deepEqual(fields.templateTargetPairs, [
      { templateId: 'default-email', targetId: 'default-email-target' },
    ]);
  });

  it('ignores a template recorded against a target that is no longer selected', () => {
    // Deselecting a target in the drawer prunes its template, but a stale KV entry can still
    // carry one. A pair naming a target the notification does not list is not a pair.
    const fields = buildRouting({
      mode: 'targets',
      targets: ['team-slack'],
      templateByTarget: { 'default-email-target': 'default-email' },
      recipient: '',
    });
    assert.deepEqual(fields, { targets: ['team-slack'] });
  });

  it('never puts the recipient on the notification', () => {
    // It goes on the monitor as `params.to`, which is where Cribl's UI put it and where the
    // shipped email template reads it from. A `to` on a Notification is a field nothing reads.
    const fields = buildRouting({
      mode: 'targets',
      targets: ['default-email-target'],
      templateByTarget: { 'default-email-target': 'default-email' },
      recipient: 'someone@example.com',
    });
    assert.equal(JSON.stringify(fields).includes('someone@example.com'), false);
  });
});

describe('recipientTargets', () => {
  it('names the smtp targets, which are the ones holding no address of their own', () => {
    assert.deepEqual(
      recipientTargets(
        {
          mode: 'targets',
          targets: ['default-email-target', 'system_notifications'],
          templateByTarget: {},
          recipient: '',
        },
        [email, bulletin, slack],
      ).map((target) => target.id),
      ['default-email-target'],
    );
  });

  it('asks for nothing in policy mode, where the app names no target at all', () => {
    assert.deepEqual(
      recipientTargets({ ...DEFAULT_ROUTING, targets: ['default-email-target'] }, [email]),
      [],
    );
  });
});

describe('coerceRouting', () => {
  const live = { targets: [email, bulletin, slack], templates };

  it('restores a saved choice', () => {
    assert.deepEqual(
      coerceRouting(
        {
          routingMode: 'targets',
          notificationTargets: ['default-email-target'],
          notificationTemplateByTarget: { 'default-email-target': 'default-email' },
        },
        live,
      ),
      {
        mode: 'targets',
        targets: ['default-email-target'],
        templateByTarget: { 'default-email-target': 'default-email' },
        recipient: '',
      },
    );
  });

  it('restores the recipient, trimmed', () => {
    assert.equal(
      coerceRouting({ notificationRecipient: '  someone@example.com ' }, live).recipient,
      'someone@example.com',
    );
    assert.equal(coerceRouting({ notificationRecipient: 42 }, live).recipient, '');
  });

  it('drops a target that no longer exists, and its template with it', () => {
    assert.deepEqual(
      coerceRouting(
        {
          routingMode: 'targets',
          notificationTargets: ['deleted-target', 'team-slack'],
          notificationTemplateByTarget: {
            'deleted-target': 'default-email',
            'team-slack': 'default-slack',
          },
        },
        live,
      ),
      {
        mode: 'targets',
        targets: ['team-slack'],
        templateByTarget: { 'team-slack': 'default-slack' },
        recipient: '',
      },
    );
  });

  it('drops a template that does not match its target’s type', () => {
    // An smtp template on a slack target would be accepted by this app and rejected — or
    // worse, rendered wrongly — by Cribl.
    const settings = coerceRouting(
      {
        routingMode: 'targets',
        notificationTargets: ['team-slack'],
        notificationTemplateByTarget: { 'team-slack': 'default-email' },
      },
      live,
    );
    assert.deepEqual(settings.templateByTarget, {});
    assert.deepEqual(settings.targets, ['team-slack']);
  });

  it('reads a pre-choice store as the target routing it actually was', () => {
    // Builds before this feature stored only `notificationTargets`. Restoring that as policy
    // would silently move the admin's alerts off the targets they picked.
    assert.deepEqual(coerceRouting({ notificationTargets: ['team-slack'] }, live), {
      mode: 'targets',
      targets: ['team-slack'],
      templateByTarget: {},
      recipient: '',
    });
  });

  it('falls back to the default for an empty or absent store', () => {
    assert.deepEqual(coerceRouting(undefined, live), DEFAULT_ROUTING);
    assert.deepEqual(coerceRouting({ routingMode: 'nonsense' }, live), DEFAULT_ROUTING);
  });

  it('opens on targets where the deployment has no policy to deliver by', () => {
    // The failure this exists for, observed live: four monitor bridges created `mode: "policy"`
    // on an org whose `/notification-policies` count is 0, all delivering nothing.
    assert.equal(coerceRouting(undefined, { ...live, policyCount: 0 }).mode, 'targets');
    // …and no target is chosen for the admin. Naming one is a delivery decision.
    assert.deepEqual(coerceRouting(undefined, { ...live, policyCount: 0 }).targets, []);
  });

  it('keeps the policy default when the count exists or could not be read', () => {
    assert.equal(coerceRouting(undefined, { ...live, policyCount: 2 }).mode, 'policy');
    assert.equal(coerceRouting(undefined, { ...live, policyCount: null }).mode, 'policy');
  });

  it('lets a stored choice of policy stand even with no policies', () => {
    // Warned about, not overridden: the admin may be about to create the policy in Cribl.
    assert.equal(
      coerceRouting({ routingMode: 'policy' }, { ...live, policyCount: 0 }).mode,
      'policy',
    );
  });
});

describe('policyGap', () => {
  const byPolicy = { mode: 'policy', targets: [], templateTargetPairs: [] };

  it('names the state four app-created alerts were actually left in', () => {
    // Observed live: bridges routing by policy on an org whose policy count is 0.
    assert.match(policyGap(byPolicy, 0) ?? '', /nothing is delivered/);
  });

  it('says nothing when a policy exists, or when the count could not be read', () => {
    assert.equal(policyGap(byPolicy, 1), null);
    // An unreadable count is not zero. Claiming an alert is dead on a failed read would be a
    // worse error than staying quiet: the admin would go and re-fix a working alert.
    assert.equal(policyGap(byPolicy, null), null);
  });

  it('says nothing about an alert that does not route by policy', () => {
    assert.equal(policyGap({ targets: ['system_notifications'] }, 0), null);
    assert.equal(policyGap(undefined, 0), null);
  });
});

describe('describeRouting', () => {
  it('refuses to claim either way for a policy-routed alert', () => {
    const described = describeRouting({ mode: 'policy', targets: [], templateTargetPairs: [] });
    assert.equal(described.delivers, null);
    assert.match(described.summary, /notification policies/);
  });

  it('says plainly when an alert delivers nowhere', () => {
    const described = describeRouting({ targets: [] });
    assert.equal(described.delivers, false);
    assert.match(described.summary, /nothing is sent/);
  });

  it('reads the object Cribl itself wrote as delivering, not as empty', () => {
    // Verbatim from the capture. `targets` is empty because the target is named in its pair, so
    // reading delivery off `targets` alone called a working alert "nothing is sent" — inviting an
    // admin to re-fix an alert that was already fixed.
    const described = describeRouting({
      id: 'monitor-search_errors',
      condition: 'monitor-alerts',
      mode: 'direct',
      disabled: false,
      targets: [],
      templateTargetPairs: [{ targetId: 'system_email', templateId: 'default-email' }],
      conf: {},
    });
    assert.equal(described.delivers, true);
    assert.match(described.summary, /system_email using/);
  });

  it('names the template each target is rendered with', () => {
    const described = describeRouting({
      mode: 'direct',
      targets: [],
      templateTargetPairs: [{ templateId: 'default-email', targetId: 'default-email-target' }],
    });
    assert.equal(described.delivers, true);
    assert.match(described.summary, /default-email-target using/);
    assert.match(described.summary, /default-email/);
  });

  it('reports the untemplated remainder alongside the templated targets', () => {
    const described = describeRouting({
      mode: 'direct',
      targets: ['system_notifications'],
      templateTargetPairs: [{ templateId: 'default-email', targetId: 'default-email-target' }],
    });
    assert.match(described.summary, /system_notifications with no template/);
  });

  it('does not list a target twice when an object names it in both places', () => {
    // What an older build of this app wrote, and what another tool might. The read-back has to
    // describe the object in front of it, not the object this version would have sent.
    const described = describeRouting({
      mode: 'direct',
      targets: ['default-email-target'],
      templateTargetPairs: [{ templateId: 'default-email', targetId: 'default-email-target' }],
    });
    assert.equal(described.summary, 'to default-email-target using “default-email”');
  });

  it('describes untemplated targets without inventing a template', () => {
    const described = describeRouting({ targets: ['system_notifications'] });
    assert.equal(described.delivers, true);
    assert.match(described.summary, /system_notifications/);
    assert.doesNotMatch(described.summary, /using/);
  });

  it('survives a stored object with nothing routing-shaped on it', () => {
    // A monitor with no bridge, or a notification from a version that stored neither field.
    assert.equal(describeRouting(undefined).delivers, false);
    assert.equal(describeRouting({ conf: {} }).delivers, false);
  });
});
