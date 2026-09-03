/**
 * The load sequence.
 *
 * Every step is wrapped independently: one denied endpoint costs the admin that one
 * capability and nothing else. The page never blanks, and a step that fails says why
 * in words the admin can act on.
 *
 * Discovery covers **every** Stream group, not just the selected one. The group
 * selector filters the table; it does not gate the fetch. That matters for
 * correctness, not just convenience: a Notification with no `group` field can only be
 * attributed when exactly one feed anywhere matches it, and that question cannot be
 * answered from a single group's feeds.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError, mapLimit } from '../api/client.ts';
import { fetchAllGroupIds, fetchWorkerGroups } from '../api/groups.ts';
import { fetchFeeds } from '../api/feeds.ts';
import { fetchConditions } from '../api/conditions.ts';
import { fetchInsightsHealth } from '../api/insights.ts';
import {
  fetchNotificationTargets,
  fetchNotifications,
  type NotificationTarget,
} from '../api/alerts.ts';
import {
  fetchNotificationPolicyCount,
  fetchNotificationTemplates,
  type NotificationTemplate,
} from '../api/routing.ts';
import { loadRegistry, loadTemplateDefaults, pruneRegistry, type TemplateDefaults } from '../api/kv.ts';
import { discoverMonitorHost, type Monitor, type MonitorHost } from '../api/monitors.ts';
import {
  attributeMonitors,
  attributeNotifications,
  buildCoverage,
  classifyCondition,
  staleRegistryEntries,
} from '../lib/attribution.ts';
import { templateCandidates } from '../lib/monitorPayload.ts';
import type {
  Capability,
  Direction,
  Feed,
  FeedCoverage,
  ManagedRecord,
  NotificationCondition,
  UnattributedAlert,
  WorkerGroup,
} from '../lib/types.ts';
import { blocked, CAPABLE } from '../lib/types.ts';

const DIRECTIONS: Direction[] = ['source', 'destination'];
const GROUP_FETCH_CONCURRENCY = 4;

export interface GroupFetchNote {
  group: string;
  direction: Direction;
  message: string;
}

export interface DiscoveryCapabilities {
  /**
   * Can the app create a Notification on a discovered condition? Needs the catalogue and the
   * Notification engine, and nothing else — not Insights, not a monitor engine.
   *
   * It does **not** gate a monitor, not even the bridge Notification that routes one: that
   * bridge uses the fixed `monitor-alerts` condition and consults no catalogue. Whether the
   * bridge write is permitted is only knowable by attempting it, and a failure there is
   * reported per item as a partial success — never predicted by blocking the item up front.
   */
  alerting: Capability;
  /** Notification routing targets. */
  routingTargets: Capability;
  /** The KV registry. */
  registry: Capability;
  /**
   * Insights monitors — the mechanism that puts an alert on the Insights alerts page with a
   * chart and an Activity trail.
   *
   * Separate from `alerting` because it fails separately and for different reasons: it needs a
   * group whose `/m/{gid}/alert/monitors` collection answers, at least one shipped Stream
   * monitor to copy a query from, and an evaluation engine that is actually running. Any of
   * those missing costs the monitor mechanism and leaves Notifications working.
   */
  monitors: Capability;
}

export interface DiscoveryData {
  groups: WorkerGroup[];
  feeds: Feed[];
  coverage: Map<string, FeedCoverage>;
  unattributed: UnattributedAlert[];
  /** All discovered conditions, by id. */
  conditionsById: Map<string, NotificationCondition>;
  /**
   * The conditions that can detect a feed no longer delivering data, per direction.
   *
   * Deliberately asymmetric, because the catalogue is: verified live 2026-09-02, Sources
   * offer `no-data`, `low-volume` and `high-volume`; Destinations offer `unhealthy-dest`.
   * Both satisfy the one intent, which is why the app needs only one engine.
   */
  conditionsByDirection: Record<Direction, NotificationCondition[]>;
  targets: NotificationTarget[];
  /**
   * The other two halves of the routing choice, read but never written.
   *
   * Templates are paired with a target so the message is rendered for its type; the policy
   * *count* is all that is read of policies, because the alternative — deciding which policy
   * would carry a given alert — is a guess about routing this app does not own.
   *
   * Each carries its own reason so "this deployment has none" and "this could not be read" stay
   * separate facts. They are opposite answers: none means the other route is the one to take,
   * unreadable means the app does not know which route works.
   */
  notificationTemplates: NotificationTemplate[];
  notificationTemplatesReason: string | null;
  notificationPolicyCount: number | null;
  notificationPolicyReason: string | null;
  /** The group hosting the monitor collection, and every monitor in it. */
  monitorHost: MonitorHost | null;
  /**
   * Shipped monitors whose query this app can copy, per direction, best first.
   *
   * The query is never composed here — see `lib/monitorPayload.ts`. No template for a
   * direction means no monitor can be created for it, and the app says so instead of
   * inventing PromQL that would evaluate to nothing.
   */
  monitorTemplates: Record<Direction, Monitor[]>;
  registry: ManagedRecord[];
  templateDefaults: TemplateDefaults | null;
  capabilities: DiscoveryCapabilities;
  /** Non-fatal things the admin should know: skipped groups, pruned entries, … */
  notices: string[];
  perGroupNotes: GroupFetchNote[];
}

