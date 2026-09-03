/**
 * Creating the alerts, one at a time.
 *
 * Sequential on purpose. Bulk apply will partially fail — a denied write, an id
 * collision, a condition that rejects a `conf` value — and the admin has to be able to
 * see exactly which items landed and retry only those. Firing twenty concurrent writes
 * and reporting an aggregate would destroy that.
 *
 * Nothing here runs on mount, on render, or on a timer. `run()` is called from the
 * confirm button in the preview step and nowhere else.
 */

import { useCallback, useRef, useState } from 'react';
import { ApiError, describeError } from '../api/client.ts';
import { createMonitorBridge, createNotification, notificationUrl } from '../api/alerts.ts';
import { monitorUrl, upsertMonitor } from '../api/monitors.ts';
import { saveRegistryEntry } from '../api/kv.ts';
import type { PlannedAlert, PlannedWrite } from '../lib/plan.ts';

export type ApplyStatus = 'created' | 'failed' | 'skipped' | 'blocked';

export interface ApplyOutcome {
  key: string;
  status: ApplyStatus;
  message: string;
  /** Deep link into the native Cribl UI. Present only on `created`. */
  url?: string;
  /**
   * The object(s) actually written, kept so the results list can show the created alert's
   * configuration without a second read. This is what answers the admin's "what did I just
   * create?" immediately after apply. A monitor write shows both of its objects.
   */
  config?: Record<string, unknown>;
  /** True when the alert was created but its registry entry was not written. */
  registryFailed?: boolean;
  /**
   * The object exists and will fire, but something alongside it did not land — a monitor
   * whose routing Notification failed. Distinct from `failed`, because telling an admin the
   * alert was not created when it was would send them to create a duplicate.
   */
  partial?: boolean;
}

/** What one write produced, before the registry entry and the outcome are recorded. */
interface WriteResult {
  /** The id the registry entry is keyed on: the Notification id, or the monitor id. */
  id: string;
  message: string;
  url: string;
  config: Record<string, unknown>;
  partial: boolean;
}

/**
 * Perform one planned write.
 *
 * A monitor is two objects and they are written in this order deliberately: the monitor is the
 * thing that evaluates, so if the bridge fails afterwards the admin has an alert that fires and
 * charts in Insights but delivers nowhere — a real, recoverable state that gets said out loud.
 * The reverse order would leave a routing object attached to nothing.
 */
async function performWrite(write: PlannedWrite, signal: AbortSignal): Promise<WriteResult> {
  if (write.kind === 'notification') {
    const payload = write.notification;
    await createNotification(payload, signal);
    return {
      id: payload.id,
      message: 'Created.',
      url: notificationUrl(payload.group),
      config: { ...payload },
      partial: false,
    };
  }

  const result = await upsertMonitor(write.hostGroup, write.monitor, signal);
  let message =
    result.verb === 'updated'
      ? `An Insights monitor with this id already existed in "${write.hostGroup}" and was updated to watch this feed.`
      : `Created as an Insights monitor in "${write.hostGroup}".`;
  let partial = false;
  try {
    const bridge = await createMonitorBridge(write.bridge, signal);
    if (bridge === 'existed') message += ' Its routing notification already existed.';
  } catch (error) {
    // Not a failure of the alert: the monitor is there and will evaluate. But it is also not
    // a clean success, and an admin who is told "Created." would never go and fix this.
    partial = true;
    message +=
      ` The monitor exists and will appear on the Insights alerts page, but the notification that` +
      ` routes its output could not be created (${describeError(error)}), so nothing is delivered` +
      ' from it yet.';
    console.error(`[cc-simplified-alerting] bridge notification failed for ${write.monitor.id}:`, error);
  }

  return {
    id: write.monitor.id,
    message,
    // The monitor's own edit screen, not the activity list: the admin has just created this
    // object and the next thing they want is to look at it.
    url: monitorUrl(write.monitor.id),
    // Both objects, because both are the alert. Showing only the monitor would hide the half
    // that decides whether anyone hears about it.
    config: { monitor: { ...write.monitor }, routingNotification: { ...write.bridge } },
    partial,
  };
}

export interface ApplyState {
  running: boolean;
  /** True once a run has finished, so the drawer can show results instead of the form. */
  finished: boolean;
  outcomes: Map<string, ApplyOutcome>;
  /** Key of the item being written right now. */
  current: string | null;
  completed: number;
  total: number;
  /**
   * Set when a write returned 401/403 mid-run.
   *
   * One flag, not one per mechanism: a bulk run uses whichever mechanism the template chose,
   * so the first denial answers for every remaining item in *this* run. The reason quotes the
   * failure verbatim rather than naming a route, so it stays true for either mechanism.
   */
  writeDenied: string | null;
  run: (plan: readonly PlannedAlert[]) => Promise<void>;
  reset: () => void;
  cancel: () => void;
}

