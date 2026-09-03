import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  ButtonLink,
  Checkbox,
  Collapse,
  Divider,
  Drawer,
  Pill,
  SelectField,
  Spinner,
  Text,
  TextField,
} from '@capra/core';
import { ArrowUpRightFromSquare } from '@capra/icons';
import { ConditionForm } from './ConditionForm.tsx';
import { MonitorForm } from './MonitorForm.tsx';
import type { NotificationTarget } from '../api/alerts.ts';
import type { TemplateDefaults } from '../api/kv.ts';
import { saveTemplateDefaults } from '../api/kv.ts';
import type { Monitor } from '../api/monitors.ts';
import type { NotificationTemplate } from '../api/routing.ts';
import { formFields, initialConf, validateConf } from '../lib/conditionForm.ts';
import {
  coerceRouting,
  recipientTargets,
  templatesForTarget,
  type RoutingMode,
  type RoutingSettings,
} from '../lib/routing.ts';
import {
  buildPlan,
  indexFeedIdentities,
  coerceMechanism,
  coerceMonitorSettings,
  countPlan,
  DEFAULT_SETTINGS,
  resolveMechanism,
  type MonitorSettings,
  type PlanContext,
  type PlannedAlert,
  type TemplateSettings,
} from '../lib/plan.ts';
import { retryablePlan, useApply } from '../hooks/useApply.ts';
import type { DiscoveryCapabilities } from '../hooks/useDiscovery.ts';
import type {
  Direction,
  Feed,
  FeedCoverage,
  Mechanism,
  NotificationCondition,
} from '../lib/types.ts';

export interface BulkApplyDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The selected feeds, in the order the table showed them. */
  feeds: readonly Feed[];
  /**
   * Every discovered feed, not just the selection.
   *
   * A monitor is scoped by feed tag and a tag carries no worker group, so whether a monitor
   * watches one feed or several is a question about the whole deployment. Answering it from
   * the selection would get it wrong in exactly the case that matters — one row selected,
   * a second group nobody looked at.
   */
  allFeeds: readonly Feed[];
  coverage: ReadonlyMap<string, FeedCoverage>;
  conditionsById: ReadonlyMap<string, NotificationCondition>;
  /** Conditions that detect a stopped feed, per direction. Empty means none exists. */
  conditionsByDirection: Record<Direction, NotificationCondition[]>;
  capabilities: DiscoveryCapabilities;
  targets: readonly NotificationTarget[];
  /** Message templates, pairable with a target of the same type. */
  templates: readonly NotificationTemplate[];
  /** Why templates could not be read, when they could not. `null` means the list is the truth. */
  templatesReason: string | null;
  /** How many notification policies exist, or `null` when that could not be read. */
  policyCount: number | null;
  policyReason: string | null;
  /** The group whose monitor collection answers. `null` when none does. */
  monitorHost: string | null;
  /** Shipped monitors whose query can be copied, per direction, best first. */
  monitorTemplates: Record<Direction, Monitor[]>;
  templateDefaults: TemplateDefaults | null;
  /** Called after a run that created at least one alert, to refresh coverage. */
  onApplied: () => void;
}

type Step = 'configure' | 'preview' | 'results';

const DIRECTION_LABEL: Record<Direction, string> = { source: 'Sources', destination: 'Destinations' };

const EMPTY_CONF_BY: Record<Direction, Record<string, unknown>> = { source: {}, destination: {} };

const MECHANISM_LABEL: Record<Mechanism, string> = {
  notification: 'Cribl notification',
  monitor: 'Insights monitor (appears on the Insights alerts page)',
};

/**
 * Configure → preview → confirm, in one drawer.
 *
 * One intent — "tell me when this feed stops delivering data" — but two mechanisms that can
 * carry it, and everything is chosen **per direction**. That is not symmetry for its own sake:
 * the condition catalogue is asymmetric (a Source proves a stop with `no-data`, a Destination
 * with `unhealthy-dest`, and those declare different `conf` fields), and so is the set of
 * shipped monitors whose query can be copied.
 */
