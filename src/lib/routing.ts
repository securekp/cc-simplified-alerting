/**
 * Where an alert is delivered — the admin's choice, expressed as the platform's own fields.
 *
 * Cribl offers two routes and this app offers exactly those two, because `Notification.mode` is
 * `enum: ["direct", "policy"]` and its `oneOf` makes them mutually exclusive:
 *
 * - **policy** — `mode: "policy"`, no targets, no pairs. The alert names nothing; a notification
 *   policy matches it and decides where it goes. This is what Cribl's own Insights UI posts when
 *   it first creates a monitor bridge.
 * - **targets** — the alert names notification targets directly, optionally with a template per
 *   target so the message is rendered for that target's type.
 *
 * **Both shapes are now observed on the wire, and the second one is observed as a repair.** A HAR
 * capture of this org's own Insights UI (2026-09-02) shows an admin creating a bridge as
 * `mode: "policy"` on a deployment with **zero** policies — so it delivered nothing — and then
 * changing it to:
 *
 * ```json
 * {"id":"monitor-search_errors","condition":"monitor-alerts","mode":"direct","disabled":false,
 *  "targets":[],"templateTargetPairs":[{"targetId":"system_email","templateId":"default-email"}],
 *  "conf":{}}
 * ```
 *
 * → 200. Note `targets: []`: a target that has a template is named **only** inside its pair, not
 * in both places. That is the rule below, and it is why this file changed — the app used to list
 * a templated target twice, a shape Cribl has never been seen to send.
 *
 * Three rules:
 *
 * 1. **Policy mode is byte-for-byte the observed create.** `mode`, empty `targets`, empty
 *    `templateTargetPairs` — not a re-derivation of it.
 * 2. **A templated target lives in its pair and nowhere else.** Every target templated →
 *    `targets: []`, exactly the captured repair. None templated → no `mode` at all and a bare
 *    `targets: [...]`, the shape every condition notification this app has created was stored
 *    with, which the third `oneOf` branch allows and which `mode: "direct"` would violate
 *    (`templateTargetPairs` has `minItems: 1` on that branch). A mixed selection splits: pairs for
 *    the templated, `targets` for the rest.
 * 3. **A recipient is not a routing field.** `default-email` renders `"to": "{{metadata.to}}"`,
 *    and the same capture shows the recipient arriving on the *monitor* as `params.to`, not on the
 *    notification. It is carried here because it is part of the one delivery choice, and applied
 *    in `buildMonitor`. See `RoutingSettings.recipient`.
 *
 * Nothing here creates a policy, a target, or a template. All three are read-only inputs.
 */

import type { NotificationTarget } from '../api/alerts.ts';
import type { NotificationTemplate } from '../api/routing.ts';

export type RoutingMode = 'policy' | 'targets';

export interface RoutingSettings {
  mode: RoutingMode;
  /** Target ids, in the order chosen. Only used in `targets` mode. */
  targets: string[];
  /** Template id per target id. A target with no entry is delivered untemplated. */
  templateByTarget: Record<string, string>;
  /**
   * The address an email-templated alert is sent to. Empty string when none was given.
   *
   * This is not a field of a Notification. The shipped `default-email` template renders
   * `"to": "{{metadata.to}}"`, the `system_email` target carries no address of its own, and the
   * capture shows Cribl's own UI writing the address onto the **monitor** as `params.to` —
   * `{"to":"kprior@cribl.io","unit":"none"}`, the one field that changed between the two HARs and
   * present on none of the other 40 monitors. So it belongs to the delivery choice but is applied
   * by `buildMonitor`. A condition Notification has no `params`, which is a real limit and is
   * said in the drawer rather than papered over.
   */
  recipient: string;
}

/** One entry of `Notification.templateTargetPairs`. Both fields are required by the schema. */
export interface TemplateTargetPair {
  templateId: string;
  targetId: string;
}

/**
 * The routing fields of a Notification payload.
 *
 * `mode` and `templateTargetPairs` are optional because omitting them is a *distinct*, valid
 * state — see rule 2 above — not a default worth filling in.
 */
export interface RoutingFields {
  targets: string[];
  mode?: 'policy' | 'direct';
  templateTargetPairs?: TemplateTargetPair[];
}

/**
 * Policy, because it is the route the platform itself takes when it creates a monitor bridge.
 *
 * This is the default only where a policy could carry the alert. On a deployment with **zero**
 * policies it is the route that provably delivers nothing, so `coerceRouting` opens on `targets`
 * instead — see the `mode` fallback there. That is not the app deciding delivery: no target is
 * ever preselected, so the admin still has to name one, and the drawer says why it moved.
 */
export const DEFAULT_ROUTING: RoutingSettings = {
  mode: 'policy',
  targets: [],
  templateByTarget: {},
  recipient: '',
};

