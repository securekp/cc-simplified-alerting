/**
 * Reading what an alert can be delivered *with*.
 *
 * There are two ways Cribl routes a notification, and the admin picks between them: a
 * notification **policy**, which matches alerts and delivers them without the alert naming
 * anything, or an explicit **target** paired with a **template** that renders the message for
 * that target's type. This app creates neither object — it only reads them, so it can offer a
 * choice that exists on this deployment rather than one that sounds plausible.
 *
 * Neither path is in `openapi.json`, and both answered 200 on the verification org (HAR
 * capture, 2026-09-02):
 *
 * - `/notification-templates?engine=handlebars` returned the four templates Cribl ships
 *   (`default-email`/smtp, `default-sns`/sns, `default-slack`/slack,
 *   `default-pagerduty`/pager_duty). The `engine` parameter is sent because that is the only
 *   form observed to work; every one of those templates renders monitor-alert fields
 *   (`monitor_name`, `labels.severity`, `status`), which is what they are for.
 * - `/notification-policies` returned `{"items":[],"count":0}` — the endpoint exists, that org
 *   simply has none. That is exactly the state the routing choice exists for: policy mode on a
 *   deployment with no policy produces an alert that fires and delivers nothing.
 *
 * So both are probed like every other route, and the absence of either costs one routing
 * option rather than the app.
 */

import { fetchAllPages, fetchAllUnique } from './client.ts';

/**
 * A message template, and the target type it renders for.
 *
 * `type` matters: a template is paired with a target in `templateTargetPairs`, and pairing a
 * `slack` template with an `smtp` target would produce a delivery Cribl cannot render.
 */
export interface NotificationTemplate {
  id: string;
  /** `smtp` | `sns` | `slack` | `pager_duty`, matched against a target's own `type`. */
  type: string;
  description?: string;
}

function idOf(item: { id?: unknown }): string | null {
  return typeof item.id === 'string' && item.id ? item.id : null;
}

export async function fetchNotificationTemplates(
  signal?: AbortSignal,
): Promise<NotificationTemplate[]> {
  const raw = await fetchAllUnique<{ id?: unknown; type?: unknown; description?: unknown }>(
    '/notification-templates',
    idOf,
    { signal, query: { engine: 'handlebars' } },
  );
  return raw.flatMap((entry) => {
    const id = idOf(entry);
    if (!id) return [];
    return [
      {
        id,
        // Not defaulted to a real type. An unreadable type is not evidence of a mismatch, and
        // `templatesForTarget` treats `unknown` as pairable with anything rather than hiding
        // the template — see the note there.
        type: typeof entry.type === 'string' && entry.type ? entry.type : 'unknown',
        description: typeof entry.description === 'string' ? entry.description : undefined,
      },
    ];
  });
}

/**
 * How many notification policies exist.
 *
 * The count, not the objects: nothing in this app inspects a policy's matchers, and claiming
 * to know which policy would carry a given alert would be a guess about routing this app does
 * not own. Zero is the fact that matters — it means policy mode delivers nowhere yet.
 *
 * Counted from the raw items rather than through `fetchAllUnique`, because a policy without an
 * `id` field would be dropped by the dedupe key and read back as "no policies", which is the
 * one answer that would mislead the admin into the wrong choice.
 */
export async function fetchNotificationPolicyCount(signal?: AbortSignal): Promise<number> {
  const items = await fetchAllPages<unknown>('/notification-policies', { signal });
  return items.length;
}
