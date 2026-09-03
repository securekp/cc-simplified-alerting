/**
 * Turning a selection plus a template into the exact list of writes that would happen.
 *
 * This is the object the mandatory preview renders, and it is the same object the apply
 * step sends. Keeping it pure means the preview cannot drift from what actually
 * happens — the admin confirms the real thing, not a description of it.
 *
 * There are two mechanisms, chosen per direction, and the plan carries a discriminated
 * union rather than one widened payload. A monitor is **two** objects (the monitor and the
 * Notification that routes it) and a Notification is one, so a single `payload` field would
 * either hide half of a monitor write from the preview or lie about its shape.
 */

import { buildNotification, sanitizeIdPart, type NotificationPayload } from './payloads.ts';
import {
  buildBridgeNotification,
  buildMonitor,
  defaultMonitorOptions,
  feedTag,
  monitorId,
  monitorIdFor,
  type BridgeNotificationPayload,
  type MonitorConditionType,
  type Severity,
} from './monitorPayload.ts';
import { DEFAULT_ROUTING, type RoutingSettings } from './routing.ts';
import { formFields, pruneConf } from './conditionForm.ts';
import { classifyCondition, classifyMonitorQuery } from './attribution.ts';
import { isCovered } from './filters.ts';
import type { Monitor } from '../api/monitors.ts';
import type {
  Capability,
  Direction,
  Feed,
  FeedCoverage,
  Mechanism,
  NotificationCondition,
  Signal,
} from './types.ts';

/**
 * The monitor half of the template.
 *
 * No JSON Schema exists for a monitor — `openapi.json`'s `MonitorConf.rules[]` resolves to a
 * pipeline-function schema — so unlike the Notification `conf`, these fields are named here
 * and their meaning comes from monitors read live, not from a form the platform described.
 */
export interface MonitorSettings {
  /**
   * The shipped monitor whose query is copied. `null` means "the best candidate", resolved
   * at plan time; an id that is no longer in the catalogue is not substituted silently.
   */
  templateId: string | null;
  conditionType: MonitorConditionType;
  threshold: number;
  severity: Severity;
  /** Seconds the condition must hold before firing — the anti-flap window. */
  firingAfter: number;
  okAfter: number;
  scheduleIntervalSeconds: number;
}

export interface TemplateSettings {
  /**
   * Which mechanism creates the alert, per direction.
   *
   * Per direction for the same reason everything else here is: the two directions are served
   * by different objects on both sides — different conditions, and different shipped monitor
   * queries — so a single global choice would be creatable for one direction and blocked for
   * the other with no way to say which.
   */
  mechanismBy: Record<Direction, Mechanism>;
  /**
   * The chosen condition per direction.
   *
   * Asymmetric by construction, because the catalogue is: verified live, Sources offer
   * `no-data` / `low-volume` / `high-volume` and Destinations offer `unhealthy-dest`.
   * `null` means the deployment gave this direction nothing to alert on, and the plan
   * says so rather than substituting something that would not detect a stop.
   */
  conditionBy: Record<Direction, string | null>;
  /** Values for the chosen condition's own `conf` fields, per direction. */
  confBy: Record<Direction, Record<string, unknown>>;
  /** Monitor thresholds per direction, used only where the mechanism is `monitor`. */
  monitorBy: Record<Direction, MonitorSettings>;
  /**
   * How every alert in this run is delivered: by notification policy, or to named targets with
   * an optional template each.
   *
   * Not per direction, unlike everything above it, and not per mechanism either. The asymmetry
   * the rest of this type carries is the platform's — different conditions, different shipped
   * queries — whereas a target and a policy are deployment-wide objects that know nothing about
   * a feed's direction. Splitting this would offer a distinction that does not exist.
   */
  routing: RoutingSettings;
  /** Create in a disabled state, for a dry run in the admin's own environment. */
  createDisabled: boolean;
}

