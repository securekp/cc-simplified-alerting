/**
 * Building an Insights monitor for one feed, plus the Notification that routes it.
 *
 * Pure, like `payloads.ts`, so the mandatory preview renders the exact objects that will be
 * written. Two rules govern everything here:
 *
 * 1. **The query is copied, never composed.** Every monitor Cribl ships queries a metric in
 *    a form this app cannot verify from inside the browser (`rate(total_in_bytes{namespace=""}[5m])`
 *    — note the empty-string namespace matcher, and the underscore metric names, which are
 *    *not* the dot-separated names `POST /insights/metrics/query` accepts). Hand-authoring
 *    PromQL here would produce a monitor that evaluates to nothing and therefore never
 *    fires, which is the worst possible outcome for an alerting tool. So the app takes the
 *    query verbatim from a shipped monitor and changes only the scope and the threshold.
 * 2. **Scope goes in `includedTags`, not in the query.** Observed live on
 *    `source_data_in_rate`: `includedTags: {input: ["datagen:ZscalerWeb", …]}`. Those values
 *    are exactly the `type:id` tags this app already builds for the metric join.
 */

import { sanitizeIdPart } from './payloads.ts';
import { buildRouting, type RoutingSettings, type TemplateTargetPair } from './routing.ts';
import type { Monitor, MonitorRule } from '../api/monitors.ts';
import type { Direction, Feed } from './types.ts';

/** The `condition.type` values observed in shipped monitors. */
export type MonitorConditionType = 'less_than' | 'greater_than' | 'equal';

export type Severity = 'critical' | 'warning' | 'info';

/**
 * The metric-dimension label that carries the feed.
 *
 * `input` / `output`, confirmed against the label list of `total_in_events` and against the
 * `includedTags` of a shipped monitor. A template's own tag keys win when it has any, so a
 * deployment that names them differently still works.
 */
export function tagLabelFor(direction: Direction, template?: Monitor): string {
  const fromTemplate = template?.rules
    ?.flatMap((rule) => Object.keys(rule.includedTags ?? {}))
    .find((key) => key === 'input' || key === 'output');
  return fromTemplate ?? (direction === 'source' ? 'input' : 'output');
}

/**
 * The tag value for a feed.
 *
 * Deliberately the very same string the metric join uses, rather than recomposed from `type` and
 * `id` here. They agreed while every feed was group-level and stopped agreeing the moment Pack
 * feeds arrived — a Pack feed's dimension value is `type:pack.id` — and two functions that are
 * supposed to produce the identical tag must not each have their own opinion of it. A tag that
 * matches no series is a monitor that never fires, and nothing about it looks wrong.
 *
 * A Pack feed's Pack-qualified form is verified, not assumed. Read live on 2026-09-03 by splitting
 * the throughput metrics — the family the shipped queries measure — by `input` and by `output`:
 * `datagen:cribl-palo-alto-networks.palo_traffic`, `cribl_lake:observeai.observeai-claudeDesktopLake`
 * and `cribl_search_engine:observeai.observeai-mainSearch` are all present, and **no bare-id series
 * exists for any of them**. That read also retired the one observation that had suggested a Pack
 * feed's tag was ambiguous: `cribl_lake:observeai-claudeDesktopLake` is not in the metric store.
 */
export function feedTag(feed: Feed): string {
  return feed.metricKey;
}

/**
 * Shipped monitors whose query measures this direction's throughput, best first.
 *
 * Bytes before events: a feed whose event count holds steady while its byte volume collapses is
 * exactly the drop-off being watched, and the reverse is much rarer.
 * Only `isDefault` Stream monitors are offered — a monitor somebody else authored may have
 * been scoped or edited in ways this app cannot see, and copying its query would inherit that.
 */
export function templateCandidates(monitors: readonly Monitor[], direction: Direction): Monitor[] {
  const token = direction === 'source' ? 'in' : 'out';
  const matches = monitors.filter(
    (monitor) =>
      monitor.isDefault === true &&
      monitor.product === 'stream' &&
      new RegExp(`(^|[^a-z])${token}_(bytes|events)`).test(monitor.query),
  );
  const score = (monitor: Monitor): number => (/bytes/.test(monitor.query) ? 0 : 1);
  return matches.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
}