export function BulkApplyDrawer(props: BulkApplyDrawerProps) {
  const {
    open,
    onClose,
    feeds,
    allFeeds,
    coverage,
    conditionsById,
    conditionsByDirection,
    capabilities,
    targets,
    templates,
    templatesReason,
    policyCount,
    policyReason,
    monitorHost,
    monitorTemplates,
    templateDefaults,
    onApplied,
  } = props;

  const [step, setStep] = useState<Step>('configure');
  const apply = useApply();

  const directionsPresent = useMemo(() => {
    const set = new Set<Direction>();
    for (const feed of feeds) set.add(feed.direction);
    return [...set];
  }, [feeds]);

  const [mechanismBy, setMechanismBy] = useState<Record<Direction, Mechanism>>(
    DEFAULT_SETTINGS.mechanismBy,
  );
  const [conditionBy, setConditionBy] = useState<Record<Direction, string | null>>({
    source: null,
    destination: null,
  });
  const [confBy, setConfBy] = useState<Record<Direction, Record<string, unknown>>>(EMPTY_CONF_BY);
  const [monitorBy, setMonitorBy] = useState<Record<Direction, MonitorSettings>>(
    DEFAULT_SETTINGS.monitorBy,
  );
  const [routing, setRouting] = useState<RoutingSettings>(DEFAULT_SETTINGS.routing);
  const [createDisabled, setCreateDisabled] = useState(false);

  // Seed the form from the schema defaults and whatever was used last time. Runs when
  // the drawer opens, not on every render, so it never fights the admin's typing.
  useEffect(() => {
    if (!open) return;
    setStep('configure');
    apply.reset();

    const savedCondition: Record<Direction, string | undefined> = {
      source: templateDefaults?.sourceConditionId,
      destination: templateDefaults?.destinationConditionId,
    };
    const savedConf: Record<Direction, Record<string, unknown> | undefined> = {
      source: templateDefaults?.sourceConf,
      destination: templateDefaults?.destinationConf,
    };

    const chosen: Record<Direction, string | null> = { source: null, destination: null };
    const conf: Record<Direction, Record<string, unknown>> = { source: {}, destination: {} };
    for (const direction of ['source', 'destination'] as const) {
      const available = conditionsByDirection[direction];
      const saved = savedCondition[direction];
      chosen[direction] =
        saved && available.some((condition) => condition.id === saved)
          ? saved
          : (available[0]?.id ?? null);
      const condition = chosen[direction] ? conditionsById.get(chosen[direction]) : undefined;
      conf[direction] = initialConf(
        condition,
        savedConf[direction] ?? DEFAULT_SETTINGS.confBy[direction],
      );
    }
    setConditionBy(chosen);
    setConfBy(conf);

    // Mechanism and monitor thresholds, validated field by field on the way back out of the
    // store — and never restored onto a mechanism that is currently unavailable, because an
    // admin who last used monitors should not reopen the drawer to find every row blocked.
    const savedMechanism: Record<Direction, Mechanism | null> = {
      source: coerceMechanism(templateDefaults?.sourceMechanism),
      destination: coerceMechanism(templateDefaults?.destinationMechanism),
    };
    const savedMonitor: Record<Direction, unknown> = {
      source: templateDefaults?.sourceMonitor,
      destination: templateDefaults?.destinationMonitor,
    };
    const mechanism: Record<Direction, Mechanism> = { ...DEFAULT_SETTINGS.mechanismBy };
    const monitor: Record<Direction, MonitorSettings> = {
      source: DEFAULT_SETTINGS.monitorBy.source,
      destination: DEFAULT_SETTINGS.monitorBy.destination,
    };
    for (const direction of ['source', 'destination'] as const) {
      const monitorUsable =
        capabilities.monitors.available && monitorTemplates[direction].length > 0;
      mechanism[direction] = resolveMechanism(savedMechanism[direction], {
        monitor: monitorUsable,
        notification: capabilities.alerting.available && conditionsByDirection[direction].length > 0,
      });
      monitor[direction] = coerceMonitorSettings(savedMonitor[direction]);
      // A stored template id that this deployment no longer ships would block every item with
      // a message about a monitor the admin never chose. Fall back to "best candidate".
      if (
        monitor[direction].templateId &&
        !monitorTemplates[direction].some((item) => item.id === monitor[direction].templateId)
      ) {
        monitor[direction] = { ...monitor[direction], templateId: null };
      }
    }
    setMechanismBy(mechanism);
    setMonitorBy(monitor);

    // Routing, validated against the targets and templates that exist right now: a target that
    // has since been deleted, or a template that no longer matches its target's type, falls out
    // rather than being restored into a write payload. The policy count is passed because with
    // nothing stored it decides the default: policy routing on a deployment with zero policies
    // delivers nothing, which is how four dead alerts came to exist on the verification org.
    setRouting(coerceRouting(templateDefaults, { targets, templates, policyCount }));
    setCreateDisabled(false);
    // `apply` is a stable-enough bag of setters; re-seeding on its identity would reset
    // the form mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateDefaults, conditionsByDirection, conditionsById, targets, templates, policyCount]);

  const settings: TemplateSettings = useMemo(
    () => ({
      mechanismBy,
      conditionBy,
      confBy,
      monitorBy,
      routing,
      createDisabled,
    }),
    [mechanismBy, conditionBy, confBy, monitorBy, routing, createDisabled],
  );

  const feedIdentities = useMemo(() => indexFeedIdentities(allFeeds), [allFeeds]);

  const context: PlanContext = useMemo(
    () => ({
      conditions: conditionsById,
      coverage,
      alerting: capabilities.alerting,
      monitors: capabilities.monitors,
      monitorHost,
      monitorTemplates,
      feedIdentities,
    }),
    [
      conditionsById,
      coverage,
      capabilities.alerting,
      capabilities.monitors,
      monitorHost,
      monitorTemplates,
      feedIdentities,
    ],
  );

  const plan = useMemo(() => buildPlan(feeds, settings, context), [feeds, settings, context]);
  const counts = countPlan(plan);

  /*
   * Validated per direction, against that direction's own condition.
   *
   * Not merged into one error bag: the two conditions can declare fields of the same name
   * (`timeWindow` appears on both), so a merged bag would report a Source error against a
   * Destination field, or mask one with the other. Only the direction actually using a
   * Notification is validated — a `conf` value for a mechanism this run will not use must not
   * block the run.
   */
  const errorsBy = useMemo(() => {
    const result: Record<Direction, Record<string, string>> = { source: {}, destination: {} };
    for (const direction of directionsPresent) {
      if (mechanismBy[direction] !== 'notification') continue;
      const id = conditionBy[direction];
      const condition = id ? conditionsById.get(id) : undefined;
      if (!condition) continue;
      result[direction] = validateConf(formFields(condition.schema), confBy[direction]);
    }
    return result;
  }, [directionsPresent, mechanismBy, conditionBy, conditionsById, confBy]);

  const valid = directionsPresent.every(
    (direction) => Object.keys(errorsBy[direction]).length === 0,
  );

  const retryable = retryablePlan(plan, apply.outcomes);

  /*
   * Said again on the preview, because the preview is the gate.
   *
   * The Delivery section already warns, and it was warning on the verification org while four
   * alerts were created that deliver nowhere — a policy-routed alert on a deployment with zero
   * policies. A notice beside the field the admin has already scrolled past is not the same as one
   * on the screen they have to confirm. Only states that provably deliver nothing qualify: an
   * unreadable policy count is not one of them.
   */
  const deliveryWarning = useMemo(() => {
    if (routing.mode === 'policy') {
      return policyCount === 0
        ? 'These alerts route by notification policy, and this deployment has none. Each one will fire and appear on the Insights alerts page, and none of them will deliver anything until a policy is created in Cribl. Go back and choose notification targets instead if you want them delivered now.'
        : null;
    }
    if (routing.targets.length === 0) {
      return 'These alerts name no target and do not route by policy, so Cribl will record each one firing and send nothing.';
    }
    const needsRecipient = recipientTargets(routing, targets);
    if (needsRecipient.length > 0 && routing.recipient.trim() === '') {
      return `${needsRecipient
        .map((target) => target.id)
        .join(', ')} sends email and no recipient was given, so the address renders empty and the send fails. Go back and add one.`;
    }
    return null;
  }, [routing, policyCount, targets]);

  const runPlan = async (items: readonly PlannedAlert[]) => {
    setStep('results');
    await apply.run(items);

    // Remember the template only after a run: settings that were never used are not
    // worth restoring, and this write must never happen on render.
    void saveTemplateDefaults({
      sourceConditionId: conditionBy.source ?? undefined,
      sourceConf: confBy.source,
      destinationConditionId: conditionBy.destination ?? undefined,
      destinationConf: confBy.destination,
      routingMode: routing.mode,
      notificationTargets: routing.targets,
      notificationTemplateByTarget: { ...routing.templateByTarget },
      notificationRecipient: routing.recipient,
      sourceMechanism: mechanismBy.source,
      destinationMechanism: mechanismBy.destination,
      sourceMonitor: { ...monitorBy.source },
      destinationMonitor: { ...monitorBy.destination },
    }).catch((error: unknown) => {
      console.warn('[cc-simplified-alerting] could not save template defaults:', error);
    });

    onApplied();
  };

  const footer =
    step === 'configure' ? (
      <div className="drawer-footer">
        <Button variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid} onClick={() => setStep('preview')}>
          {`Review ${counts.creatable} ${counts.creatable === 1 ? 'alert' : 'alerts'}`}
        </Button>
      </div>
    ) : step === 'preview' ? (
      <div className="drawer-footer">
        <Button variant="tertiary" onClick={() => setStep('configure')}>
          Back
        </Button>
        <Button variant="primary" disabled={counts.creatable === 0} onClick={() => void runPlan(plan)}>
          {`Create ${counts.creatable} ${counts.creatable === 1 ? 'alert' : 'alerts'}`}
        </Button>
      </div>
    ) : (
      <div className="drawer-footer">
        {retryable.length > 0 && !apply.running ? (
          <Button variant="secondary" onClick={() => void apply.run(retryable)}>
            {`Retry ${retryable.length} failed`}
          </Button>
        ) : null}
        {apply.running ? (
          <Button variant="tertiary" onClick={apply.cancel}>
            Stop
          </Button>
        ) : null}
        <Button variant="primary" onClick={onClose} disabled={apply.running}>
          Done
        </Button>
      </div>
    );

  return (
    <Drawer
      isOpen={open}
      onClose={apply.running ? undefined : onClose}
      closable={!apply.running}
      width={720}
      title={
        <Drawer.ExpandedTitleLayout>
          <Drawer.Heading>Create alerts</Drawer.Heading>
          <Drawer.Description>
            {feeds.length} selected {feeds.length === 1 ? 'feed' : 'feeds'} ·{' '}
            {step === 'configure'
              ? 'Configure'
              : step === 'preview'
                ? 'Review before anything is created'
                : 'Results'}
          </Drawer.Description>
        </Drawer.ExpandedTitleLayout>
      }
      footer={footer}
    >
      {step === 'configure' ? (
        <ConfigureStep
          directionsPresent={directionsPresent}
          capabilities={capabilities}
          conditionsByDirection={conditionsByDirection}
          conditionsById={conditionsById}
          conditionBy={conditionBy}
          setConditionBy={setConditionBy}
          confBy={confBy}
          setConfBy={setConfBy}
          mechanismBy={mechanismBy}
          setMechanismBy={setMechanismBy}
          monitorBy={monitorBy}
          setMonitorBy={setMonitorBy}
          monitorHost={monitorHost}
          monitorTemplates={monitorTemplates}
          errorsBy={errorsBy}
          targets={targets}
          templates={templates}
          templatesReason={templatesReason}
          policyCount={policyCount}
          policyReason={policyReason}
          routing={routing}
          setRouting={setRouting}
          createDisabled={createDisabled}
          setCreateDisabled={setCreateDisabled}
        />
      ) : step === 'preview' ? (
        <PreviewStep plan={plan} deliveryWarning={deliveryWarning} />
      ) : (
        <ResultsStep plan={plan} apply={apply} />
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Configure
// ---------------------------------------------------------------------------

interface ConfigureStepProps {
  directionsPresent: readonly Direction[];
  capabilities: DiscoveryCapabilities;
  conditionsByDirection: Record<Direction, NotificationCondition[]>;
  conditionsById: ReadonlyMap<string, NotificationCondition>;
  conditionBy: Record<Direction, string | null>;
  setConditionBy: (value: Record<Direction, string | null>) => void;
  confBy: Record<Direction, Record<string, unknown>>;
  setConfBy: (value: Record<Direction, Record<string, unknown>>) => void;
  mechanismBy: Record<Direction, Mechanism>;
  setMechanismBy: (value: Record<Direction, Mechanism>) => void;
  monitorBy: Record<Direction, MonitorSettings>;
  setMonitorBy: (value: Record<Direction, MonitorSettings>) => void;
  monitorHost: string | null;
  monitorTemplates: Record<Direction, Monitor[]>;
  errorsBy: Record<Direction, Record<string, string>>;
  targets: readonly NotificationTarget[];
  templates: readonly NotificationTemplate[];
  templatesReason: string | null;
  policyCount: number | null;
  policyReason: string | null;
  routing: RoutingSettings;
  setRouting: (value: RoutingSettings) => void;
  createDisabled: boolean;
  setCreateDisabled: (value: boolean) => void;
}

function ConfigureStep(props: ConfigureStepProps) {
  const notificationsUsable = props.capabilities.alerting.available;
  const monitorsUsable = props.capabilities.monitors.available;
  const usesMonitor = props.directionsPresent.some(
    (direction) => props.mechanismBy[direction] === 'monitor',
  );
  const usesNotification = props.directionsPresent.some(
    (direction) => props.mechanismBy[direction] === 'notification',
  );

  return (
    <div className="drawer-body">
      {!notificationsUsable && !monitorsUsable ? (
        <Alert appearance="danger" title="Nothing can be created">
          Neither mechanism is available here. Notifications: {props.capabilities.alerting.reason}{' '}
          Insights monitors: {props.capabilities.monitors.reason}
        </Alert>
      ) : !notificationsUsable ? (
        <Alert appearance="warning" title="Notifications are unavailable" layout="inline">
          {props.capabilities.alerting.reason} Alerts can still be created as Insights monitors.
        </Alert>
      ) : !monitorsUsable ? (
        <Alert appearance="info" title="Insights monitors are unavailable" layout="inline">
          {props.capabilities.monitors.reason} Alerts can still be created as Cribl notifications.
        </Alert>
      ) : null}

      <Text variant="body-sm-normal" color="subtle" as="p">
        Each alert watches one feed and fires when it stops delivering data. Choose how it is
        carried: a Cribl notification on a condition this deployment offers, or an Insights monitor,
        which is what appears on the Insights alerts page with a chart and an activity trail.
      </Text>

      {props.directionsPresent.map((direction) => {
        const available = props.conditionsByDirection[direction];
        const selectedId = props.conditionBy[direction];
        const condition = selectedId ? props.conditionsById.get(selectedId) : undefined;
        const mechanism = props.mechanismBy[direction];
        const mechanisms: Mechanism[] = [
          ...(notificationsUsable ? (['notification'] as const) : []),
          ...(monitorsUsable ? (['monitor'] as const) : []),
        ];

        return (
          <section className="drawer-section" key={direction}>
            <Text variant="body-md-semibold">{DIRECTION_LABEL[direction]}</Text>

            {mechanisms.length > 1 ? (
              <SelectField
                label="Alert mechanism"
                items={mechanisms.map((item) => ({ id: item, label: MECHANISM_LABEL[item] }))}
                value={mechanism}
                helperText={
                  mechanism === 'monitor'
                    ? `Written to the monitor collection in "${props.monitorHost ?? 'unknown'}" and scoped to each feed by its type:id tag. Each one is named {monitor}_{feed} and appears on the Insights alerts page.`
                    : 'Written to this group’s notifications, scoped to the feed by conf.name.'
                }
                onChange={(key) =>
                  key === null
                    ? undefined
                    : props.setMechanismBy({ ...props.mechanismBy, [direction]: key as Mechanism })
                }
              />
            ) : null}

            {mechanism === 'monitor' ? (
              <MonitorForm
                templates={props.monitorTemplates[direction]}
                settings={props.monitorBy[direction]}
                onChange={(next) => props.setMonitorBy({ ...props.monitorBy, [direction]: next })}
              />
            ) : available.length === 0 ? (
              <Alert
                appearance="warning"
                title={`No condition detects a ${direction} that stopped delivering`}
                layout="inline"
              >
                This deployment&rsquo;s condition catalogue offers nothing for{' '}
                {DIRECTION_LABEL[direction].toLowerCase()}, and condition ids are never guessed. Those
                feeds are listed as blocked in the review step and nothing is created for them.
                {monitorsUsable ? ' An Insights monitor can watch them instead.' : ''}
              </Alert>
            ) : (
              <>
                <SelectField
                  label="Condition"
                  items={available.map((item) => ({
                    id: item.id,
                    label: `${item.name} (${item.id})`,
                  }))}
                  value={selectedId ?? undefined}
                  helperText={condition?.description}
                  onChange={(key) =>
                    props.setConditionBy({
                      ...props.conditionBy,
                      [direction]: key === null ? null : String(key),
                    })
                  }
                />
                <ConditionForm
                  schema={condition?.schema}
                  values={props.confBy[direction]}
                  errors={props.errorsBy[direction]}
                  onChange={(key, value) =>
                    props.setConfBy({
                      ...props.confBy,
                      [direction]: { ...props.confBy[direction], [key]: value },
                    })
                  }
                />
              </>
            )}
          </section>
        );
      })}

      <Divider />

      <RoutingSection
        capabilities={props.capabilities}
        targets={props.targets}
        templates={props.templates}
        templatesReason={props.templatesReason}
        policyCount={props.policyCount}
        policyReason={props.policyReason}
        routing={props.routing}
        setRouting={props.setRouting}
        usesMonitor={usesMonitor}
        usesNotification={usesNotification}
      />

      <section className="drawer-section">
        <Checkbox
          checked={props.createDisabled}
          onChange={(event) => props.setCreateDisabled(event.target.checked)}
        >
          Create disabled, so they can be reviewed in Cribl before they can fire
        </Checkbox>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routing — which of the platform's two delivery paths the admin wants
// ---------------------------------------------------------------------------

const ROUTING_LABEL: Record<RoutingMode, string> = {
  policy: 'Cribl notification policies',
  targets: 'Notification targets, with a template each',
};

/**
 * "No template" needs an id of its own in a single-select, and it is a real choice rather than an
 * empty one: a target with no template is delivered with that target's own default rendering,
 * which is how every alert this app created before templates existed is still delivered.
 */
const NO_TEMPLATE = '__none__';

interface RoutingSectionProps {
  capabilities: DiscoveryCapabilities;
  targets: readonly NotificationTarget[];
  templates: readonly NotificationTemplate[];
  templatesReason: string | null;
  policyCount: number | null;
  policyReason: string | null;
  routing: RoutingSettings;
  setRouting: (value: RoutingSettings) => void;
  usesMonitor: boolean;
  /** Does this run write at least one condition Notification? It cannot carry a recipient. */
  usesNotification: boolean;
}

/**
 * One delivery choice for the whole run, because that is how the platform models it.
 *
 * `Notification.mode` is `"policy" | "direct"` and the two are mutually exclusive in the schema's
 * own `oneOf`, so this is a real fork rather than a preference: a policy-routed alert names
 * nothing and is matched in Cribl, while a target-routed one names its targets and optionally a
 * template per target. It applies to both mechanisms and both directions, because a target and a
 * policy are deployment-wide objects that know nothing about a feed's direction.
 *
 * Neither route is presented as safe by default. Policy mode is what Cribl's own Insights UI
 * posts *first*, but a HAR capture of this org shows an admin then changing it to targets because
 * the deployment has no policy and the alert was delivering nothing — so the count is read, said
 * out loud, and where it is zero this section opens on targets instead. It still never picks a
 * target: naming one is a delivery decision and stays the admin's.
 */
function RoutingSection(props: RoutingSectionProps) {
  const { routing, setRouting } = props;
  const targetsUsable = props.capabilities.routingTargets.available;
  // In the order the deployment lists them, not the order they were clicked: this is a set.
  const chosen = props.targets.filter((target) => routing.targets.includes(target.id));
  // Email targets hold no address of their own, so one has to be supplied with the alert.
  const needsRecipient = recipientTargets(routing, props.targets);

  return (
    <section className="drawer-section">
      <Text variant="body-md-semibold">Delivery</Text>

      <SelectField
        label="How these alerts are delivered"
        items={(['policy', 'targets'] as const).map((mode) => ({
          id: mode,
          label: ROUTING_LABEL[mode],
        }))}
        value={routing.mode}
        helperText={
          routing.mode === 'policy'
            ? 'The alert names no target. A notification policy in Cribl matches it and decides where it goes — the route Cribl’s own Insights UI uses for a monitor.'
            : 'The alert names its targets itself, with an optional template per target that renders the message for that target’s type.'
        }
        onChange={(key) =>
          key === null ? undefined : setRouting({ ...routing, mode: key as RoutingMode })
        }
      />

      {routing.mode === 'policy' ? (
        props.policyCount === null ? (
          <Alert appearance="info" title="Policies could not be checked" layout="inline">
            {props.policyReason} These alerts will still be created to route by policy, exactly as
            Cribl&rsquo;s Insights UI does — but this app cannot confirm a policy exists to carry
            them.
          </Alert>
        ) : props.policyCount === 0 ? (
          <Alert
            appearance="warning"
            title="This deployment has no notification policies"
            layout="inline"
          >
            A policy-routed alert fires and is recorded on the Insights alerts page, but with no
            policy to match it nothing is delivered. Create a policy in Cribl — this app never
            does — or choose &ldquo;{ROUTING_LABEL.targets}&rdquo; above.
          </Alert>
        ) : (
          <Alert appearance="info" title="Delivered by policy" layout="inline">
            {props.policyCount === 1
              ? 'One notification policy exists here.'
              : `${props.policyCount} notification policies exist here.`}{' '}
            Which of them carries these alerts is decided by its own matchers in Cribl. This app
            does not read or create policies, so it cannot promise one covers these.
          </Alert>
        )
      ) : !targetsUsable ? (
        <Alert appearance="info" title="Routing must be attached separately" layout="inline">
          {props.capabilities.routingTargets.reason ?? 'Notification targets are unavailable.'}{' '}
          These alerts will be created naming no target, so they fire but notify nowhere until one
          is attached in Cribl.
        </Alert>
      ) : (
        <>
          <SelectField
            label="Notification targets"
            selectionMode="multiple"
            items={props.targets.map((target) => ({
              id: target.id,
              label: `${target.id} (${target.type})`,
            }))}
            value={routing.targets}
            helperText="Where these alerts are delivered. This app never creates or edits targets."
            onChange={(keys) => {
              const next = [...keys].map((key) => String(key));
              // Drop the template of any target that just came off the list, so a stale pair
              // cannot be saved as a default and offered back on the next run.
              const templateByTarget: Record<string, string> = {};
              for (const id of next) {
                const templateId = routing.templateByTarget[id];
                if (templateId) templateByTarget[id] = templateId;
              }
              setRouting({ ...routing, targets: next, templateByTarget });
            }}
          />

          {routing.targets.length === 0 ? (
            <Alert appearance="warning" title="These alerts will notify nowhere" layout="inline">
              With no target attached, Cribl records the alert firing but sends nothing. Pick a
              target, switch to policy routing, or attach one in Cribl afterwards.
            </Alert>
          ) : null}

          {props.templatesReason !== null && routing.targets.length > 0 ? (
            <Alert appearance="info" title="Templates could not be read" layout="inline">
              {props.templatesReason} Each target will be delivered with its own default rendering,
              which is what an alert with no template gets.
            </Alert>
          ) : null}

          {chosen.length > 0 && props.templatesReason === null ? (
            <div className="drawer-subsection">
              {chosen.map((target) => {
                const options = templatesForTarget(target, props.templates);
                return options.length === 0 ? (
                  <Text key={target.id} variant="body-xs-normal" color="subtle">
                    {target.id}: no template here renders {target.type}, so this target is
                    delivered with its own default. That is a normal state, not a gap.
                  </Text>
                ) : (
                  <SelectField
                    key={target.id}
                    label={`Template for ${target.id}`}
                    items={[
                      { id: NO_TEMPLATE, label: 'No template — the target’s own default' },
                      ...options.map((template) => ({
                        id: template.id,
                        label: template.description
                          ? `${template.id} — ${template.description}`
                          : template.id,
                      })),
                    ]}
                    value={routing.templateByTarget[target.id] ?? NO_TEMPLATE}
                    onChange={(key) => {
                      const templateByTarget = { ...routing.templateByTarget };
                      if (key === null || key === NO_TEMPLATE) delete templateByTarget[target.id];
                      else templateByTarget[target.id] = String(key);
                      setRouting({ ...routing, templateByTarget });
                    }}
                  />
                );
              })}
            </div>
          ) : null}

          {needsRecipient.length > 0 ? (
            <>
              <TextField
                label="Email recipient"
                value={routing.recipient}
                placeholder="you@example.com"
                helperText={`${needsRecipient
                  .map((target) => target.id)
                  .join(', ')} sends email, and the shipped email template takes the address from the alert itself — the target holds none. Cribl's own UI puts it on the monitor as params.to.`}
                onChange={(value) => setRouting({ ...routing, recipient: value })}
              />
              {routing.recipient.trim() === '' ? (
                <Alert appearance="warning" title="No recipient, no email" layout="inline">
                  The <code>default-email</code> template renders{' '}
                  <code>&quot;to&quot;: &quot;&#123;&#123;metadata.to&#125;&#125;&quot;</code>, so
                  with nothing here the address comes out empty and the send fails. Add one, or set
                  it on the monitor in Cribl afterwards.
                </Alert>
              ) : null}
              {props.usesNotification ? (
                <Alert
                  appearance="warning"
                  title="A condition Notification cannot carry a recipient"
                  layout="inline"
                >
                  This recipient is written onto the monitor, which is where Cribl&rsquo;s own UI
                  puts it. A condition Notification has no equivalent field, so the{' '}
                  {props.usesMonitor ? 'Notification items in this run' : 'items in this run'} will
                  reach an email target only if the address is configured in Cribl on the target
                  itself. Everything else about them is unaffected.
                </Alert>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Preview — mandatory, and shows the real payload
// ---------------------------------------------------------------------------

function PreviewStep({
  plan,
  deliveryWarning,
}: {
  plan: readonly PlannedAlert[];
  deliveryWarning: string | null;
}) {
  const counts = countPlan(plan);
  return (
    <div className="drawer-body">
      <Alert
        appearance={counts.creatable > 0 ? 'info' : 'warning'}
        title={`${counts.creatable} will be created, ${counts.skipped} skipped, ${counts.blocked} blocked`}
      >
        Nothing has been written yet. Every payload below is exactly what would be sent.
      </Alert>

      {deliveryWarning !== null && counts.creatable > 0 ? (
        <Alert appearance="warning" title="These alerts will not notify anyone">
          {deliveryWarning}
        </Alert>
      ) : null}

      {plan.map((item) => (
        <div key={item.key} className="preview-item">
          <div className="cell-inline">
            <Pill
              appearance={item.skipped ? 'default' : item.blocked ? 'danger' : 'success'}
              variant="muted"
            >
              {item.skipped ? 'Skip' : item.blocked ? 'Blocked' : 'Create'}
            </Pill>
            <Text variant="body-sm-semibold">{item.feedId}</Text>
            <Text variant="body-xs-normal" color="subtle">
              {item.group} · {item.direction === 'source' ? 'Source' : 'Destination'}
            </Text>
          </div>
          <Text variant="body-xs-normal" color="subtle" as="div">
            {item.label}
          </Text>
          {item.skipped ? (
            <Text variant="body-xs-normal" color="subtle" as="div">
              {item.skipped}
            </Text>
          ) : null}
          {item.blocked ? (
            <Alert appearance="warning" layout="inline">
              {item.blocked}
            </Alert>
          ) : null}
          {/* Shown only on an item that will actually be written — a caveat about a write that
              is not happening is noise, and this one is about scope, not about eligibility. */}
          {item.warning && !item.blocked && !item.skipped ? (
            <Alert appearance="warning" layout="inline" title="This will watch more than one feed">
              {item.warning}
            </Alert>
          ) : null}
          {item.write && !item.blocked && !item.skipped ? (
            item.write.kind === 'notification' ? (
              <pre className="payload">{JSON.stringify(item.write.notification, null, 2)}</pre>
            ) : (
              /* Both objects, labelled. A monitor alert is two writes, and a preview that showed
                 only the monitor would hide the half that decides whether anyone hears about it. */
              <>
                <Text variant="body-xs-normal" color="subtle" as="div">
                  Monitor, written to {item.write.hostGroup}:
                </Text>
                <pre className="payload">{JSON.stringify(item.write.monitor, null, 2)}</pre>
                <Text variant="body-xs-normal" color="subtle" as="div">
                  Notification that routes its output:
                </Text>
                <pre className="payload">{JSON.stringify(item.write.bridge, null, 2)}</pre>
              </>
            )
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ResultsStep({
  plan,
  apply,
}: {
  plan: readonly PlannedAlert[];
  apply: ReturnType<typeof useApply>;
}) {
  const created = [...apply.outcomes.values()].filter((outcome) => outcome.status === 'created');
  const failed = [...apply.outcomes.values()].filter((outcome) => outcome.status === 'failed');

  return (
    <div className="drawer-body">
      <div className="cell-inline">
        {apply.running ? <Spinner size="sm" /> : null}
        <Text variant="body-sm-semibold">
          {apply.completed} of {apply.total} processed
        </Text>
        <Text variant="body-xs-normal" color="subtle">
          {created.length} created · {failed.length} failed
        </Text>
      </div>

      {apply.writeDenied ? (
        <Alert appearance="warning" title="Writes were denied part-way through">
          {apply.writeDenied}
        </Alert>
      ) : null}

      {plan.map((item) => {
        const outcome = apply.outcomes.get(item.key);
        const pending = !outcome && apply.running;
        return (
          <div key={item.key} className="preview-item">
            <div className="cell-inline">
              <Pill
                appearance={
                  outcome?.status === 'created'
                    ? // Created, but something alongside it did not land — the routing half of a
                      // monitor, or its registry entry. Reads as a warning, because it is one.
                      outcome.partial || outcome.registryFailed
                      ? 'warning'
                      : 'success'
                    : outcome?.status === 'failed'
                      ? 'danger'
                      : outcome?.status === 'blocked'
                        ? 'warning'
                        : 'default'
                }
                variant="muted"
              >
                {outcome?.status === 'created' && outcome.partial
                  ? 'created, not routed'
                  : (outcome?.status ?? (pending ? 'Waiting' : 'Not run'))}
              </Pill>
              <Text variant="body-sm-semibold">{item.feedId}</Text>
              <Text variant="body-xs-normal" color="subtle">
                {item.group} · {item.label}
              </Text>
            </div>
            {outcome ? (
              <Text variant="body-xs-normal" color="subtle" as="div">
                {outcome.message}
              </Text>
            ) : null}
            {/* The configuration as created, right here — the admin asked "what did I just
                make?" and should not have to close the drawer and hunt for it by id. */}
            {outcome?.config ? (
              <Collapse title="Configuration as created">
                <pre className="payload">{JSON.stringify(outcome.config, null, 2)}</pre>
              </Collapse>
            ) : null}
            {outcome?.url ? (
              <div className="config-link-row">
                <ButtonLink
                  href={outcome.url}
                  target="_blank"
                  rel="noreferrer"
                  variant="secondary"
                  size="sm"
                  trailingIcon={ArrowUpRightFromSquare}
                >
                  {item.mechanism === 'monitor' ? 'Open this alert in Insights' : 'Open in Cribl'}
                </ButtonLink>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