export const DEFAULT_CONF: Record<string, unknown> = {
  // `timeWindow` minimum is 60s per the schema's own `duration.min`. Volume thresholds are
  // left unset deliberately so the admin has to state one rather than inherit a guess.
  timeWindow: '60s',
  notifyOnResolution: true,
};

/**
 * Monitor defaults.
 *
 * `less_than 1` is the one place this app inverts the shipped monitors, which all watch for
 * a spike: "stopped delivering" is a floor. Five minutes of it, because a shorter window on a
 * bursty feed produces an alert nobody trusts.
 */
export const DEFAULT_MONITOR_SETTINGS: MonitorSettings = {
  templateId: null,
  conditionType: 'less_than',
  threshold: 1,
  severity: 'critical',
  firingAfter: 300,
  okAfter: 60,
  scheduleIntervalSeconds: 60,
};

export const DEFAULT_SETTINGS: Omit<TemplateSettings, 'conditionBy'> = {
  // Monitors, because that is the alert an admin recognises: it lands on the Insights alerts
  // page with a chart, a threshold and an Activity trail, and it has an edit screen of its own.
  // This is the *preference* only — `resolveMechanism` is what decides, and it falls back to a
  // Notification wherever a monitor is not usable rather than seeding a drawer of blocked rows.
  mechanismBy: { source: 'monitor', destination: 'monitor' },
  confBy: { source: DEFAULT_CONF, destination: DEFAULT_CONF },
  monitorBy: { source: DEFAULT_MONITOR_SETTINGS, destination: DEFAULT_MONITOR_SETTINGS },
  routing: DEFAULT_ROUTING,
  createDisabled: false,
};

const CONDITION_TYPES: MonitorConditionType[] = ['less_than', 'greater_than', 'equal'];
const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];

/** `'monitor'` / `'notification'` from a stored value, or `null` if it is neither. */
export function coerceMechanism(raw: unknown): Mechanism | null {
  return raw === 'monitor' || raw === 'notification' ? raw : null;
}

/**
 * Which mechanism the drawer opens on for one direction.
 *
 * A monitor is preferred when it is usable, because that is what the admin asked for: an alert
 * that lands on the Insights alerts page with a chart, a threshold and an Activity trail, at
 * `/insights/alerts/monitors/edit/{id}`. A condition Notification appears on that page too but
 * has no chart and no edit screen of its own.
 *
 * A saved choice wins over the preference — the admin chose it — but only while it is still
 * usable. A saved mechanism whose capability has since gone away falls back to the other one
 * rather than seeding a drawer in which every row is blocked.
 */
export function resolveMechanism(
  saved: Mechanism | null,
  usable: { monitor: boolean; notification: boolean },
): Mechanism {
  if (saved && usable[saved]) return saved;
  if (usable.monitor) return 'monitor';
  if (usable.notification) return 'notification';
  // Neither is usable, so nothing will be created whichever this returns. Returning the saved
  // value keeps the drawer showing the admin's own last choice while it explains why.
  return saved ?? 'monitor';
}

/**
 * Read monitor settings back out of the KV store.
 *
 * Field by field, with the current default as the fallback for anything missing or of the
 * wrong shape. A stored template is the one input to a write payload that this app wrote
 * itself and cannot re-validate against a schema, so trusting it wholesale would let a value
 * from an older build (or a hand-edited key) become a threshold nobody chose.
 */
