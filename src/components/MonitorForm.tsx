import { Alert, NumberField, SelectField, Text } from '@capra/core';
import type { Monitor } from '../api/monitors.ts';
import type { MonitorSettings } from '../lib/plan.ts';
import type { MonitorConditionType, Severity } from '../lib/monitorPayload.ts';

export interface MonitorFormProps {
  /** Shipped monitors whose query can be copied, best first. */
  templates: readonly Monitor[];
  settings: MonitorSettings;
  onChange: (settings: MonitorSettings) => void;
}

const CONDITION_LABELS: Record<MonitorConditionType, string> = {
  less_than: 'below the threshold (a feed that stopped delivering)',
  greater_than: 'above the threshold (a spike)',
  equal: 'exactly at the threshold',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'critical',
  warning: 'warning',
  info: 'info',
};

/**
 * The monitor's settings.
 *
 * Hand-built, unlike `ConditionForm`. There is no JSON Schema for a monitor to generate a form
 * from — `openapi.json`'s `MonitorConf.rules[]` resolves to a pipeline-function schema — so
 * these fields and their meanings come from monitors read live off a running deployment. The
 * one thing deliberately **not** offered is the query: it is copied verbatim from the shipped
 * monitor chosen below, because a hand-authored PromQL expression that matches no series would
 * produce a monitor that never fires, which is worse than no monitor at all.
 */
export function MonitorForm({ templates, settings, onChange }: MonitorFormProps) {
  const chosen = settings.templateId
    ? templates.find((item) => item.id === settings.templateId)
    : templates[0];
  const set = <K extends keyof MonitorSettings>(key: K, value: MonitorSettings[K]) =>
    onChange({ ...settings, [key]: value });

  if (templates.length === 0) {
    return (
      <Alert appearance="warning" title="No monitor here measures this direction" layout="inline">
        This app copies a monitor&rsquo;s query from one Cribl ships rather than composing PromQL
        itself, and none of the monitors on this deployment measures throughput for this direction.
        These feeds are listed as blocked in the review step and nothing is created for them.
      </Alert>
    );
  }

  return (
    <div className="form-stack">
      <SelectField
        label="Metric to watch"
        items={templates.map((item) => ({
          id: item.id,
          label: `${item.name ?? item.id} (${item.id})`,
        }))}
        value={chosen?.id}
        helperText="The query is copied from this monitor exactly as Cribl ships it; only the threshold and the feed it is scoped to change."
        onChange={(key) => set('templateId', key === null ? null : String(key))}
      />
      {chosen ? (
        <pre className="payload">{chosen.query}</pre>
      ) : (
        <Alert appearance="warning" layout="inline">
          The monitor this template names is no longer on the deployment, so nothing will be created
          until another is chosen.
        </Alert>
      )}

      <SelectField
        label="Fire when the value is"
        items={(Object.keys(CONDITION_LABELS) as MonitorConditionType[]).map((type) => ({
          id: type,
          label: CONDITION_LABELS[type],
        }))}
        value={settings.conditionType}
        onChange={(key) => (key === null ? undefined : set('conditionType', key as MonitorConditionType))}
      />

      <NumberField
        label="Threshold"
        value={settings.threshold}
        min={0}
        helperText="In the unit of the query above. The default of 1 means “anything at all”, which is what a stopped feed fails."
        onChange={(next) => set('threshold', next)}
      />

      <NumberField
        label="Must hold for (seconds)"
        value={settings.firingAfter}
        min={0}
        helperText="How long the condition has to stay true before the alert fires. This is the anti-flap window; a bursty feed needs a longer one."
        onChange={(next) => set('firingAfter', next)}
      />

      <NumberField
        label="Recovers after (seconds)"
        value={settings.okAfter}
        min={0}
        helperText="How long it has to look healthy again before the alert clears."
        onChange={(next) => set('okAfter', next)}
      />

      <NumberField
        label="Evaluated every (seconds)"
        value={settings.scheduleIntervalSeconds}
        min={0}
        helperText="How often Cribl runs the query."
        onChange={(next) => set('scheduleIntervalSeconds', next)}
      />

      <SelectField
        label="Severity"
        items={(Object.keys(SEVERITY_LABELS) as Severity[]).map((severity) => ({
          id: severity,
          label: SEVERITY_LABELS[severity],
        }))}
        value={settings.severity}
        onChange={(key) => (key === null ? undefined : set('severity', key as Severity))}
      />

      <Text variant="body-xs-normal" color="subtle" as="p">
        Monitor alerts are delivered by Cribl&rsquo;s notification policies, not by the targets
        above. With no policy configured, the alert appears and fires on the Insights alerts page
        but sends nothing — this app does not create policies.
      </Text>
    </div>
  );
}
