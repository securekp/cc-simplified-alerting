/**
 * Matching existing alerts back to the feed each one watches.
 *
 * The coverage column depends on this, and it has to work for alerts the app did not
 * create. The governing rule is: never guess. An alert that cannot be pinned to exactly
 * one feed is reported as unattributed — not silently dropped, and never counted twice.
 */

import { isAppAlertId } from './payloads.ts';
import { isAppMonitorDescription } from './monitorPayload.ts';
import type { Monitor } from '../api/monitors.ts';
import type {
  AttributedAlert,
  Direction,
  Feed,
  FeedCoverage,
  ManagedRecord,
  NotificationCondition,
  Ownership,
  Signal,
  UnattributedAlert,
} from './types.ts';

/** Raw `GET /notifications` item. */
export interface RawNotification {
  id?: unknown;
  condition?: unknown;
  group?: unknown;
  disabled?: unknown;
  /** `"policy"` or `"direct"`, and absent on an alert that simply names its targets. */
  mode?: unknown;
  targets?: unknown;
  templateTargetPairs?: unknown;
  conf?: Record<string, unknown>;
}

export interface AttributionOutcome {
  attributed: AttributedAlert[];
  unattributed: UnattributedAlert[];
  /**
   * Bridge Notifications, keyed by the monitor id they route.
   *
   * `{id: "monitor-x", condition: "monitor-alerts", conf: {}}` carries no `conf.name` and so
   * belongs to no feed. Reporting it as unattributed would be technically true and useless:
   * it is not an alert, it is the routing half of one. Monitor attribution consumes this map
   * to tell an admin whether the monitor they are looking at delivers anywhere.
   */
  bridges: Map<string, RawNotification>;
}

/** `monitor-alerts` is the condition Cribl reserves for monitor output. */
export function bridgedMonitorId(raw: RawNotification): string | null {
  if (raw.condition !== 'monitor-alerts') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  return id.startsWith('monitor-') ? id.slice('monitor-'.length) : null;
}

/**
 * What a condition watches.
 *
 * Condition ids are discovered, never hardcoded, so this classifies by what the catalogue
 * reports rather than by a fixed list. Anything it cannot place is `unclassified` and
 * counts toward coverage for nothing — better an honest "other alert" chip than a feed
 * that looks watched for a failure mode nobody is watching.
 */
export function classifyCondition(condition: NotificationCondition | undefined): Signal {
  if (!condition) return 'unclassified';
  const key = `${condition.id} ${condition.name ?? ''}`.toLowerCase();
  if (/health/.test(key)) return 'health';
  if (/no.?data|volume|byte|event|throughput|rate/.test(key)) return 'volume';
  // Deliberately no `type === 'metric'` fallback. The live catalogue carries
  // `backpressure-dest` and `persistent-queue-usage` as `type: "metric"`, and neither
  // watches health or volume — counting them as coverage would mark a feed "watched" for a
  // delivery stop nobody is actually watching.
  return 'unclassified';
}

/**
 * What a monitor watches, read from its query.
 *
 * Deliberately narrow: only a throughput metric counts as watching for a delivery stop.
 * `pq_buffered_events` and `blocked_outputs` are perfectly good monitors and both contain a
 * volume-ish word, but neither detects a feed that went quiet — the same reason
 * `persistent-queue-usage` is `unclassified` on the Notification side.
 */
export function classifyMonitorQuery(query: string): Signal {
  if (/health/i.test(query)) return 'health';
  if (/(^|[^a-z])(in|out)_(bytes|events)/.test(query)) return 'volume';
  return 'unclassified';
}

/** `sources` / `destinations` from the condition catalogue is the only direction signal. */
export function directionFromCategory(category: string | undefined): Direction | null {
  if (category === 'sources') return 'source';
  if (category === 'destinations') return 'destination';
  return null;
}

/**
 * Decide what to claim about who created an alert.
 *
 * Order matters: a registry entry is proof, a marker the app itself wrote into the object is
 * strong evidence, and the absence of both means nothing at all unless the registry was
 * actually readable.
 *
 * The reserved `csa-` id namespace — and `ally-`, the one used before the app was renamed — is
 * always accepted as that evidence, which is what covers
 * both Notifications and the monitors earlier builds of this app created. `marked` is the extra
 * evidence a caller can supply when the id cannot carry it: a monitor is now named
 * `{metric}_{feed}` so the Insights alerts page reads properly, so its marker is the sentence
 * `buildMonitor` writes at the head of the description. Both are strings this app generated;
 * neither is user prose being pattern-matched into an ownership claim.
 */
export function alertOwnership(
  id: string,
  record: ManagedRecord | undefined,
  registryReadable: boolean,
  marked = false,
): Ownership {
  if (record) return 'registry';
  if (marked || isAppAlertId(id)) return 'id';
  return registryReadable ? 'external' : 'unknown';
}

/** The chip label. Only `external` is allowed to deny authorship. */
export function ownershipLabel(ownership: Ownership): string {
  switch (ownership) {
    case 'registry':
    case 'id':
      return 'Created by this app';
    case 'external':
      return 'Not created by this app';
    default:
      return 'Ownership unknown';
  }
}