export interface DiscoveryState extends DiscoveryData {
  loading: boolean;
  /** Set only when the app could not get far enough to render a table at all. */
  fatal: string | null;
  reload: () => void;
}

function emptyData(): DiscoveryData {
  return {
    groups: [],
    feeds: [],
    coverage: new Map(),
    unattributed: [],
    conditionsById: new Map(),
    conditionsByDirection: { source: [], destination: [] },
    targets: [],
    notificationTemplates: [],
    // Not `null`: an empty list with no reason reads as "this deployment has none", and before
    // the load has run that is not something the app knows.
    notificationTemplatesReason: 'Not loaded yet.',
    notificationPolicyCount: null,
    notificationPolicyReason: 'Not loaded yet.',
    monitorHost: null,
    monitorTemplates: { source: [], destination: [] },
    registry: [],
    templateDefaults: null,
    capabilities: {
      alerting: blocked('Not loaded yet.'),
      routingTargets: blocked('Not loaded yet.'),
      registry: blocked('Not loaded yet.'),
      monitors: blocked('Not loaded yet.'),
    },
    notices: [],
    perGroupNotes: [],
  };
}

interface Attempt<T> {
  value: T | null;
  capability: Capability;
}

/** Run a step, converting a failure into a capability reason instead of a crash. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await run(), capability: CAPABLE };
  } catch (error) {
    console.error(`[cc-simplified-alerting] ${label} failed:`, error);
    return { value: null, capability: blocked(`${label}: ${describeError(error)}`) };
  }
}

async function loadAll(signal: AbortSignal): Promise<DiscoveryData> {
  const data = emptyData();

  data.groups = await fetchWorkerGroups(signal);
  if (data.groups.length === 0) {
    data.notices.push('No Stream worker groups were returned, so there is nothing to alert on yet.');
  }

  // --- Feeds: one call per group per direction, failures isolated per group ---
  const jobs = data.groups.flatMap((group) =>
    DIRECTIONS.map((direction) => ({ group: group.id, direction })),
  );
  const feedResults = await mapLimit(jobs, GROUP_FETCH_CONCURRENCY, async (job) => {
    try {
      return { job, feeds: await fetchFeeds(job.group, job.direction, signal) };
    } catch (error) {
      return { job, feeds: [] as Feed[], error: describeError(error) };
    }
  });
  for (const result of feedResults) {
    data.feeds.push(...result.feeds);
    if (result.error) {
      data.perGroupNotes.push({
        group: result.job.group,
        direction: result.job.direction,
        message: result.error,
      });
    }
  }

  // --- Notification conditions (schemas drive the configure form) ---
  const conditionResults = await Promise.all(
    DIRECTIONS.map((direction) =>
      attempt(`Reading ${direction} notification conditions`, () =>
        fetchConditions(direction, signal),
      ).then((outcome) => ({ direction, ...outcome })),
    ),
  );
  let conditionsReadable = false;
  let conditionFailure: Capability | null = null;
  for (const result of conditionResults) {
    if (result.value === null) {
      conditionFailure = result.capability;
      continue;
    }
    conditionsReadable = true;
    for (const condition of result.value) {
      data.conditionsById.set(condition.id, condition);
      // Both signals satisfy the one intent. Anything unclassified — `backpressure-dest`,
      // `persistent-queue-usage`, `license-expiration` — is deliberately not offered:
      // none of them detects a feed that stopped delivering.
      if (classifyCondition(condition) !== 'unclassified') {
        data.conditionsByDirection[result.direction].push(condition);
      }
    }
  }

  const usable = DIRECTIONS.filter((direction) => data.conditionsByDirection[direction].length > 0);
  data.capabilities.alerting = !conditionsReadable
    ? (conditionFailure ??
      blocked('The notification condition catalogue could not be read, so no condition id is known.'))
    : usable.length > 0
      ? CAPABLE
      : blocked(
          'This deployment offers no notification condition that detects a feed no longer delivering ' +
            'data, and condition ids are never guessed. The table below is still a full coverage and ' +
            'health audit.',
        );
  if (conditionsReadable && usable.length === 1) {
    // Not a capability failure — half the app works. But an admin who selects the other
    // direction and finds every row blocked deserves to have been told why up front.
    data.notices.push(
      `Only ${usable[0] === 'source' ? 'Sources' : 'Destinations'} can be alerted on here: the condition ` +
        `catalogue offers nothing that detects a ${usable[0] === 'source' ? 'Destination' : 'Source'} ` +
        'no longer delivering data.',
    );
  }

  // --- Insights monitors: the mechanism that lands on the Insights alerts page ---
  //
  // Three things have to be true, and each is discovered rather than assumed: a group whose
  // monitor collection answers, a shipped Stream monitor whose query can be copied, and an
  // engine that will actually evaluate what gets written. The last one is why this is gated
  // at all — a monitor that is created successfully and never evaluated is a silent failure,
  // and this app must not report one as an alert.
  const candidateIds = await attempt('Listing groups to locate the monitor collection', () =>
    fetchAllGroupIds(signal),
  );
  const hosts = await attempt('Locating the Insights monitor collection', () =>
    discoverMonitorHost(candidateIds.value ?? data.groups.map((group) => group.id), signal),
  );
  const host = hosts.value?.host ?? null;
  if (!hosts.value) {
    data.capabilities.monitors = hosts.capability;
  } else if (!host) {
    const tried = hosts.value.probes.map((probe) => `${probe.group} (${probe.reason})`).join('; ');
    data.capabilities.monitors = blocked(
      `No group's /m/{group}/alert/monitors collection answered, so no Insights monitor can be ` +
        `created or read. Tried: ${tried || 'no groups'}.`,
    );
  } else {
    data.monitorHost = host;
    for (const direction of DIRECTIONS) {
      data.monitorTemplates[direction] = templateCandidates(host.monitors, direction);
    }
    const withTemplates = DIRECTIONS.filter((direction) => data.monitorTemplates[direction].length > 0);
    if (withTemplates.length === 0) {
      data.capabilities.monitors = blocked(
        `Worker group "${host.group}" holds ${host.monitors.length} monitors but none of the ` +
          'throughput monitors this app copies its query from. The app does not compose PromQL ' +
          'itself, so it will not create a monitor here.',
      );
    } else {
      const engine = await attempt('Checking the Insights engine on the monitor host group', () =>
        fetchInsightsHealth(host.group, signal),
      );
      data.capabilities.monitors =
        engine.value?.status === 'red'
          ? blocked(
              `Insights on "${host.group}" reports status "red"` +
                `${engine.value.reason ? ` (${engine.value.reason})` : ''}. A monitor written there ` +
                'would not be evaluated, so monitor creation is disabled rather than reported as working.',
            )
          : CAPABLE;
      if (engine.value === null) {
        data.notices.push(
          `The Insights engine on "${host.group}" could not be checked (${engine.capability.reason ?? 'unknown'}). ` +
            'Monitors can still be created, but this app cannot confirm anything will evaluate them.',
        );
      }
      if (withTemplates.length === 1) {
        data.notices.push(
          `Only ${withTemplates[0] === 'source' ? 'Sources' : 'Destinations'} can be watched by an ` +
            'Insights monitor here: no shipped monitor measures the other direction’s throughput.',
        );
      }
    }
  }

  // --- Existing alerts ---
  const notifications = await attempt('Reading existing notifications', () =>
    fetchNotifications(signal),
  );
  const targets = await attempt('Reading notification targets', () => fetchNotificationTargets(signal));
  if (targets.value) data.targets = targets.value;
  data.capabilities.routingTargets = targets.value
    ? CAPABLE
    : blocked(
        `${targets.capability.reason ?? 'Notification targets could not be read.'} Alerts can still be ` +
          'created with routing unset, but routing must then be attached in Cribl separately.',
      );

  // --- The rest of the routing choice: templates, and whether any policy exists ---
  //
  // Neither of these is a capability. They do not decide whether an alert can be created, only
  // which delivery route is worth choosing, so a failure here is stated in the drawer beside the
  // choice it affects rather than as a page-level notice about something the admin is not doing.
  const templates = await attempt('Reading notification templates', () =>
    fetchNotificationTemplates(signal),
  );
  data.notificationTemplates = templates.value ?? [];
  data.notificationTemplatesReason = templates.value
    ? null
    : (templates.capability.reason ?? 'Notification templates could not be read.');

  const policies = await attempt('Reading notification policies', () =>
    fetchNotificationPolicyCount(signal),
  );
  data.notificationPolicyCount = policies.value;
  data.notificationPolicyReason =
    policies.value === null
      ? (policies.capability.reason ?? 'Notification policies could not be read.')
      : null;

  // --- KV registry, reconciled against what actually exists ---
  const registry = await attempt('Reading the app registry', () => loadRegistry(signal));
  data.capabilities.registry = registry.value ? CAPABLE : registry.capability;
  if (registry.value) {
    data.registry = registry.value.records;
    if (registry.value.truncated) {
      data.notices.push(
        'The registry of app-created alerts is larger than this view reads in one go; some alerts may ' +
          'show as unmanaged.',
      );
    }
    if (registry.value.unreadable.length > 0) {
      data.notices.push(
        `${registry.value.unreadable.length} registry entries could not be read and are being ignored.`,
      );
    }
  }

  // Reconcile only when the live list was readable. Pruning against a failed read would
  // delete records for alerts that exist, and the registry is the only thing that
  // distinguishes app-managed alerts from everything else.
  //
  // The live set spans both mechanisms. A registry entry for a monitor is keyed on the monitor
  // id, which is not a Notification id, so reconciling against Notifications alone would
  // delete every monitor entry on load and report app-created monitors as unmanaged.
  if (notifications.value && data.registry.length > 0) {
    const live = new Set(
      notifications.value.flatMap((item) => (typeof item.id === 'string' ? [item.id] : [])),
    );
    for (const monitor of host?.monitors ?? []) live.add(monitor.id);
    // A monitor entry can only be judged when the monitor collection was actually read. With
    // no host, every monitor entry would look stale for the same reason it looks invisible,
    // and the app would delete its own record of a monitor that is still there.
    const judgeable =
      host === null
        ? data.registry.filter((record) => record.settings?.mechanism !== 'monitor')
        : data.registry;
    const stale = staleRegistryEntries(judgeable, live);
    if (stale.length > 0) {
      const staleIds = new Set(stale.map((record) => record.id));
      data.registry = data.registry.filter((record) => !staleIds.has(record.id));
      data.notices.push(
        `${stale.length} registry ${stale.length === 1 ? 'entry' : 'entries'} referenced an alert that no ` +
          'longer exists and were dropped, so coverage reflects only alerts that are really there.',
      );
      void pruneRegistry(stale, signal);
    }
  }

  // --- Attribution and coverage ---
  const registryIndex = new Map(data.registry.map((record) => [record.id, record] as const));
  if (notifications.value) {
    const outcome = attributeNotifications(
      notifications.value,
      data.feeds,
      data.conditionsById,
      registryIndex,
      // An unreadable registry must not be reported as "this alert is not ours".
      registry.value !== null,
    );
    data.unattributed.push(...outcome.unattributed);

    // Monitors join the same coverage column as Notifications: the question the column
    // answers — is anything watching this feed for a delivery stop — does not care which
    // mechanism answers it. The chip says which, and the configuration view shows the object.
    const monitorOutcome = host
      ? attributeMonitors(
          host.monitors,
          host.group,
          data.feeds,
          outcome.bridges,
          registryIndex,
          registry.value !== null,
        )
      : null;
    if (monitorOutcome) data.unattributed.push(...monitorOutcome.unattributed);

    data.coverage = buildCoverage(data.feeds, [
      ...outcome.attributed,
      ...(monitorOutcome?.attributed ?? []),
    ]);
  } else {
    data.coverage = buildCoverage(data.feeds, []);
    data.notices.push(
      `${notifications.capability.reason ?? 'Notifications could not be read.'} Coverage is therefore ` +
        'unknown — the table shows no alerts rather than confirming there are none.',
    );
  }

  const defaults = await attempt('Reading saved template defaults', () => loadTemplateDefaults(signal));
  data.templateDefaults = defaults.value;

  return data;
}

export function useDiscovery(): DiscoveryState {
  const [data, setData] = useState<DiscoveryData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    // Marking the load as in-flight is exactly what synchronising with an external
    // system looks like: the request starts here, so the spinner has to start here too.
    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true);
    setFatal(null);

    loadAll(controller.signal)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Only the worker-group call is load-bearing enough to reach here; without it
        // there are no groups to enumerate feeds for.
        console.error('[cc-simplified-alerting] discovery failed:', error);
        if (live) setFatal(describeError(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return useMemo(() => ({ ...data, loading, fatal, reload }), [data, loading, fatal, reload]);
}
