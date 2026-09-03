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
 */
export function notificationUrl(group: string | null): string {
  return group
    ? `/manage/groups/${encodeURIComponent(group)}/notifications`
    : '/manage/notifications';
}
