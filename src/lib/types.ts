/** Shared domain types. Kept free of React and of `fetch` so they stay unit-testable. */

export type Direction = 'source' | 'destination';

export type Health = 'Green' | 'Yellow' | 'Red' | 'Unknown';

/**
 * What a condition actually watches.
 *
 * This is a **label**, not a routing decision. The app has one intent — "this feed is not
 * delivering data" — and both signals satisfy it: a Source proves it with `no-data`, a
 * Destination with `unhealthy-dest`, because those are what the live catalogue offers for
 * each direction. What the distinction is still for is honesty in the UI (the admin can
 * see which signal is doing the watching) and exclusion: anything this cannot place is
 * `unclassified` and counts as coverage for nothing.
 */
export type Signal = 'health' | 'volume' | 'unclassified';

export interface WorkerGroup {
  id: string;
  name: string;
  /**
   * As reported by `/master/groups`, and **not used to decide anything.**
   *
   * It read `0` live for a group that demonstrably had Workers running, so it does not
   * reliably mean "no Workers here". It is parsed faithfully (`null` when absent, as on
   * `defaultHybrid`) and deliberately never shown in the group selector — a field that can
   * be wrong must not block a write or be quoted at the admin as a fact.
   */
  workerCount: number | null;
}

/** One enabled Source or Destination in one worker group. */
export interface Feed {
  /**
   * Stable row key: direction + group + pack + id.
   *
   * The pack segment is load-bearing, not decoration: a feed id is only unique inside its own
   * scope, so a Pack and its group can both hold a Source called `palo_traffic` and a key
   * without the pack would collapse the two rows into one.
   */
  rowId: string;
  id: string;
  type: string;
  group: string;
  direction: Direction;
  /**
   * The Pack this feed lives inside, or `null` for a group-level feed.
   *
   * A Pack feed has **no row** in `/m/:gid/system/{inputs,outputs}` — it is only reachable at
   * `/m/:gid/p/:pack/system/…` — which is why an earlier build showed a table that read as
   * complete while a Pack carrying real traffic was entirely absent from it.
   *
   * It changes *where* an alert is written, never which alert is available: a Notification goes to
   * the Pack's own collection and both ids carry a Pack segment, but the mechanism is the admin's
   * choice exactly as it is for a group feed. See `mechanismFor` in `lib/plan.ts`.
   */
  pack: string | null;
  /**
   * The metric-store dimension value for this feed: `` `${type}:${id}` ``, or
   * `` `${type}:${pack}.${id}` `` for a feed inside a Pack.
   * Always constructed from the config object and compared for exact equality —
   * never produced by splitting a dimension value apart, because ids can contain
   * colons of their own (`syslog:in_syslog:udp` is type `syslog`, id `in_syslog`).
   */
  metricKey: string;
  health: Health;
  /** `false` when `status.health` was absent entirely — Unknown, not healthy. */
  healthKnown: boolean;
  /** `status.error.message`. A feed can be Green *and* carry one. */
  errorMessage: string | null;
}

/**
 * How confident the app is that it created a given alert.
 *
 * Deliberately four states rather than a boolean. The KV registry is the authoritative
 * record, but it is also the most fragile thing in the app: if it cannot be listed, a
 * boolean collapses "we know this is not ours" into "we could not find out" and the
 * configuration view ends up flatly telling an admin that an alert they watched this app
 * create was not created by this app.
 *
 * - `registry`  — a registry entry exists. Certain.
 * - `id`        — no entry, but the id is in this app's reserved `csa-` namespace (or `ally-`,
 *                 the one it used before the rename), which
 *                 only this app mints. Near-certain; said so with its own wording.
 * - `external`  — the registry was readable, has no entry, and the id is not ours.
 * - `unknown`   — the registry could not be read at all, so ownership is not knowable.
 */
export type Ownership = 'registry' | 'id' | 'external' | 'unknown';

/**
 * Which of the two write mechanisms an alert is.
 *
 * `notification` — a Notification on a condition from `GET /conditions`.
 * `monitor` — an Insights monitor at `/m/{gid}/alert/monitors/{id}`, which is what appears on
 * the Insights alerts page with a chart and an Activity trail.
 */