/**
 * Why the label says what it says, when that needs saying.
 *
 * `null` for the two states that speak for themselves. The other two get a sentence,
 * because "unknown" and "recognised from its id" are claims about the app's own evidence
 * and an admin acting on them deserves to know which one they are looking at.
 */
export function ownershipDetail(ownership: Ownership): string | null {
  switch (ownership) {
    case 'id':
      return (
        'Recognised from a marker this app wrote into the object itself — its reserved id ' +
        'namespace for a notification, or the description for a monitor. The app’s own registry has ' +
        'no entry for it, so it was either created by an earlier version of the app or the registry ' +
        'entry did not save.'
      );
    case 'unknown':
      return (
        'The app’s registry of alerts it created could not be read, so it cannot say whether this one ' +
        'came from here. Coverage is unaffected — that is read live from Cribl.'
      );
    default:
      return null;
  }
}

/** Suffix for the compact coverage chip, where there is no room for a sentence. */
export function ownershipSuffix(ownership: Ownership): string {
  switch (ownership) {
    case 'registry':
    case 'id':
      return '';
    case 'external':
      return ' (unmanaged)';
    default:
      return ' (owner unknown)';
  }
}

/**
 * Index the registry by alert id, for the ownership question only.
 *
 * A Notification and a monitor on the same feed carry the same id, so one shadows the other
 * here. That is deliberate and harmless: the only thing read from this map is *whether* the
 * app created the alert, and for two records that both came from here the answer is the same
 * either way. Nothing that distinguishes the mechanisms — pruning, the host group, the
 * template — reads this map; those work off the record list, which holds both.
 */
export function indexRegistry(records: readonly ManagedRecord[]): Map<string, ManagedRecord> {
  const index = new Map<string, ManagedRecord>();
  for (const record of records) index.set(record.id, record);
  return index;
}

/**
 * Attribute Notifications to feeds.
 *
 * `conf.name` holds the **bare feed id** — no type, no direction — so a Source and a
 * Destination sharing an id are indistinguishable from `conf.name` alone. Direction
 * comes from the condition's category, and scope from the Notification's `group`.
 * When `group` is absent we only attribute if exactly one group has that feed.
 *
 * `registryReadable` says whether the registry read succeeded, as opposed to returning
 * nothing. Without it an unreadable registry looks identical to an empty one and every
 * alert gets labelled as not created here.
 */
export function attributeNotifications(
  notifications: readonly RawNotification[],
  feeds: readonly Feed[],
  conditions: ReadonlyMap<string, NotificationCondition>,
  registry: ReadonlyMap<string, ManagedRecord>,
  registryReadable = true,
): AttributionOutcome {
  const attributed: AttributedAlert[] = [];
  const unattributed: UnattributedAlert[] = [];
  const bridges = new Map<string, RawNotification>();

  for (const raw of notifications) {
    const id = typeof raw.id === 'string' ? raw.id : null;
    if (!id) continue;

    // Set aside before anything else: a bridge is the routing half of a monitor, not an
    // alert on a feed, and it would otherwise be reported as unattributed for every monitor.
    const bridged = bridgedMonitorId(raw);
    if (bridged) {
      bridges.set(bridged, raw);
      continue;
    }

    const conditionId = typeof raw.condition === 'string' ? raw.condition : '';
    const condition = conditions.get(conditionId);
    const feedId = typeof raw.conf?.name === 'string' ? raw.conf.name : null;

    if (!feedId) {
      unattributed.push({
        id,
        reason: `condition "${conditionId}" carries no conf.name, so no single feed owns it`,
      });
      continue;
    }

    const direction = directionFromCategory(condition?.category);
    if (!direction) {
      unattributed.push({
        id,
        reason: condition
          ? `condition "${conditionId}" has category "${condition.category ?? 'none'}", which names no direction`
          : `condition "${conditionId}" is not in the discovered catalogue`,
      });
      continue;
    }

    const group = typeof raw.group === 'string' && raw.group ? raw.group : null;
    const candidates = feeds.filter(
      (feed) => feed.direction === direction && feed.id === feedId && (group === null || feed.group === group),
    );
    if (candidates.length !== 1) {
      unattributed.push({
        id,
        reason:
          candidates.length === 0
            ? `no enabled ${direction} named "${feedId}"${group ? ` in group ${group}` : ''}`
            : `"${feedId}" is a ${direction} in ${candidates.length} groups and the alert names none`,
      });
      continue;
    }

    const record = registry.get(id);
    attributed.push({
      id,
      mechanism: 'notification',
      signal: record?.signal ?? classifyCondition(condition),
      conditionId,
      conditionName: condition?.name ?? null,
      summary: condition ? `${condition.name} (${conditionId})` : `Condition "${conditionId}"`,
      ownership: alertOwnership(id, record, registryReadable),
      disabled: raw.disabled === true,
      rowId: candidates[0].rowId,
      group: group ?? candidates[0].group,
      // The object as stored, so the configuration view shows what is really there.
      config: { ...(raw as Record<string, unknown>) },
    });
  }

  return { attributed, unattributed, bridges };
}