/**
 * Templates that can be paired with this target.
 *
 * Matched on `type`, because that is what a pair means: `default-email` renders `smtp`. A
 * template whose type could not be read is offered anyway — an unreadable field is not evidence
 * of a mismatch, and hiding a template the admin can see in Cribl would be the worse error.
 *
 * A target with no matching template is normal, not broken: the verification org's
 * `system_notifications` target is type `bulletin_message` and no template ships for it. That
 * is why a template is optional per target rather than required.
 */
export function templatesForTarget(
  target: NotificationTarget,
  templates: readonly NotificationTemplate[],
): NotificationTemplate[] {
  return templates.filter(
    (template) => template.type === target.type || template.type === 'unknown',
  );
}

/**
 * Build the routing fields for one write.
 *
 * Pure and shared by both objects this app creates — a condition Notification and a monitor's
 * bridge Notification — because they are the same kind of object and routing is the admin's
 * one choice, not a per-mechanism constant.
 */
export function buildRouting(routing: RoutingSettings): RoutingFields {
  if (routing.mode === 'policy') {
    // Copied field for field from the capture. A policy-routed notification names nothing.
    return { targets: [], mode: 'policy', templateTargetPairs: [] };
  }

  const pairs: TemplateTargetPair[] = [];
  const untemplated: string[] = [];
  for (const targetId of routing.targets) {
    const templateId = routing.templateByTarget[targetId];
    // A templated target goes in its pair and **nowhere else**. Cribl's own repair posts
    // `targets: []` alongside one pair; listing the same target in both places is a shape the
    // platform has never been seen to send, and it invites either a duplicate delivery or a
    // silently ignored field. Neither is something to guess at when the alternative is copying
    // what worked.
    if (templateId) pairs.push({ templateId, targetId });
    else untemplated.push(targetId);
  }

  // No pair, no `mode`: the bare `targets: [...]` shape every alert this app has created so far
  // was stored with. Sending `mode: "direct"` here would violate the schema's own `minItems: 1`.
  return pairs.length > 0
    ? { targets: untemplated, mode: 'direct', templateTargetPairs: pairs }
    : { targets: untemplated };
}

/**
 * The selected targets that need an address supplied for them, i.e. the `smtp` ones.
 *
 * `system_email` on the verification org has no `to` of its own and its shipped template renders
 * `{{metadata.to}}`, so an email route with no recipient is an alert that renders an empty
 * address. The target's `type` is the only thing that distinguishes it, which is why this asks
 * the live target list rather than pattern-matching an id.
 */
export function recipientTargets(
  routing: RoutingSettings,
  targets: readonly NotificationTarget[],
): NotificationTarget[] {
  if (routing.mode !== 'targets') return [];
  return targets.filter(
    (target) => routing.targets.includes(target.id) && target.type === 'smtp',
  );
}

/**
 * Read routing settings back out of the KV store, validated against what exists now.
 *
 * Field by field, like `coerceMonitorSettings`: these values were written by an earlier run of
 * this app and are inputs to a write payload, so a target that has since been deleted or a
 * template that no longer matches its target's type must fall out rather than be sent.
 *
 * The `mode` fallback carries two things. First the one migration this needs: builds before this
 * choice existed stored only `notificationTargets`, so a stored target list with no stored mode
 * *is* a recorded decision to route by target, and restoring it as policy would silently move the
 * admin's alerts off the targets they picked. Second, with nothing stored at all, a deployment
 * whose policy count is **zero** opens on `targets` rather than on policy — policy there is the
 * one route known to deliver nothing, and four alerts were created that way on the verification
 * org before this existed. `null` (unreadable) is not zero and keeps the policy default.
 */
export function coerceRouting(
  stored: {
    routingMode?: unknown;
    notificationTargets?: unknown;
    notificationTemplateByTarget?: unknown;
    notificationRecipient?: unknown;
  } | null | undefined,
  live: {
    targets: readonly NotificationTarget[];
    templates: readonly NotificationTemplate[];
    /** How many notification policies exist, or `null` when that could not be read. */
    policyCount?: number | null;
  },
): RoutingSettings {
  const targetsById = new Map(live.targets.map((target) => [target.id, target] as const));
  const rawTargets = Array.isArray(stored?.notificationTargets) ? stored.notificationTargets : [];
  const targets: string[] = [];
  for (const entry of rawTargets) {
    if (typeof entry === 'string' && targetsById.has(entry) && !targets.includes(entry)) {
      targets.push(entry);
    }
  }

  const templateByTarget: Record<string, string> = {};
  const rawPairs =
    stored?.notificationTemplateByTarget && typeof stored.notificationTemplateByTarget === 'object'
      ? (stored.notificationTemplateByTarget as Record<string, unknown>)
      : {};
  for (const targetId of targets) {
    const templateId = rawPairs[targetId];
    if (typeof templateId !== 'string') continue;
    const target = targetsById.get(targetId);
    if (!target) continue;
    const usable = templatesForTarget(target, live.templates).some(
      (template) => template.id === templateId,
    );
    if (usable) templateByTarget[targetId] = templateId;
  }

  const mode: RoutingMode =
    stored?.routingMode === 'policy' || stored?.routingMode === 'targets'
      ? stored.routingMode
      : targets.length > 0 || live.policyCount === 0
        ? 'targets'
        : DEFAULT_ROUTING.mode;

  const recipient =
    typeof stored?.notificationRecipient === 'string'
      ? stored.notificationRecipient.trim()
      : DEFAULT_ROUTING.recipient;

  return { mode, targets, templateByTarget, recipient };
}

