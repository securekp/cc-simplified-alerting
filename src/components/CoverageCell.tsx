import { Tag, Text } from '@capra/core';
import { ownershipSuffix } from '../lib/attribution.ts';
import { truncate } from '../lib/format.ts';
import { policyGap } from '../lib/routing.ts';
import type { AttributedAlert } from '../lib/types.ts';

export interface CoverageCellProps {
  alerts: readonly AttributedAlert[];
  /**
   * Alerts on this feed that watch something else — backpressure, queue usage.
   *
   * Shown, because an admin who set one up will look for it here, but visibly separated
   * and never counted as coverage: none of them detects a feed that stopped delivering.
   */
  other: readonly AttributedAlert[];
  /** What to say when there are none — phrased for the specific gap. */
  emptyLabel: string;
  /**
   * How many notification policies exist, or `null` when that could not be read.
   *
   * On the chip for the same reason `(not routed)` is: an alert that routes by policy where the
   * deployment has none delivers nothing, and that was true of four app-created alerts on the
   * verification org while this table showed them as plain coverage.
   */
  policyCount: number | null;
  /** Opens the alert's configuration. Every tag is a button, not decoration. */
  onOpen: (alert: AttributedAlert) => void;
}

/**
 * The coverage cell.
 *
 * Two things it must never do: imply coverage that is not there, and hide what the
 * alert actually watches. A disabled alert is shown, but labelled disabled and not
 * counted as coverage anywhere else in the app.
 *
 * Each tag opens that alert's configuration. An admin who has just created twelve alerts
 * needs to be able to see what one of them says without leaving the table and hunting
 * for it by id in Cribl's own list.
 */
export function CoverageCell({
  alerts,
  other,
  emptyLabel,
  policyCount,
  onOpen,
}: CoverageCellProps) {
  const chip = (alert: AttributedAlert, coverage: boolean) => {
    const created = alert.ownership === 'registry' || alert.ownership === 'id';
    // An alert that fires but delivers nowhere is not the same thing as coverage the admin can
    // rely on, so it says so on the chip rather than only inside the configuration view. Two
    // distinct ways of getting there: no routing object at all, or a routing object that names a
    // notification policy on a deployment that has none.
    const routingGap =
      (alert.mechanism === 'monitor' && alert.routed === false) ||
      policyGap(alert.mechanism === 'monitor' ? alert.bridgeConfig : alert.config, policyCount) !==
        null;
    const qualifier = alert.disabled
      ? ' (disabled)'
      : routingGap
        ? ' (not routed)'
        : ownershipSuffix(alert.ownership);
    return (
      <button
        key={alert.id}
        type="button"
        className="alert-chip"
        onClick={() => onOpen(alert)}
        title={`View the configuration of "${alert.id}"`}
      >
        <Tag size="sm" color={!coverage || alert.disabled ? 'default' : created ? 'criblTeal' : 'info'}>
          {truncate(
            `${alert.mechanism === 'monitor' ? 'Monitor · ' : ''}${
              alert.conditionName ?? alert.conditionId
            }: ${alert.id}${qualifier}`,
            48,
          )}
        </Tag>
      </button>
    );
  };

  return (
    <span className="cell-stack">
      {alerts.length === 0 ? (
        <Text variant="body-xs-normal" color="subtle">
          {emptyLabel}
        </Text>
      ) : (
        <span className="cell-tags">{alerts.map((alert) => chip(alert, true))}</span>
      )}
      {other.length > 0 ? (
        <>
          <Text variant="body-xs-normal" color="subtle">
            Also on this feed, but not watching for a delivery stop:
          </Text>
          <span className="cell-tags">{other.map((alert) => chip(alert, false))}</span>
        </>
      ) : null}
    </span>
  );
}
