/**
 * Insights monitors — the second alerting mechanism.
 *
 * An "Insights alert", as Cribl's own UI builds one, is two objects: a monitor at
 * `/m/{gid}/alert/monitors/{id}` holding the query, the schedule and the thresholds, plus a
 * bridge Notification `{id: "monitor-{monitorId}", condition: "monitor-alerts"}` that routes
 * whatever the monitor produces. Both are captured live (2026-09-02) — nothing here is
 * inferred from `openapi.json`, whose `MonitorConf.rules[]` has no usable schema.
 *
 * Two prefix traps this module exists to avoid:
 *
 *  - `/alert/monitors` 404s at the root and answers under `/m/{gid}/`. An earlier build
 *    concluded from a root probe that the route does not exist at all.
 *  - The **monitor host group is not the feed's group.** On the verification org the
 *    monitors live in `default_search` while the feeds live in `default`, and per-feed
 *    scoping happens through rule tags rather than through the path. So the host is
 *    discovered by probing, never assumed, and never taken to be the feed's own group.
 */

import { apiPatch, apiPost, fetchAllUnique, mapLimit, ApiError } from './client.ts';

// ---------------------------------------------------------------------------
// Shapes, as returned live
// ---------------------------------------------------------------------------

/** `{type: "greater_than", threshold: 100000}`. `less_than` and `equal` are also live. */
export interface MonitorCondition {
  type: string;
  threshold?: number;
}

export interface MonitorRuleCondition {
  condition: MonitorCondition;
  enabled?: boolean;
  /** `{severity: "critical" | "warning" | "info"}` in every observed monitor. */
  labels?: Record<string, string>;
}

export interface MonitorRule {
  name?: string;
  showOnChart?: boolean;
  conditions: MonitorRuleCondition[];
  /**
   * How a monitor is scoped to specific feeds — `{input: ["datagen:ZscalerWeb", …]}`.
   *
   * This is the whole reason per-feed monitors are viable: the tag values are exactly the
   * `type:id` form this app already builds for the metric join, so a per-feed monitor needs
   * no hand-authored PromQL. Observed live on `source_data_in_rate`.
   */
  includedTags?: Record<string, string[]>;
  excludedTags?: Record<string, string[]>;
}

export interface Monitor {
  id: string;
  name?: string;
  description?: string;
  /** PromQL. Copied from a shipped monitor, never composed here — see `monitorPayload`. */
  query: string;
  /** Note the sense: monitors carry `enabled`, Notifications carry `disabled`. */
  enabled?: boolean;
  product?: string;
  params?: Record<string, unknown>;
  schedule_interval_seconds?: number;
  firing_after?: number;
  ok_after?: number;
  rules: MonitorRule[];
  /** True for the ~38 monitors Cribl ships. The app never edits one of those. */
  isDefault?: boolean;
}

function monitorsPath(group: string): string {
  return `/m/${encodeURIComponent(group)}/alert/monitors`;
}

function idOf(item: { id?: unknown }): string | null {
  return typeof item.id === 'string' && item.id ? item.id : null;
}

function isMonitor(value: unknown): value is Monitor {
  if (!value || typeof value !== 'object') return false;
  const monitor = value as Partial<Monitor>;
  return typeof monitor.id === 'string' && typeof monitor.query === 'string';
}

/** Every monitor in one group, paged to exhaustion like every other list endpoint. */
export async function fetchMonitors(group: string, signal?: AbortSignal): Promise<Monitor[]> {
  const raw = await fetchAllUnique<{ id?: unknown }>(monitorsPath(group), idOf, { signal });
  return raw.filter(isMonitor);
}

// ---------------------------------------------------------------------------
// Host discovery
// ---------------------------------------------------------------------------

export interface MonitorHost {
  group: string;
  monitors: Monitor[];
}

export interface HostProbe {
  group: string;
  /** Why this group is not the host, when it is not. */
  reason: string;
}