/**
 * The one thing a stored routing choice cannot tell you on its own: it routes by policy, and
 * there are no policies.
 *
 * `describeRouting` answers `delivers: null` for policy mode and is right to — *which* policy
 * matches an alert lives in an object this app deliberately does not read. But a **count** of zero
 * is not a matching question, it is a fact, and it was the fact on the verification org while four
 * app-created alerts routed by policy: each one fired on the Insights alerts page and delivered
 * nothing. So the count is combined with the stored object here, and only here.
 *
 * `null` unless both halves hold. An unreadable count (`null`) is not zero.
 */
export function policyGap(stored: unknown, policyCount: number | null): string | null {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as { mode?: unknown };
  if (raw.mode !== 'policy' || policyCount !== 0) return null;
  return (
    'This alert routes by notification policy and this deployment has none, so it fires and is ' +
    'recorded but nothing is delivered. Create a policy in Cribl — this app never does — or ' +
    'change this alert to name a notification target.'
  );
}

export interface RoutingDescription {
  /** One sentence, for the configuration view. */
  summary: string;
  /**
   * Does this alert reach anyone?
   *
   * `null` for policy mode, and that is the honest answer: it depends on whether a policy
   * matches this alert, which lives in an object this app deliberately does not inspect.
   * The UI says "depends on a policy" rather than claiming either way.
   */
  delivers: boolean | null;
}

/**
 * Describe the routing of a **stored** notification object, as Cribl returned it.
 *
 * Read from the object rather than from the template that produced it, for the same reason the
 * whole configuration view is: the admin may have changed it in Cribl afterwards, and a screen
 * that answers "what is really there" cannot answer it from what this app once sent.
 */
export function describeRouting(stored: unknown): RoutingDescription {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as {
    mode?: unknown;
    targets?: unknown;
    templateTargetPairs?: unknown;
  };
  const targets = Array.isArray(raw.targets)
    ? raw.targets.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const pairs = Array.isArray(raw.templateTargetPairs) ? raw.templateTargetPairs : [];
  // A templated target is named only inside its pair — Cribl's own `mode: "direct"` object has
  // `targets: []` and one pair. Reading delivery off `targets` alone reported the working alert
  // in the capture as "nothing is sent", which is the worst direction for this screen to be
  // wrong in: it invites an admin to re-fix an alert that was already fixed.
  const pairTargets = pairs.flatMap((pair) => {
    const entry = (pair && typeof pair === 'object' ? pair : {}) as { targetId?: unknown };
    return typeof entry.targetId === 'string' ? [entry.targetId] : [];
  });

  if (raw.mode === 'policy') {
    return {
      summary:
        'through Cribl’s notification policies — this alert names no target, so a policy decides ' +
        'where it goes. This app does not create or read policies, so whether one covers this ' +
        'alert has to be checked in Cribl.',
      delivers: null,
    };
  }

  if (targets.length === 0 && pairTargets.length === 0) {
    return {
      summary: 'nowhere — this alert fires and is recorded, but nothing is sent',
      delivers: false,
    };
  }

  const templated = pairs.flatMap((pair) => {
    if (!pair || typeof pair !== 'object') return [];
    const entry = pair as { templateId?: unknown; targetId?: unknown };
    return typeof entry.targetId === 'string' && typeof entry.templateId === 'string'
      ? [`${entry.targetId} using “${entry.templateId}”`]
      : [];
  });

  // Anything in `targets` that no pair already accounts for. Ordinarily that is the whole of
  // `targets` (a pair's target is not listed there) but an object written by another tool, or by
  // an older build of this app, can name a target in both places.
  const bare = targets.filter((id) => !pairTargets.includes(id));

  return {
    summary:
      templated.length > 0
        ? `to ${templated.join(', ')}${
            bare.length > 0 ? ` (and ${bare.join(', ')} with no template)` : ''
          }`
        : `to ${bare.join(', ')}, each rendered with that target’s own default`,
    delivers: true,
  };
}
