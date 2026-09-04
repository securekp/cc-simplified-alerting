/**
 * Building the write payload.
 *
 * Kept pure and separate from the API layer so the mandatory preview renders exactly
 * the object that would be sent — the preview promises the admin "the exact condition",
 * and the only way to keep that promise is to show the real payload.
 *
 * There is one mechanism: `POST /notifications` on a condition discovered from
 * `GET /conditions`. The alert-monitor path this file used to also build was removed
 * deliberately — see the note at the bottom.
 */

import { buildRouting, type RoutingSettings, type TemplateTargetPair } from './routing.ts';
import type { Feed } from './types.ts';

export const ALERT_ID_PREFIX = 'csa';

/**
 * Namespaces this app used under earlier names, still accepted as authorship evidence.
 *
 * The app was renamed; the alerts it already created were not. An id namespace is only useful
 * because it is reserved, and abandoning the old one would make every alert created before the
 * rename read as `(owner unknown)` on the coverage table — a visible regression in the one place
 * the admin looks to decide whether to touch an alert. New ids use the current prefix only.
 */
const LEGACY_ALERT_ID_PREFIXES = ['ally'] as const;

/** Cribl object ids are conservative; feed ids are not (colons, dots, slashes). */
export function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * The id for a per-feed Notification.
 *
 * The Pack segment is appended only for a feed inside a Pack, so every id this app has already
 * created keeps its exact spelling — the registry is keyed on these strings, and re-spelling them
 * would make every existing alert read as unmanaged. It has to be there for Pack feeds, though:
 * a Pack and its group can each hold a Source called `palo_traffic`, and one id for both would
 * make the second write an edit of the first.
 */
export function alertId(feed: Feed): string {
  const scope = feed.pack ? `${sanitizeIdPart(feed.group)}-${sanitizeIdPart(feed.pack)}` : sanitizeIdPart(feed.group);
  return `${ALERT_ID_PREFIX}-${scope}-${sanitizeIdPart(feed.id)}`.slice(0, 100);
}

/**
 * Is this id one this app minted?
 *
 * `csa-` is the app's reserved id namespace and `ally-` was the one it used before the rename.
 * Every alert it has ever created is inside one of them — including ids from earlier builds that
 * carried a mechanism segment (`ally-thru-default-ZscalerWeb`, `ally-conn-…`), which is why this
 * matches the prefix rather than the current `{prefix}-{group}-{feed}` shape.
 *
 * This is a **fallback for the label only**, used when the KV registry has no entry. It is
 * not ownership inference by name: the id is not user-chosen prose, it is a string this
 * app generated. It never feeds coverage counting, and an alert recognised this way is
 * labelled differently from one the registry confirms.
 */
export function isAppAlertId(id: string): boolean {
  // `monitor-{prefix}-…` is the bridge Notification Cribl's own convention gives a monitor this
  // app created, so it is just as much ours as the object it routes.
  return [ALERT_ID_PREFIX, ...LEGACY_ALERT_ID_PREFIXES].some(
    (prefix) => id.startsWith(`${prefix}-`) || id.startsWith(`monitor-${prefix}-`),
  );
}

export interface NotificationPayload {
  id: string;
  condition: string;
  /** Notifications are group-scoped by this field. */
  group: string;
  targets: string[];
  /**
   * How this alert is delivered, when the admin chose a route that needs saying.
   *
   * Both are optional because all three states are real and distinct: `"policy"` with empty
   * targets, `"direct"` with at least one template/target pair, and neither field at all with a
   * bare `targets` list. `lib/routing.ts` owns which one is produced and why.
   */
  mode?: 'policy' | 'direct';
  templateTargetPairs?: TemplateTargetPair[];
  /** Note the sense: a Notification is created off by setting `disabled`, not `enabled`. */
  disabled: boolean;
  conf: Record<string, unknown>;
}

export interface AlertOptions {
  conditionId: string;
  /**
   * Values for the condition's own `conf` fields, collected from a form generated
   * from its JSON Schema. Field names come from that schema, never from a constant
   * here, so a renamed field in a future Cribl version does not silently drop.
   */
  conf: Record<string, unknown>;
  /**
   * The admin's delivery choice: a notification policy, or targets with an optional template
   * each. Passed as the settings rather than as finished fields so the one place that turns a
   * choice into `mode` / `targets` / `templateTargetPairs` is `buildRouting`.
   */
  routing: RoutingSettings;
  createDisabled: boolean;
}

/**
 * The one write this app makes.
 *
 * Works for either direction and either signal, because the shape does not vary: a
 * Source lands on `no-data`/`low-volume`, a Destination on `unhealthy-dest`, and both are
 * the same object with a different `condition` and a different `conf`. That is precisely
 * why the app no longer needs two engines.
 */
export function buildNotification(feed: Feed, options: AlertOptions): NotificationPayload {
  return {
    id: alertId(feed),
    condition: options.conditionId,
    group: feed.group,
    // `targets`, and `mode`/`templateTargetPairs` only where the choice needs them.
    ...buildRouting(options.routing),
    disabled: options.createDisabled,
    // `conf.name` is pinned to the feed and never taken from the template: every
    // per-feed condition marks `name` required, and Cribl's own uischema renders it
    // `ui:disabled` with `default: "${IO_ID}"`.
    conf: { ...options.conf, name: feed.id },
  };
}

/*
 * Why the monitor builder is not in this file.
 *
 * There are two mechanisms — a Notification on a discovered condition, which is this file, and
 * an Insights monitor, which is `lib/monitorPayload.ts`. They are separate modules because they
 * are separate objects with separate failure modes: a Notification's fields come from a JSON
 * Schema the platform published, while a monitor's do not exist in `openapi.json` at all
 * (`MonitorConf.rules[]` resolves to `$ref: Function`, a pipeline-function schema) and were
 * recovered from a HAR capture of Cribl's own Insights UI.
 *
 * A monitor is also two writes rather than one, and its query is copied verbatim from a shipped
 * monitor rather than composed. Nothing in this file needs any of that, and nothing here should
 * grow it: a Notification depends on no metric name and no monitor engine, which is why it keeps
 * working when the monitor mechanism is unavailable.
 */
