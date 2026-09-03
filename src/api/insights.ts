/**
 * Insights, read for exactly one question: is the engine on the monitor host group alive?
 *
 * This file used to also hold the metric catalogue, per-metric label discovery and the
 * throughput query that filled a sparkline column. All of it is gone with that column:
 * real-time throughput is what Cribl Insights itself is for, and duplicating a 96-pixel
 * history of it here cost a metric-name convention this app could never verify from the
 * browser (`/system-insights/metrics` answers only under `/m/{gid}/` and returns
 * underscore-form names, while `POST /insights/metrics/query` answers at the root and takes
 * dot-separated ones). Nothing alerting-related ever depended on those names, which is why
 * removing them costs no capability.
 */

import { apiGet } from './client.ts';

export interface InsightsHealth {
  status: 'green' | 'red' | 'unknown';
  reason: string | null;
  reportedAt: number | null;
}

/**
 * Insights service health for one worker group.
 *
 * Group-prefixed, and not optionally: `/system-insights/healthcheck` 404s at the root on the
 * verification org and answers under `/m/{gid}/`, which is the form captured live returning
 * `{"items":[{"status":"green","reported_at":…}]}`. The caller is the monitor mechanism, and
 * the group it asks about is the one hosting the monitor collection — that is the engine that
 * would have to evaluate what gets written, so no other group's health answers the question.
 */
export async function fetchInsightsHealth(
  group: string,
  signal?: AbortSignal,
): Promise<InsightsHealth> {
  const body = await apiGet<{ items?: unknown }>(
    `/m/${encodeURIComponent(group)}/system-insights/healthcheck`,
    { signal },
  );
  const first = Array.isArray(body?.items) ? body.items[0] : null;
  if (!first || typeof first !== 'object') return { status: 'unknown', reason: null, reportedAt: null };
  const { status, reason, reported_at: reportedAt } = first as {
    status?: unknown;
    reason?: unknown;
    reported_at?: unknown;
  };
  return {
    status: status === 'green' ? 'green' : status === 'red' ? 'red' : 'unknown',
    reason: typeof reason === 'string' ? reason : null,
    reportedAt: typeof reportedAt === 'number' ? reportedAt : null,
  };
}
