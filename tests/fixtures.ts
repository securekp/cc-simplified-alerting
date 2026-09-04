/**
 * Shared fixtures.
 *
 * Feeds are built through the real `toFeeds` wherever a test cares about the discovery
 * rules; `makeFeed` is for the modules downstream of discovery, which only need a
 * well-formed row.
 */

import { feedMetricKey, feedRowId } from '../src/lib/feeds.ts';
import type { Monitor } from '../src/api/monitors.ts';
import type { AttributedAlert, Direction, Feed, Health, Signal } from '../src/lib/types.ts';

export function makeFeed(overrides: Partial<Feed> & { id: string; type: string }): Feed {
  const direction: Direction = overrides.direction ?? 'source';
  const group = overrides.group ?? 'default';
  // Threaded into the derived fields rather than only spread on top, so `makeFeed({pack: 'p'})`
  // produces the `rowId` and `metricKey` a Pack feed really has instead of a group feed's.
  const pack = overrides.pack ?? null;
  return {
    ...overrides,
    rowId: feedRowId(direction, group, overrides.id, pack),
    group,
    direction,
    pack,
    metricKey: overrides.metricKey ?? feedMetricKey(overrides.type, overrides.id, pack),
    health: overrides.health ?? ('Green' as Health),
    healthKnown: overrides.healthKnown ?? true,
    errorMessage: overrides.errorMessage ?? null,
  };
}

/**
 * A monitor as the collection returns one.
 *
 * The default is a shipped Stream throughput monitor, because that is the only kind this app
 * will copy a query from — the underscore metric name and the empty-string namespace matcher
 * are verbatim from the live capture, and `templateCandidates` matches on exactly that shape.
 */
export function makeMonitor(overrides: Partial<Monitor> & { id: string }): Monitor {
  return {
    query: 'sum(rate(total_in_bytes{namespace=""}[5m])) by (input)',
    enabled: true,
    product: 'stream',
    isDefault: true,
    schedule_interval_seconds: 60,
    firing_after: 300,
    ok_after: 60,
    // Every shipped monitor observed live carries exactly this one param, and a copied monitor
    // has to keep it: it is the unit the Insights chart labels the threshold with.
    params: { unit: 'bytes' },
    rules: [],
    ...overrides,
  };
}

export function makeAlert(
  rowId: string,
  signal: Signal,
  overrides: Partial<AttributedAlert> = {},
): AttributedAlert {
  return {
    id: `alert-${rowId}-${signal}`,
    mechanism: 'notification' as const,
    signal,
    conditionId: signal === 'volume' ? 'no-data' : 'unhealthy-dest',
    conditionName: signal === 'volume' ? 'No Data' : 'Unhealthy Destination',
    summary: 'test alert',
    ownership: 'external',
    disabled: false,
    rowId,
    group: 'default',
    config: {},
    ...overrides,
  };
}