export function coerceMonitorSettings(raw: unknown, fallback = DEFAULT_MONITOR_SETTINGS): MonitorSettings {
  if (!raw || typeof raw !== 'object') return fallback;
  const stored = raw as Record<string, unknown>;
  const positive = (value: unknown, alternative: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : alternative;
  return {
    templateId: typeof stored.templateId === 'string' ? stored.templateId : fallback.templateId,
    conditionType: CONDITION_TYPES.includes(stored.conditionType as MonitorConditionType)
      ? (stored.conditionType as MonitorConditionType)
      : fallback.conditionType,
    threshold: positive(stored.threshold, fallback.threshold),
    severity: SEVERITIES.includes(stored.severity as Severity)
      ? (stored.severity as Severity)
      : fallback.severity,
    firingAfter: positive(stored.firingAfter, fallback.firingAfter),
    okAfter: positive(stored.okAfter, fallback.okAfter),
    scheduleIntervalSeconds: positive(
      stored.scheduleIntervalSeconds,
      fallback.scheduleIntervalSeconds,
    ),
  };
}

/**
 * The write, in full, for one planned item.
 *
 * A monitor carries its `hostGroup` because that group is **not** the feed's group: the
 * monitors were observed living in `default_search` while the feeds live in `default`, and
 * per-feed scoping happens through the rule tags instead of through the path.
 */
export type PlannedWrite =
  | { kind: 'notification'; notification: NotificationPayload }
  | {
      kind: 'monitor';
      hostGroup: string;
      monitor: Monitor;
      bridge: BridgeNotificationPayload;
      /** The shipped monitor whose query was copied, named so the preview can say so. */
      templateId: string;
    };

export interface PlannedAlert {
  /** Stable key for progress and retry. */
  key: string;
  rowId: string;
  feedId: string;
  group: string;
  direction: Direction;
  mechanism: Mechanism;
  signal: Signal;
  /** One line naming the mechanism and what it watches. Shown in the preview. */
  label: string;
  /**
   * The exact object(s) that would be written. `null` when nothing can be built at all —
   * the preview shows the reason instead of a payload, rather than a plausible-looking
   * object the app has no intention of sending.
   */
  write: PlannedWrite | null;
  /** Set when this item cannot be created. Never sent; shown with the reason. */
  blocked?: string;
  /** Set when the feed is already watched. */
  skipped?: string;
  /**
   * Something true about this write that the admin should know before confirming it, but
   * which does not stop it. Distinct from `blocked` in both directions: a warned item **is**
   * created, and an item that carries one is never silently downgraded to a skip.
   *
   * The case this exists for: a monitor scopes by feed tag, and a tag is not group-scoped.
   */
  warning?: string;
}

/** Everything the plan needs from discovery, so the argument list stays readable. */
export interface PlanContext {
  conditions: ReadonlyMap<string, NotificationCondition>;
  coverage: ReadonlyMap<string, FeedCoverage>;
  /** Can Notifications be created? */
  alerting: Capability;
  /** Can monitors be created? Fails separately, for separate reasons. */
  monitors: Capability;
  /** The group whose monitor collection answers, or `null` if none does. */
  monitorHost: string | null;
  /** Shipped monitors whose query can be copied, per direction, best first. */
  monitorTemplates: Record<Direction, Monitor[]>;
  /**
   * Every discovered feed that shares a monitor id namespace, keyed by the sanitized feed id,
   * built from **all** feeds rather than the selection.
   *
   * Two different hazards read out of this one index, and they are different hazards:
   *
   * - The same tag in more than one group. A monitor scopes by tag and a tag carries no worker
   *   group, so the monitor watches both feeds. That is a warning — the alert still works.
   * - Two genuinely different feeds whose ids sanitize to the same string. A monitor id is
   *   `{template}_{feed}`, so they would land on one object and the POST-then-PATCH recovery
   *   would retarget the first admin's monitor at the second admin's feed. That is a block.
   *
   * Built from all feeds because the selection is the wrong place to look: the admin selecting
   * one row is precisely the case where the second feed goes unnoticed.
   */
  feedIdentities: ReadonlyMap<string, readonly FeedIdentity[]>;
}

/**
 * One distinct feed as a monitor sees it: a direction and a tag, in one or more groups.
 *
 * Distinct by `direction|tag`, not by group, because that pair is what `includedTags` selects.
 */
export interface FeedIdentity {
  direction: Direction;
  /** The `type:id` tag. */
  tag: string;
  /** Groups holding a feed with this direction and tag, sorted. */
  groups: string[];
}

/**
 * Index every discovered feed under the id segment its monitor id would use.
 *
 * Groups and identities are deduplicated and sorted so the messages built from them read the
 * same on every render — a warning that reorders itself between renders reads like new
 * information.
 */
export function indexFeedIdentities(feeds: readonly Feed[]): Map<string, FeedIdentity[]> {
  const index = new Map<string, FeedIdentity[]>();
  for (const feed of feeds) {
    const key = sanitizeIdPart(feed.id);
    const identities = index.get(key) ?? [];
    if (identities.length === 0) index.set(key, identities);
    const existing = identities.find(
      (item) => item.direction === feed.direction && item.tag === feed.metricKey,
    );
    if (!existing) identities.push({ direction: feed.direction, tag: feed.metricKey, groups: [feed.group] });
    else if (!existing.groups.includes(feed.group)) existing.groups.push(feed.group);
  }
  for (const identities of index.values()) {
    identities.sort((a, b) => a.direction.localeCompare(b.direction) || a.tag.localeCompare(b.tag));
    for (const identity of identities) identity.groups.sort((a, b) => a.localeCompare(b));
  }
  return index;
}

type PlanBase = Pick<PlannedAlert, 'key' | 'rowId' | 'feedId' | 'group' | 'direction' | 'mechanism'>;

function planNotification(feed: Feed, base: PlanBase, settings: TemplateSettings, context: PlanContext): PlannedAlert {
  const conditionId = settings.conditionBy[feed.direction];
  const condition = conditionId ? context.conditions.get(conditionId) : undefined;

  if (!condition) {
    return {
      ...base,
      signal: 'unclassified',
      label: 'No alert available for this direction',
      write: null,
      blocked:
        `This deployment's condition catalogue offers nothing that detects a ${feed.direction} ` +
        'no longer delivering data, and condition ids are never guessed. Nothing was created.',
    };
  }

  return {
    ...base,
    signal: classifyCondition(condition),
    label: `Notification on "${condition.name}" (${condition.id})`,
    write: {
      kind: 'notification',
      notification: buildNotification(feed, {
        conditionId: condition.id,
        // Pruned against *this* condition's schema. Sources and Destinations land on
        // different conditions with different fields, and a key the chosen condition does
        // not declare has no business in its payload.
        conf: pruneConf(formFields(condition.schema), settings.confBy[feed.direction]),
        routing: settings.routing,
        createDisabled: settings.createDisabled,
      }),
    },
    blocked: context.alerting.available ? undefined : context.alerting.reason,
  };
}

/** The shipped monitor a direction's settings resolve to, or `undefined` if there is none. */
function resolveTemplate(
  direction: Direction,
  settings: TemplateSettings,
  context: PlanContext,
): Monitor | undefined {
  const candidates = context.monitorTemplates[direction];
  const chosen = settings.monitorBy[direction].templateId;
  return chosen ? candidates.find((item) => item.id === chosen) : candidates[0];
}

function identitiesFor(feed: Feed, context: PlanContext): readonly FeedIdentity[] {
  return context.feedIdentities.get(sanitizeIdPart(feed.id)) ?? [];
}

/**
 * Refuse the write when a different feed would produce the same monitor id.
 *
 * A monitor id is `{template}_{feed}` — the form the admin asked for, so that the id on the
 * Insights alerts page names the metric and the feed. The cost of leaving the worker group and
 * the feed type out of it is that two feeds can collide: different types under one id
 * (`syslog:app` and `tcp:app`), or ids that differ only in a character `sanitizeIdPart`
 * rewrites (`app.one` and `app_one`).
 *
 * A collision is a block, not a warning, and the reason is `upsertMonitor`: it POSTs and then
 * PATCHes on an id-exists rejection, so the second feed would silently retarget the first
 * feed's monitor at itself. The first feed would then read as watched by a monitor watching
 * something else — the exact failure this app exists to prevent. Better to create nothing and
 * say which two feeds clash.
 */
function collisionBlock(
  feed: Feed,
  template: Monitor,
  settings: TemplateSettings,
  context: PlanContext,
): string | undefined {
  const mine = monitorId(feed, template);
  const tag = feedTag(feed);
  const clashes = identitiesFor(feed, context).filter((identity) => {
    if (identity.direction === feed.direction && identity.tag === tag) return false;
    const peer = resolveTemplate(identity.direction, settings, context);
    return peer !== undefined && monitorIdFor(feed.id, peer.id) === mine;
  });
  if (clashes.length === 0) return undefined;
  const named = clashes
    .map((identity) => `"${identity.tag}" in ${identity.groups.map((group) => `"${group}"`).join(', ')}`)
    .join('; ');
  return (
    `A monitor for this feed would be created as "${mine}", and that id is also what this app would ` +
    `create for a different feed: ${named}. Cribl would treat the second write as an edit of the ` +
    'first, leaving one feed watched by a monitor scoped to the other. Nothing was created. Use a ' +
    'Notification for these feeds, or rename one of them in Cribl so the ids differ.'
  );
}

/**
 * Say so when a monitor will watch more than the row the admin selected.
 *
 * `rules[0].includedTags` pins the feed tag and **only** the feed tag, because adding a
 * `__worker_group` tag this deployment may not support would narrow the monitor to nothing —
 * and a monitor that is silently too broad is far less dangerous than one that is silently
 * dead. That trade is deliberate, so the cost of it is stated rather than hidden: an
 * identically typed and named feed in another group is watched by the same monitor, and one
 * of them going quiet fires an alert naming a feed tag that exists twice.
 *
 * `undefined` when the tag is unique, which is the ordinary case — an unconditional note
 * about a hazard that is not present is how a preview teaches an admin to skim it.
 */
function sharedTagWarning(feed: Feed, context: PlanContext): string | undefined {
  const mine = identitiesFor(feed, context).find(
    (identity) => identity.direction === feed.direction && identity.tag === feedTag(feed),
  );
  const others = (mine?.groups ?? []).filter((group) => group !== feed.group);
  if (others.length === 0) return undefined;
  const label = feed.direction === 'source' ? 'Source' : 'Destination';
  return (
    `A monitor scopes by feed tag, and a tag carries no worker group: "${feedTag(feed)}" is also an ` +
    `enabled ${label} in ${others.map((group) => `"${group}"`).join(', ')}, so this monitor will watch ` +
    `${others.length + 1} feeds, not one. Only the feed tag is pinned deliberately — a worker-group tag ` +
    'this deployment may not support would narrow the monitor to nothing. Use a Notification for this ' +
    'feed instead if the alert has to name one group.'
  );
}

function planMonitor(feed: Feed, base: PlanBase, settings: TemplateSettings, context: PlanContext): PlannedAlert {
  const dead = (
    blockedReason: string,
    label = 'No Insights monitor available for this direction',
  ): PlannedAlert => ({
    ...base,
    signal: 'unclassified',
    label,
    write: null,
    blocked: blockedReason,
  });

  if (!context.monitorHost) {
    return dead(
      context.monitors.reason ??
        'No worker group answered with an Insights monitor collection, so no monitor can be created.',
    );
  }

  const template = resolveTemplate(feed.direction, settings, context);
  if (!template) {
    const chosen = settings.monitorBy[feed.direction].templateId;
    return dead(
      chosen
        ? `The monitor "${chosen}" this template copies its query from is no longer in the catalogue on ` +
            `"${context.monitorHost}", and this app does not compose PromQL itself. Nothing was created.`
        : `No monitor shipped on "${context.monitorHost}" measures ${feed.direction} throughput, and this ` +
            'app copies its query from one rather than composing PromQL. Nothing was created.',
    );
  }

  const collision = collisionBlock(feed, template, settings, context);
  if (collision) return dead(collision, 'Monitor id would collide with another feed');

  const monitorSettings = settings.monitorBy[feed.direction];
  const monitor = buildMonitor(feed, {
    ...defaultMonitorOptions(template),
    conditionType: monitorSettings.conditionType,
    threshold: monitorSettings.threshold,
    severity: monitorSettings.severity,
    firingAfter: monitorSettings.firingAfter,
    okAfter: monitorSettings.okAfter,
    scheduleIntervalSeconds: monitorSettings.scheduleIntervalSeconds,
    enabled: !settings.createDisabled,
    // Passed whatever the route, and deliberately: an unused `params.to` on a monitor delivered
    // by policy costs nothing, whereas a missing one on an email-routed monitor renders an empty
    // address. The drawer is what decides whether to *ask* for it.
    recipient: settings.routing.recipient,
  });

  // The copied query decides what this watches, and only a throughput query counts as
  // watching for a delivery stop. An `unclassified` monitor would be created and then never
  // counted as coverage anywhere, so it is refused here instead of quietly not counting.
  const signal = classifyMonitorQuery(monitor.query);
  if (signal === 'unclassified') {
    return dead(
      `The query on "${template.id}" does not measure throughput, so a monitor copied from it would not ` +
        'detect a feed that stopped delivering. Nothing was created.',
    );
  }

  return {
    ...base,
    signal,
    warning: sharedTagWarning(feed, context),
    label:
      `Insights monitor copying "${template.id}" · ${monitorSettings.conditionType.replace('_', ' ')} ` +
      `${monitorSettings.threshold} for ${monitorSettings.firingAfter}s`,
    write: {
      kind: 'monitor',
      hostGroup: context.monitorHost,
      monitor,
      bridge: buildBridgeNotification(monitor.id, settings.createDisabled, settings.routing),
      templateId: template.id,
    },
    // Gated on the monitor capability only. `alerting` is about the *condition catalogue*, which
    // a monitor does not need: its bridge Notification uses the fixed `monitor-alerts` condition
    // Cribl reserves for monitor output. Whether that bridge write is permitted is not knowable
    // until it is attempted, and a bridge that fails is reported per item, not predicted here.
    blocked: context.monitors.available ? undefined : context.monitors.reason,
  };
}

function planItem(feed: Feed, settings: TemplateSettings, context: PlanContext): PlannedAlert {
  const mechanism = settings.mechanismBy[feed.direction];
  const base: PlanBase = {
    key: feed.rowId,
    rowId: feed.rowId,
    feedId: feed.id,
    group: feed.group,
    direction: feed.direction,
    mechanism,
  };
  return mechanism === 'monitor'
    ? planMonitor(feed, base, settings, context)
    : planNotification(feed, base, settings, context);
}

/**
 * Build the plan.
 *
 * Feeds that are already watched produce a `skipped` item rather than being dropped, so
 * the preview accounts for every selected feed and the admin never has to wonder why a
 * count does not add up.
 */
export function buildPlan(
  feeds: readonly Feed[],
  settings: TemplateSettings,
  context: PlanContext,
): PlannedAlert[] {
  return feeds.map((feed) => {
    const item = planItem(feed, settings, context);
    return isCovered(context.coverage.get(feed.rowId))
      ? { ...item, skipped: 'Already has an enabled alert.' }
      : item;
  });
}

export interface PlanCounts {
  creatable: number;
  blocked: number;
  skipped: number;
}

export function countPlan(plan: readonly PlannedAlert[]): PlanCounts {
  const counts: PlanCounts = { creatable: 0, blocked: 0, skipped: 0 };
  for (const item of plan) {
    if (item.skipped) counts.skipped++;
    else if (item.blocked) counts.blocked++;
    else counts.creatable++;
  }
  return counts;
}