export function useApply(): ApplyState {
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [outcomes, setOutcomes] = useState<Map<string, ApplyOutcome>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [writeDenied, setWriteDenied] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setOutcomes(new Map());
    setCurrent(null);
    setCompleted(0);
    setTotal(0);
    setFinished(false);
    setWriteDenied(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async (plan: readonly PlannedAlert[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setFinished(false);
    setCurrent(null);
    setCompleted(0);
    setTotal(plan.length);

    const record = (outcome: ApplyOutcome) => {
      setOutcomes((previous) => new Map(previous).set(outcome.key, outcome));
    };

    // Local, not state: state updates are async and this has to gate the very next
    // iteration of the loop, not the next render.
    //
    // Keyed by mechanism, because a run can legitimately mix them — Sources on a monitor,
    // Destinations on a Notification. A denied monitor write says nothing about whether
    // Notifications are permitted, and blocking those too would report items as impossible
    // when they were never attempted.
    const denied = new Map<PlannedAlert['mechanism'], string>();

    try {
      for (const item of plan) {
        if (controller.signal.aborted) break;

        if (item.skipped) {
          record({ key: item.key, status: 'skipped', message: item.skipped });
          setCompleted((value) => value + 1);
          continue;
        }
        if (item.blocked || !item.write) {
          record({
            key: item.key,
            status: 'blocked',
            message: item.blocked ?? 'No payload could be built for this alert.',
          });
          setCompleted((value) => value + 1);
          continue;
        }
        const alreadyDenied = denied.get(item.mechanism);
        if (alreadyDenied) {
          // Don't keep writing into a wall — one denial answers for the rest of that mechanism.
          record({ key: item.key, status: 'blocked', message: alreadyDenied });
          setCompleted((value) => value + 1);
          continue;
        }

        setCurrent(item.key);
        const write = item.write;
        try {
          const result = await performWrite(write, controller.signal);

          // The registry is what lets one coverage column answer "is this watched?"
          // without inferring ownership from a name. A failed write is reported, not
          // swallowed, but it does not turn a created alert into a failure.
          let registryFailed = false;
          try {
            await saveRegistryEntry(
              {
                id: result.id,
                signal: item.signal,
                group: item.group,
                direction: item.direction,
                feedId: item.feedId,
                settings:
                  write.kind === 'monitor'
                    ? {
                        label: item.label,
                        mechanism: 'monitor',
                        hostGroup: write.hostGroup,
                        templateId: write.templateId,
                        bridge: write.bridge.id,
                      }
                    : {
                        label: item.label,
                        mechanism: 'notification',
                        condition: write.notification.condition,
                      },
              },
              controller.signal,
            );
          } catch (error) {
            registryFailed = true;
            console.warn(`[cc-simplified-alerting] registry write failed for ${result.id}:`, error);
          }

          record({
            key: item.key,
            status: 'created',
            message: registryFailed
              ? `${result.message} This app could not record that it owns it, so it may show as unmanaged.`
              : result.message,
            url: result.url,
            config: result.config,
            registryFailed,
            partial: result.partial,
          });
        } catch (error) {
          const message = describeError(error);
          if (error instanceof ApiError && error.isDenied) {
            const reason =
              `The write was denied (${message}). No further ${item.mechanism === 'monitor' ? 'Insights monitor' : 'notification'} ` +
              'can be created with this account; the coverage table below is still accurate.';
            denied.set(item.mechanism, reason);
            setWriteDenied(reason);
            record({ key: item.key, status: 'blocked', message: reason });
          } else {
            console.error(`[cc-simplified-alerting] create failed for ${item.key}:`, error);
            record({ key: item.key, status: 'failed', message });
          }
        } finally {
          setCompleted((value) => value + 1);
        }
      }
    } finally {
      setCurrent(null);
      setRunning(false);
      setFinished(true);
      abortRef.current = null;
    }
  }, []);

  return {
    running,
    finished,
    outcomes,
    current,
    completed,
    total,
    writeDenied,
    run,
    reset,
    cancel,
  };
}

/** The items worth retrying: the ones that failed for a reason that might not repeat. */
export function retryablePlan(
  plan: readonly PlannedAlert[],
  outcomes: ReadonlyMap<string, ApplyOutcome>,
): PlannedAlert[] {
  return plan.filter((item) => outcomes.get(item.key)?.status === 'failed');
}