/**
 * The monitor's id, which is also what the Insights alerts page shows and what its edit URL
 * ends in: `{shipped monitor id}_{feed id}` — `event_volume_in_rate_ZscalerWeb`.
 *
 * Named after the metric it copies rather than after this app, so a monitor created here reads
 * on that page exactly like the shipped alert it was derived from, and an admin who lands on
 * `/insights/alerts/monitors/edit/event_volume_in_rate_ZscalerWeb` can tell from the id alone
 * what is measured and which feed it watches.
 *
 * The cost of dropping the old `{prefix}-{group}-{feed}` form is that the id no longer proves the
 * app minted it, and the group no longer separates two feeds of the same name. Both are handled
 * rather than accepted: ownership falls back to the description mark below, and an id that two
 * *different* feeds would share is refused in `plan.ts` instead of silently overwriting.
 */
export function monitorId(feed: Feed, template: Monitor): string {
  return monitorIdFor(feed.id, template.id, feed.pack);
}

/**
 * The feed half of a monitor id: the Pack and the feed for a Pack feed, the feed alone otherwise.
 *
 * A Pack segment is emitted **only** for a Pack feed, so every monitor id already written keeps its
 * exact spelling — `event_volume_in_rate_ZscalerWeb` — and the registry entries keyed on those ids
 * keep resolving. It has to be there for a Pack feed, though, for the same reason `alertId` carries
 * one: two Packs can each hold a Source called `palo_traffic`, and a single id would make the second
 * write a silent edit of the first monitor.
 *
 * Exported because `indexFeedIdentities` keys the collision index on exactly this string. Two
 * functions with their own opinion of what a monitor id is made of would leave the check looking
 * for clashes in the wrong bucket.
 */
export function monitorIdFeedPart(feedId: string, pack: string | null = null): string {
  return pack ? `${sanitizeIdPart(pack)}_${sanitizeIdPart(feedId)}` : sanitizeIdPart(feedId);
}

/**
 * The same id from the strings it is actually made of.
 *
 * Separate from `monitorId` so the collision check in `plan.ts` can ask what id *another*
 * feed would produce without inventing a `Feed` object to ask with.
 */
export function monitorIdFor(
  feedId: string,
  templateId: string,
  pack: string | null = null,
): string {
  return `${sanitizeIdPart(templateId)}_${monitorIdFeedPart(feedId, pack)}`.slice(0, 100);
}

/**
 * The sentence every monitor this app writes begins its description with.
 *
 * This is the ownership fallback the reserved id prefix used to be, and it is the same class of
 * evidence: a string this app generated and wrote into the object, not user prose being pattern
 * matched. It matters because the registry is the fragile part of the app — without a fallback,
 * an unwritten registry entry makes the configuration view tell an admin that an alert they
 * watched this app create was not created by this app.
 */
export const APP_MONITOR_MARK = 'Created by the Simplified Alerting app.';

/**
 * Marks written under the app's earlier names, still read as the same evidence.
 *
 * The app was renamed; the monitors it already created still carry the old sentence, and for a
 * monitor the mark is the *only* authorship evidence there is — the id is `{metric}_{feed}` and
 * proves nothing. Dropping the old string would make every monitor created before the rename
 * report as not created by this app.
 */
const LEGACY_MONITOR_MARKS = ['Created by the Ally Monitoring app.'] as const;

/** Did this app write this monitor's description? Display only — never coverage. */
export function isAppMonitorDescription(description: string | undefined): boolean {
  if (typeof description !== 'string') return false;
  return [APP_MONITOR_MARK, ...LEGACY_MONITOR_MARKS].some((mark) => description.startsWith(mark));
}

/** Cribl's own convention for the Notification that routes a monitor's output. */
export function bridgeNotificationId(monitorIdValue: string): string {
  return `monitor-${monitorIdValue}`;
}

export interface MonitorAlertOptions {
  /** The shipped monitor whose query and unit are copied. */
  template: Monitor;
  conditionType: MonitorConditionType;
  threshold: number;
  severity: Severity;
  /** Seconds the condition must hold before firing — the anti-flap window. */
  firingAfter: number;
  okAfter: number;
  scheduleIntervalSeconds: number;
  enabled: boolean;
  /**
   * The address an email-templated alert is delivered to, written to `params.to`.
   *
   * Not a routing field, despite being part of the routing choice: the shipped `default-email`
   * template renders `"to": "{{metadata.to}}"`, the `system_email` target carries no address of
   * its own, and the capture shows Cribl's own UI putting the address on the **monitor** —
   * `params: {"to":"kprior@cribl.io","unit":"none"}` on the one monitor being routed to email,
   * and on none of the other 40. Omitted when empty, so a monitor that is not email-routed keeps
   * the shipped `params` exactly as they were copied.
   */
  recipient?: string;
}