export interface HostDiscovery {
  host: MonitorHost | null;
  probes: HostProbe[];
}

/** Bounded: probing every group in a large deployment is not worth a slow first paint. */
const MAX_HOST_PROBES = 8;
const PROBE_CONCURRENCY = 4;

/**
 * Find the group whose monitor collection actually answers.
 *
 * Preference order is deliberate: a group that already holds Cribl's shipped Stream
 * monitors is a group whose evaluation engine is wired up and whose monitors the Insights
 * alerts page reads. A group that answers with an empty list is a fallback, not a
 * discovery — creating a monitor somewhere nothing evaluates it would produce an alert
 * that silently never fires, which is worse than no alert.
 */
export async function discoverMonitorHost(
  candidates: readonly string[],
  signal?: AbortSignal,
): Promise<HostDiscovery> {
  const probes: HostProbe[] = [];
  const answered: MonitorHost[] = [];

  await mapLimit(candidates.slice(0, MAX_HOST_PROBES), PROBE_CONCURRENCY, async (group) => {
    try {
      answered.push({ group, monitors: await fetchMonitors(group, signal) });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      probes.push({
        group,
        reason:
          status === 404
            ? `${monitorsPath(group)} returned 404 — this group hosts no monitor collection.`
            : `${monitorsPath(group)} failed: ${(error as Error).message}`,
      });
    }
  });

  const score = (host: MonitorHost): number => {
    const stream = host.monitors.filter((monitor) => monitor.product === 'stream');
    if (stream.some((monitor) => monitor.isDefault)) return 0;
    if (stream.length > 0) return 1;
    if (host.monitors.length > 0) return 2;
    return 3;
  };
  answered.sort((a, b) => score(a) - score(b) || a.group.localeCompare(b.group));

  for (const host of answered.slice(1)) {
    probes.push({ group: host.group, reason: 'Answered, but another group holds the Stream monitors.' });
  }
  return { host: answered[0] ?? null, probes };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type MonitorWriteVerb = 'created' | 'updated';

export interface MonitorWriteResult {
  verb: MonitorWriteVerb;
  monitor: unknown;
}

/**
 * Create a monitor, or update it if that id is already taken.
 *
 * POST-then-PATCH rather than PATCH alone: the live capture only ever shows the Insights UI
 * PATCHing an id that already existed, so creation of a *new* monitor is the one verb here
 * that is not directly proven. If POST is rejected because the object exists, PATCH is the
 * correct recovery; any other rejection is reported as-is rather than retried, because a
 * blind PATCH after a denied POST would overwrite an object this app did not create.
 */
export async function upsertMonitor(
  group: string,
  monitor: Monitor,
  signal?: AbortSignal,
): Promise<MonitorWriteResult> {
  try {
    return { verb: 'created', monitor: await apiPost<unknown>(monitorsPath(group), monitor, { signal }) };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    const exists = status === 409 || (status === 400 && /exist/i.test((error as Error).message));
    if (!exists) throw error;
    const path = `${monitorsPath(group)}/${encodeURIComponent(monitor.id)}`;
    return { verb: 'updated', monitor: await apiPatch<unknown>(path, monitor, { signal }) };
  }
}

/**
 * Where a monitor is seen and edited in the native UI.
 *
 * With an id, the monitor's own edit screen — `/insights/alerts/monitors/edit/{id}`, a route
 * observed in the org's own Insights UI, not one composed here. Without one, the alerts
 * activity list, which is all that can be honestly offered for an object that has no monitor
 * edit page of its own (a condition Notification).
 *
 * Not group-qualified: neither route carries the group in the capture, and adding one would
 * be a guess that lands the admin on a 404 instead of on their alert.
 */
export function monitorUrl(id?: string | null): string {
  return id ? `/insights/alerts/monitors/edit/${encodeURIComponent(id)}` : '/insights/alerts/activity';
}
