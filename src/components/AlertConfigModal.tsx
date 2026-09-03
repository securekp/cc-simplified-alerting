import { Alert, ButtonLink, Divider, Modal, Tag, Text } from '@capra/core';
import { ArrowUpRightFromSquare } from '@capra/icons';
import { notificationUrl } from '../api/alerts.ts';
import { monitorUrl } from '../api/monitors.ts';
import { ownershipDetail, ownershipLabel } from '../lib/attribution.ts';
import { describeRouting, policyGap } from '../lib/routing.ts';
import { formFields } from '../lib/conditionForm.ts';
import type { AttributedAlert, NotificationCondition } from '../lib/types.ts';

export interface AlertConfigModalProps {
  alert: AttributedAlert | null;
  conditionsById: ReadonlyMap<string, NotificationCondition>;
  /**
   * How many notification policies exist, or `null` when that could not be read.
   *
   * Read here for one reason: a policy-routed alert on a deployment with **zero** policies fires
   * and delivers nothing, and this screen is where an admin comes to find out why an alert they
   * created never reached them. `describeRouting` alone cannot say it — the route is on the
   * object, the count is not — so the two are combined here and nowhere else.
   */
  policyCount: number | null;
  onClose: () => void;
}

/** Render a stored value the way the admin typed it, not the way JSON prints it. */
function displayValue(value: unknown): string {
  if (value === undefined || value === null) return 'not set';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length > 0 ? value.map(displayValue).join(', ') : 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface Line {
  key: string;
  label: string;
  description?: string;
  value: string;
}

function Lines({ lines }: { lines: readonly Line[] }) {
  return (
    <dl className="config-list">
      {lines.map((line) => (
        <div className="config-row" key={line.key}>
          <dt>
            <Text variant="body-sm-semibold">{line.label}</Text>
            {line.description ? (
              <Text variant="body-xs-normal" color="subtle">
                {line.description}
              </Text>
            ) : null}
          </dt>
          <dd>
            <Text variant="body-sm-normal">{line.value}</Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What an alert is actually configured to do.
 *
 * This reads the **stored object** as Cribl returned it. For a Notification each `conf` field is
 * labelled from the condition's own schema, so a field Cribl renames shows up under its new title
 * rather than disappearing; for a monitor the fields are named here, because no schema for one
 * exists. Either way it is not a reconstruction from the template the admin filled in: the point
 * of this screen is to answer "what is really there", which a re-render of the form could not do
 * for an alert someone edited in Cribl afterwards.
 *
 * Fields nothing declares are still listed rather than hidden. An unrecognised key on a live
 * alert is exactly the thing worth seeing.
 */
export function AlertConfigModal({
  alert,
  conditionsById,
  policyCount,
  onClose,
}: AlertConfigModalProps) {
  if (!alert) return null;

  const created = alert.ownership === 'registry' || alert.ownership === 'id';
  const ownershipNote = ownershipDetail(alert.ownership);

  const header = (
    <>
      <div className="config-tags">
        <Tag size="sm" color={alert.disabled ? 'default' : 'criblTeal'}>
          {alert.disabled ? 'Disabled' : 'Enabled'}
        </Tag>
        <Tag size="sm" color="info">
          {alert.mechanism === 'monitor' ? 'Insights monitor' : 'Cribl notification'}
        </Tag>
        <Tag size="sm" color={created ? 'criblTeal' : 'info'}>
          {ownershipLabel(alert.ownership)}
        </Tag>
        <Tag size="sm" color="info">
          {alert.signal === 'volume' ? 'Watches data volume' : 'Watches feed health'}
        </Tag>
      </div>

      {ownershipNote ? (
        <Text variant="body-xs-normal" color="subtle">
          {ownershipNote}
        </Text>
      ) : null}

      {alert.disabled ? (
        <Alert appearance="warning" title="This alert will not fire">
          It exists but is disabled, so it does not count as coverage anywhere in this app.
          {alert.mechanism === 'monitor'
            ? ' Either the monitor itself or every one of its thresholds is switched off.'
            : ' Enable it in Cribl to start watching this feed.'}
        </Alert>
      ) : null}
    </>
  );

  return (
    <Modal isOpen title={`Alert "${alert.id}"`} onClose={onClose} size="md" footer={null}>
      <div className="config-view">
        {header}
        {alert.mechanism === 'monitor' ? (
          <MonitorBody alert={alert} policyCount={policyCount} />
        ) : (
          <NotificationBody
            alert={alert}
            conditionsById={conditionsById}
            policyCount={policyCount}
          />
        )}
      </div>
    </Modal>
  );
}

function NotificationBody({
  alert,
  conditionsById,
  policyCount,
}: {
  alert: AttributedAlert;
  conditionsById: ReadonlyMap<string, NotificationCondition>;
  policyCount: number | null;
}) {
  const condition = conditionsById.get(alert.conditionId);
  const conf = (alert.config.conf ?? {}) as Record<string, unknown>;
  const fields = formFields(condition?.schema);
  const described = new Set(fields.map((field) => field.key));

  const lines: Line[] = fields.map((field) => ({
    key: field.key,
    label: field.label,
    description: field.description,
    value: displayValue(conf[field.key]),
  }));
  for (const [key, value] of Object.entries(conf)) {
    // `name` is the feed identity, shown in its own row above, not as a setting.
    if (described.has(key) || key === 'name') continue;
    lines.push({ key, label: key, value: displayValue(value) });
  }

  const routing = describeRouting(alert.config);
  const link = notificationUrl(alert.group);

  return (
    <>
      <dl className="config-list">
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Condition</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">
              {condition ? `${condition.name} (${alert.conditionId})` : alert.conditionId}
            </Text>
            {condition?.description ? (
              <Text variant="body-xs-normal" color="subtle">
                {condition.description}
              </Text>
            ) : null}
          </dd>
        </div>
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Feed watched</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">{displayValue(conf.name)}</Text>
          </dd>
        </div>
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Worker group</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">
              {alert.group ?? 'not scoped to a group — it applies wherever the feed name matches'}
            </Text>
          </dd>
        </div>
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Routing</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">{routing.summary}</Text>
          </dd>
        </div>
      </dl>

      {/* Only where the stored object proves it. A policy-routed alert reads `delivers: null`,
          because *which* policy matches it lives in an object this app does not read — but a
          count of zero policies is a fact, and then it delivers nowhere too. */}
      {routing.delivers === false ? (
        <Alert appearance="warning" title="This alert delivers nowhere" layout="inline">
          It names no target and does not route by policy, so Cribl records it firing and sends
          nothing. Attach a target or a policy in Cribl.
        </Alert>
      ) : policyGap(alert.config, policyCount) !== null ? (
        <Alert appearance="warning" title="This alert delivers nowhere" layout="inline">
          {policyGap(alert.config, policyCount)}
        </Alert>
      ) : null}

      <Divider />

      {condition ? null : (
        <Alert appearance="info" title="This condition is not in the catalogue">
          The deployment did not return a schema for "{alert.conditionId}", so its settings are shown
          under their raw field names.
        </Alert>
      )}

      <Text variant="body-sm-semibold">Settings</Text>
      {lines.length === 0 ? (
        <Text variant="body-sm-normal" color="subtle">
          This condition takes no settings beyond the feed it watches.
        </Text>
      ) : (
        <Lines lines={lines} />
      )}

      <Divider />

      <div className="config-links">
        <Text variant="body-xs-normal" color="subtle">
          This alert is listed on the Insights alerts page alongside Insights monitors — but it is a
          condition notification, so it has no chart and no edit screen of its own there. It is
          edited under Notifications{alert.group ? ` in ${alert.group}` : ''}. This app only creates
          alerts; it never edits one you are looking at here.
        </Text>
        <div className="config-link-row">
          <ButtonLink
            href={monitorUrl()}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            size="sm"
            trailingIcon={ArrowUpRightFromSquare}
          >
            Open the Insights alerts page
          </ButtonLink>
          <ButtonLink
            href={link}
            target="_blank"
            rel="noreferrer"
            variant="tertiary"
            size="sm"
            trailingIcon={ArrowUpRightFromSquare}
          >
            {alert.group ? `Edit in Notifications (${alert.group})` : 'Edit in Notifications'}
          </ButtonLink>
        </div>
      </div>
    </>
  );
}

/**
 * A monitor's configuration.
 *
 * The three things that make a monitor mean anything are shown first and in full: the query,
 * because that is what is measured; the tags, because that is what makes it per-feed rather than
 * deployment-wide; and the thresholds with their own `enabled` flags, because every monitor Cribl
 * ships has thresholds switched off and a threshold nobody enabled is a monitor that cannot fire.
 */
function MonitorBody({
  alert,
  policyCount,
}: {
  alert: AttributedAlert;
  policyCount: number | null;
}) {
  const config = alert.config as {
    query?: unknown;
    enabled?: unknown;
    description?: unknown;
    product?: unknown;
    schedule_interval_seconds?: unknown;
    firing_after?: unknown;
    ok_after?: unknown;
    rules?: unknown;
    params?: unknown;
  };
  const rules = Array.isArray(config.rules) ? config.rules : [];
  // `params.to` is the email recipient: the shipped smtp template renders `{{metadata.to}}` and
  // the target itself holds no address, so this field is the difference between an email that
  // arrives and one that goes to nobody. Shown from the stored object like everything else here.
  const params = (config.params && typeof config.params === 'object' ? config.params : {}) as Record<
    string,
    unknown
  >;
  const recipient = typeof params.to === 'string' ? params.to : '';

  const tags: string[] = [];
  const thresholds: Line[] = [];
  rules.forEach((rule, ruleIndex) => {
    if (!rule || typeof rule !== 'object') return;
    const entry = rule as {
      includedTags?: Record<string, unknown>;
      conditions?: unknown;
    };
    for (const [label, values] of Object.entries(entry.includedTags ?? {})) {
      if (Array.isArray(values)) for (const value of values) tags.push(`${label} = ${String(value)}`);
    }
    const conditions = Array.isArray(entry.conditions) ? entry.conditions : [];
    conditions.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const held = item as {
        condition?: { type?: unknown; threshold?: unknown };
        enabled?: unknown;
        labels?: Record<string, unknown>;
      };
      const severity = held.labels?.severity;
      thresholds.push({
        key: `${ruleIndex}-${index}`,
        label: `${String(held.condition?.type ?? 'unknown').replace('_', ' ')} ${displayValue(held.condition?.threshold)}`,
        description: severity ? `Severity ${String(severity)}.` : undefined,
        value: held.enabled === false ? 'switched off — cannot fire' : 'active',
      });
    });
  });

  const timing: Line[] = [
    {
      key: 'firing_after',
      label: 'Must hold for',
      description: 'How long the condition stays true before the alert fires.',
      value: `${displayValue(config.firing_after)}s`,
    },
    {
      key: 'ok_after',
      label: 'Recovers after',
      value: `${displayValue(config.ok_after)}s`,
    },
    {
      key: 'schedule_interval_seconds',
      label: 'Evaluated every',
      value: `${displayValue(config.schedule_interval_seconds)}s`,
    },
  ];

  return (
    <>
      {alert.routed === false ? (
        <Alert appearance="warning" title="This monitor delivers nowhere">
          There is no notification routing its output, so it will appear and fire on the Insights
          alerts page but nothing is sent. This app creates that routing object alongside a monitor;
          if it is missing, the second write did not land or it was removed afterwards.
        </Alert>
      ) : policyGap(alert.bridgeConfig, policyCount) !== null ? (
        // The bridge exists, so `routed` is true — and it still delivers nothing, because it
        // routes by policy on a deployment that has none. This is the state four app-created
        // monitors were left in on the verification org before the drawer offered a way out.
        <Alert appearance="warning" title="This monitor delivers nowhere">
          {policyGap(alert.bridgeConfig, policyCount)} The monitor itself is fine: it evaluates and
          fires on the Insights alerts page either way.
        </Alert>
      ) : null}

      <dl className="config-list">
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Feed watched</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">
              {tags.length > 0
                ? tags.join(', ')
                : 'no feed tag — this monitor watches the whole deployment'}
            </Text>
          </dd>
        </div>
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Worker group</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">{alert.group ?? 'unknown'}</Text>
            {alert.hostGroup && alert.hostGroup !== alert.group ? (
              <Text variant="body-xs-normal" color="subtle">
                The monitor object itself lives in &ldquo;{alert.hostGroup}&rdquo;, which is where
                this deployment keeps its monitor collection.
              </Text>
            ) : null}
          </dd>
        </div>
        <div className="config-row">
          <dt>
            <Text variant="body-sm-semibold">Routing</Text>
          </dt>
          <dd>
            <Text variant="body-sm-normal">
              {/* Read from the bridge Notification, not assumed: a monitor's output goes wherever
                  that object says, and since this app started letting the admin choose, that is
                  either a policy or a set of named targets. */}
              {alert.routed ? describeRouting(alert.bridgeConfig).summary : 'none'}
            </Text>
            {recipient ? (
              <Text variant="body-xs-normal" color="subtle">
                Email recipient: {recipient}. An email template renders this from the monitor&rsquo;s
                own <code>params.to</code>; the target holds no address.
              </Text>
            ) : null}
          </dd>
        </div>
      </dl>

      <Divider />

      <Text variant="body-sm-semibold">Query</Text>
      <Text variant="body-xs-normal" color="subtle" as="p">
        Copied verbatim from a monitor Cribl ships. This app does not compose PromQL, because an
        expression that matched no series would produce a monitor that silently never fires.
      </Text>
      <pre className="payload">{displayValue(config.query)}</pre>

      <Text variant="body-sm-semibold">Thresholds</Text>
      {thresholds.length === 0 ? (
        <Alert appearance="warning" title="No threshold" layout="inline">
          This monitor declares no condition to compare the query against, so there is nothing for
          it to fire on.
        </Alert>
      ) : (
        <Lines lines={thresholds} />
      )}

      <Text variant="body-sm-semibold">Timing</Text>
      <Lines lines={timing} />

      <Divider />

      <div className="config-links">
        <Text variant="body-xs-normal" color="subtle">
          This app only creates alerts; it never edits one you are looking at here. To change or
          delete this alert, open it in Cribl.
        </Text>
        <div className="config-link-row">
          <ButtonLink
            href={monitorUrl(alert.id)}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            size="sm"
            trailingIcon={ArrowUpRightFromSquare}
          >
            Edit this monitor in Insights
          </ButtonLink>
        </div>
      </div>
    </>
  );
}