/**
 * Attribute Insights monitors to feeds.
 *
 * A monitor names its feeds in `rules[].includedTags` as fully qualified `type:id` values, so
 * the join is the same exact-equality match the metric join uses — never a prefix match, and
 * never a parse of the tag apart. A monitor with no feed tag watches the whole deployment;
 * that is a real and useful monitor, but it is not per-feed coverage and is reported as
 * unattributed rather than spread across every row.
 *
 * A monitor counts as coverage only if the monitor **and** at least one of its rule
 * conditions is enabled. Every monitor Cribl ships has `enabled: true` on the object and
 * `enabled: false` on all three thresholds — treating that as coverage would mark most feeds
 * watched by something that cannot fire.
 */
export function attributeMonitors(
  monitors: readonly Monitor[],
  hostGroup: string,
  feeds: readonly Feed[],
  bridges: ReadonlyMap<string, RawNotification>,
  registry: ReadonlyMap<string, ManagedRecord>,
  registryReadable = true,
): AttributionOutcome {
  const attributed: AttributedAlert[] = [];
  const unattributed: UnattributedAlert[] = [];
  const byTag = new Map<string, Feed[]>();
  for (const feed of feeds) {
    const tag = `${feed.type}:${feed.id}`;
    const existing = byTag.get(tag);
    if (existing) existing.push(feed);
    else byTag.set(tag, [feed]);
  }

  for (const monitor of monitors) {
    // The shipped defaults are not this app's business: they are deployment-wide, they are
    // not per-feed, and listing 38 of them against every row would bury real coverage.
    if (monitor.isDefault === true) continue;

    const tags = monitor.rules.flatMap((rule) => Object.values(rule.includedTags ?? {}).flat());
    if (tags.length === 0) {
      unattributed.push({
        id: monitor.id,
        reason: 'monitor scopes no feed tag, so it watches the whole deployment rather than one feed',
      });
      continue;
    }

    const matched = tags.flatMap((tag) => byTag.get(tag) ?? []);
    if (matched.length === 0) {
      unattributed.push({
        id: monitor.id,
        reason: `monitor is scoped to ${tags.join(', ')}, which matches no enabled feed here`,
      });
      continue;
    }

    const bridge = bridges.get(monitor.id);
    const conditionsLive = monitor.rules.some((rule) =>
      rule.conditions.some((entry) => entry.enabled !== false),
    );
    const disabled = monitor.enabled !== true || !conditionsLive;
    const record = registry.get(monitor.id);

    // One monitor can legitimately scope several feeds — that is how Cribl's own
    // `source_data_in_rate` is configured — so it appears on each row it actually watches.
    for (const feed of matched) {
      attributed.push({
        id: monitor.id,
        mechanism: 'monitor',
        signal: classifyMonitorQuery(monitor.query),
        conditionId: '',
        conditionName: monitor.name ?? null,
        summary: `Insights monitor${monitor.name ? ` "${monitor.name}"` : ''}`,
        // A monitor's id is `{metric}_{feed}`, not `csa-…`, so the id proves nothing about
        // authorship. The description marker does — see `alertOwnership`.
        ownership: alertOwnership(
          monitor.id,
          record,
          registryReadable,
          isAppMonitorDescription(monitor.description),
        ),
        disabled,
        rowId: feed.rowId,
        group: feed.group,
        hostGroup,
        routed: bridge !== undefined && bridge.disabled !== true,
        // The routing half, as stored. Which route it takes — a policy, or named targets — is a
        // choice made when it was created, so the configuration view reads it rather than
        // assuming the one this app used to hardcode.
        bridgeConfig: bridge ? { ...(bridge as Record<string, unknown>) } : undefined,
        config: { ...(monitor as unknown as Record<string, unknown>) },
      });
    }
  }

  return { attributed, unattributed, bridges: new Map() };
}

export function emptyCoverage(): FeedCoverage {
  return { alerts: [], other: [] };
}

export function buildCoverage(
  feeds: readonly Feed[],
  alerts: readonly AttributedAlert[],
): Map<string, FeedCoverage> {
  const coverage = new Map<string, FeedCoverage>();
  for (const feed of feeds) coverage.set(feed.rowId, emptyCoverage());
  for (const alert of alerts) {
    const entry = coverage.get(alert.rowId);
    if (!entry) continue;
    // One intent, two acceptable signals. `unclassified` is attributed but never coverage.
    if (alert.signal === 'unclassified') entry.other.push(alert);
    else entry.alerts.push(alert);
  }
  return coverage;
}

/**
 * Reconcile the KV registry against what actually exists.
 *
 * The registry is a cache, not the truth: a stale entry must never make an uncovered feed
 * look covered, so entries whose Notification is gone are dropped.
 */
export function staleRegistryEntries(
  records: readonly ManagedRecord[],
  liveNotificationIds: ReadonlySet<string>,
): ManagedRecord[] {
  return records.filter((record) => !liveNotificationIds.has(record.id));
}