export type Mechanism = 'notification' | 'monitor';

/** An alert that exists in Cribl and is attributed to exactly one feed. */
export interface AttributedAlert {
  id: string;
  mechanism: Mechanism;
  signal: Signal;
  /** The condition id it fires on, for the label and for opening its configuration. */
  conditionId: string;
  /** Display name of the condition, when the catalogue had one. */
  conditionName: string | null;
  /** Human-readable summary of what it watches, shown in the coverage cell. */
  summary: string;
  /** Whether this app created it, and on what evidence. Display only — never coverage. */
  ownership: Ownership;
  disabled: boolean;
  rowId: string;
  /** Worker group the alert is scoped to, for the deep link. */
  group: string | null;
  /**
   * The Pack the alert lives inside, or `null` for a group-level one.
   *
   * Read from *where the alert was found*, not from anything on the object: a Notification
   * carries a bare `conf.name` and nothing that names a Pack, so the only trustworthy answer is
   * which collection returned it. It is on the alert because the configuration view has to say
   * where the admin will find it — a Pack notification is not on the group's Notifications page.
   */
  pack?: string | null;
  /**
   * Monitors only: the group whose `/m/{gid}/alert/monitors` collection holds this object.
   *
   * Distinct from `group` on purpose — a monitor watching a feed in `default` was observed
   * living in `default_search`, so conflating the two would produce a broken read-back path.
   */
  hostGroup?: string;
  /** Monitors only: whether a Notification exists to route this monitor's output anywhere. */
  routed?: boolean;
  /**
   * Monitors only: the bridge Notification as stored, when one exists.
   *
   * Kept because *where* a monitor delivers is now the admin's choice — a policy, or named
   * targets — and that choice lives on the bridge, not on the monitor. Without the real object
   * the configuration view could only repeat the assumption the app was built with, which is
   * exactly the kind of claim this screen exists to replace with a fact.
   */
  bridgeConfig?: Record<string, unknown>;
  /**
   * The stored object as Cribl returned it.
   *
   * Retained so clicking the alert can show its **real** configuration rather than a
   * reconstruction of it. The app never guesses at a per-alert UI route, so this inline
   * view is what answers "what did I actually create?".
   */
  config: Record<string, unknown>;
}

/** An alert we found but deliberately refuse to attribute. Never guessed at. */
export interface UnattributedAlert {
  id: string;
  reason: string;
}

export interface FeedCoverage {
  /** Alerts that count as watching this feed for a delivery stop. */
  alerts: AttributedAlert[];
  /**
   * Attributed, but watching something this app does not treat as delivery coverage —
   * `backpressure-dest`, `persistent-queue-usage`, and anything else unclassified. Shown
   * so they are not invisible, counted so they are not mistaken for coverage.
   */
  other: AttributedAlert[];
}

/** JSON Schema fragment as returned inside a Notification condition. */
export interface ConditionField {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  /** Cribl extension: `{ min: '60s' }` on duration strings. */
  duration?: { min?: string; max?: string };
}

export interface ConditionSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ConditionField>;
}

export interface NotificationCondition {
  id: string;
  name: string;
  /** Cribl's own prose for what this condition watches, when it supplies any. */
  description?: string;
  /** `sources` | `destinations` | … — the only trustworthy direction signal. */
  category?: string;
  /** `metric` for volume-style conditions. Never used to classify — see `Signal`. */
  type?: string;
  schema?: ConditionSchema;
}

/** A record in the app's KV registry of alerts it created. */
export interface ManagedRecord {
  id: string;
  signal: Signal;
  group: string;
  direction: Direction;
  feedId: string;
  /** Snapshot of the template settings used, for the drift/tuning workflows. */
  settings: Record<string, unknown>;
  createdAt: number;
}

/** Whether one capability is usable, and if not, what to tell the admin. */
export interface Capability {
  available: boolean;
  reason?: string;
}

export const CAPABLE: Capability = { available: true };

export function blocked(reason: string): Capability {
  return { available: false, reason };
}
