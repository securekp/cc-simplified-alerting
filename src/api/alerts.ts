/**
 * Reading and creating alerts.
 *
 * Two kinds of object are POSTed to `/notifications` here, and they are not the same thing: a
 * per-feed Notification on a condition discovered from `GET /conditions`, and the fixed
 * `monitor-alerts` bridge that carries an Insights monitor's output into Cribl's notification
 * policies. The monitor itself lives at `/m/{gid}/alert/monitors` — see `api/monitors.ts`.
 */

import { ApiError, apiPost, fetchAllUnique } from './client.ts';
import type { RawNotification } from '../lib/attribution.ts';
import type { NotificationPayload } from '../lib/payloads.ts';
import type { BridgeNotificationPayload } from '../lib/monitorPayload.ts';

function idOf(item: { id?: unknown }): string | null {
  return typeof item.id === 'string' && item.id ? item.id : null;
}

export function fetchNotifications(signal?: AbortSignal): Promise<RawNotification[]> {
  return fetchAllUnique<RawNotification>('/notifications', idOf, { signal });
}

/** `/m/{group}/p/{pack}/notifications` — the collection a Pack's own alerts live in. */
export function packNotificationsPath(group: string, pack: string): string {
  return `/m/${encodeURIComponent(group)}/p/${encodeURIComponent(pack)}/notifications`;
}

/**
 * Existing alerts inside one Pack.
 *
 * Read per Pack rather than by adding `includePacks=true` to the group-level call, and that is a
 * correctness choice, not a stylistic one. A Notification carries a bare `conf.name` and nothing
 * that names a Pack, so attribution's only handle on which feed an alert watches is **which
 * collection returned it**. Merged into one flat list, a Pack alert on `palo_traffic` and a
 * group alert on `palo_traffic` become indistinguishable, and this app's own rule is to report an
 * ambiguous alert as unattributed — which would mean losing coverage the deployment really has.
 *
 * The cost is one request per Pack. The Pack-context list also accepts a `groupId` and its own
 * `includePacks`, so it may return group-level alerts alongside the Pack's own; the caller
 * deduplicates against the group-level read by id rather than assuming it does not.
 */
export function fetchPackNotifications(
  group: string,
  pack: string,
  signal?: AbortSignal,
): Promise<RawNotification[]> {
  return fetchAllUnique<RawNotification>(packNotificationsPath(group, pack), idOf, { signal });
}

export interface NotificationTarget {
  id: string;
  type: string;
}

export async function fetchNotificationTargets(signal?: AbortSignal): Promise<NotificationTarget[]> {
  const raw = await fetchAllUnique<{ id?: unknown; type?: unknown }>(
    '/notification-targets',
    idOf,
    { signal },
  );
  return raw.flatMap((entry) => {
    const id = idOf(entry);
    return id ? [{ id, type: typeof entry.type === 'string' ? entry.type : 'unknown' }] : [];
  });
}

/**
 * Create one Notification.
 *
 * Called only after the admin confirms the preview, and only one at a time — bulk
 * apply drives this sequentially so a mid-run failure leaves a knowable state and the
 * per-item results are honest about which ones landed.
 */
export function createNotification(
  payload: NotificationPayload,
  signal?: AbortSignal,
): Promise<unknown> {
  return apiPost<unknown>('/notifications', payload, { signal });
}

/**
 * Create one Notification **inside a Pack**.
 *
 * Same schema, same payload builder, different collection — a Pack's feeds are only addressable
 * from inside the Pack, so a group-level Notification naming one in `conf.name` would name a feed
 * the group does not have. This is the only mechanism offered for a Pack feed; see `planItem`.
 */
export function createPackNotification(
  group: string,
  pack: string,
  payload: NotificationPayload,
  signal?: AbortSignal,
): Promise<unknown> {
  return apiPost<unknown>(packNotificationsPath(group, pack), payload, { signal });
}

export type BridgeWriteVerb = 'created' | 'existed';

/**
 * Create the Notification that carries a monitor's output into the notification system.
 *
 * Separate from `createNotification` because it is a different object: no `group`, no
 * `conf.name`, `condition: "monitor-alerts"` and `mode: "policy"` — copied field for field
 * from what Cribl's own Insights UI posts.
 *
 * An id that already exists reports `existed` rather than failing. The bridge is keyed to one
 * monitor, so an existing one is already routing exactly this monitor: that is the desired end
 * state, and calling it a failure would send an admin to fix something that is not broken.
 */
export async function createMonitorBridge(
  payload: BridgeNotificationPayload,
  signal?: AbortSignal,
): Promise<BridgeWriteVerb> {
  try {
    await apiPost<unknown>('/notifications', payload, { signal });
    return 'created';
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 409 || (status === 400 && /exist/i.test((error as Error).message))) return 'existed';
    throw error;
  }
}

/**
 * Deep link to where a Notification is configured in the native Cribl UI.
 *
 * This is the group's Notifications page — the screen the alert is edited on. It is
 * deliberately **not** suffixed with the alert id: no per-notification route is documented
 * in `openapi.json` or confirmed against a running org, and a guessed URL that lands on a
 * 404 is worse than a working one that needs a click. The app pairs this with an inline
 * view of the alert's real stored configuration, which needs no route at all.
 *
 * A Pack notification gets the **same** link, deliberately, and is told in words that it lives
 * inside its Pack. No Pack-scoped Notifications route has been observed live, and the rule holds
 * in both directions: an unobserved deep link is not improved by being more specific.
 */
export function notificationUrl(group: string | null): string {
  return group
    ? `/manage/groups/${encodeURIComponent(group)}/notifications`
    : '/manage/notifications';
}