/**
 * Build the monitor for one feed.
 *
 * `rules` carries exactly one rule with exactly one condition. Shipped monitors stack three
 * severities on one rule, but this app creates alerts for one intent — the feed stopped
 * delivering — and a single threshold is the thing an admin can reason about and later tune.
 */
export function buildMonitor(feed: Feed, options: MonitorAlertOptions): Monitor {
  const label = tagLabelFor(feed.direction, options.template);
  const rule: MonitorRule = {
    name: `${feed.id} below threshold`,
    showOnChart: true,
    conditions: [
      {
        condition: { type: options.conditionType, threshold: options.threshold },
        enabled: true,
        labels: { severity: options.severity },
      },
    ],
    // The scope. Only the feed tag is pinned: adding a `__worker_group` tag that this
    // deployment does not support would narrow the monitor to nothing and it would never
    // fire, and a monitor that is silently too broad is far less dangerous than one that is
    // silently dead. Where the same feed id exists in another group, the UI says so.
    includedTags: { [label]: [feedTag(feed)] },
    excludedTags: {},
  };

  return {
    id: monitorId(feed, options.template),
    // Same string as the id, so the row on the Insights alerts page and the URL it links to
    // read alike. The worker group and the prose live in the description instead: the name is
    // what an admin scans a list by, and `{metric}_{feed}` is what they are scanning for.
    name: monitorId(feed, options.template),
    description:
      `${APP_MONITOR_MARK} Watches the ${feed.direction} "${feed.id}"` +
      `${feed.pack ? ` in the Pack "${feed.pack}"` : ''} in worker ` +
      `group "${feed.group}" using the query shipped with "${options.template.id}".`,
    // Verbatim. See rule 1 at the top of this file.
    query: options.template.query,
    enabled: options.enabled,
    product: options.template.product ?? 'stream',
    // Copied from the shipped monitor — `{unit: "bytes"}` — plus the recipient, which is the one
    // param this app ever adds and the only place an email address can be supplied.
    params: {
      ...(options.template.params ?? {}),
      ...(options.recipient ? { to: options.recipient } : {}),
    },
    schedule_interval_seconds: options.scheduleIntervalSeconds,
    firing_after: options.firingAfter,
    ok_after: options.okAfter,
    rules: [rule],
    // Never `true`: that flag marks the monitors Cribl ships, and claiming it would put an
    // app-created object in among the defaults an admin is told not to delete.
    isDefault: false,
  };
}

export interface BridgeNotificationPayload {
  id: string;
  condition: 'monitor-alerts';
  disabled: boolean;
  targets: string[];
  mode?: 'policy' | 'direct';
  templateTargetPairs?: TemplateTargetPair[];
  conf: Record<string, unknown>;
}

/**
 * The Notification that carries a monitor's output into the notification system.
 *
 * Everything except the routing is copied field for field from what Cribl's Insights UI posts:
 * no `group`, no `conf.name`, and the fixed `monitor-alerts` condition.
 *
 * The routing is the admin's, and it is the same choice a condition Notification gets, through
 * the same `buildRouting`. Both routes are observed on this exact object: the Insights UI creates
 * the bridge with `mode: "policy"`, and the capture then shows it being changed to
 * `mode: "direct"` with a `{targetId, templateId}` pair — because the deployment had no policy and
 * the alert was therefore delivering nothing. That repair is what the targets route reproduces,
 * and it is why policy is not treated as the safe answer here.
 */
export function buildBridgeNotification(
  monitorIdValue: string,
  createDisabled: boolean,
  routing: RoutingSettings,
): BridgeNotificationPayload {
  return {
    id: bridgeNotificationId(monitorIdValue),
    condition: 'monitor-alerts',
    ...buildRouting(routing),
    disabled: createDisabled,
    conf: {},
  };
}

/** Defaults for the configure form: a sustained five-minute stop, at critical severity. */
export function defaultMonitorOptions(template: Monitor): MonitorAlertOptions {
  return {
    template,
    // "Stopped delivering" is a floor, not a ceiling — the one place this app inverts the
    // shipped monitors, which all watch for a spike.
    conditionType: 'less_than',
    threshold: 1,
    severity: 'critical',
    firingAfter: template.firing_after ?? 300,
    okAfter: template.ok_after ?? 60,
    scheduleIntervalSeconds: template.schedule_interval_seconds ?? 60,
    enabled: true,
  };
}
