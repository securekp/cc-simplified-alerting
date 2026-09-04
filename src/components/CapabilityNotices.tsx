import { Alert, Text } from '@capra/core';
import type { DiscoveryCapabilities, GroupFetchNote } from '../hooks/useDiscovery.ts';
import type { Capability } from '../lib/types.ts';

export interface CapabilityNoticesProps {
  capabilities: DiscoveryCapabilities;
  notices: readonly string[];
  perGroupNotes: readonly GroupFetchNote[];
}

interface Entry {
  key: string;
  title: string;
  appearance: 'warning' | 'danger' | 'info';
  body: string;
}

/**
 * What the app cannot do right now, and why.
 *
 * One notice per distinct problem, and severity derived from whether alerting is *entirely*
 * impossible rather than defaulted to `warning`. There are two mechanisms and they fail
 * independently, so losing one is a narrowed choice, not an outage: only losing both turns the
 * app into a read-only audit, and only that earns `danger`.
 *
 * What is never suppressed: a capability the admin might otherwise assume is working.
 * They have to be able to tell "there are no alerts here" from "this app could not find out".
 */
export function CapabilityNotices({ capabilities, notices, perGroupNotes }: CapabilityNoticesProps) {
  const entries: Entry[] = [];

  const push = (key: string, title: string, capability: Capability, appearance: Entry['appearance']) => {
    if (capability.available) return;
    entries.push({ key, title, appearance, body: capability.reason ?? 'Unavailable.' });
  };

  if (!capabilities.alerting.available && !capabilities.monitors.available) {
    // The one state worth interrupting for: neither mechanism can write, so nothing is
    // creatable. Said once, naming both reasons, rather than as two alerts that each imply
    // the other mechanism might still work.
    entries.push({
      key: 'nothing-creatable',
      title: 'Alerts cannot be created on this deployment',
      appearance: 'danger',
      body:
        `Cribl notifications: ${capabilities.alerting.reason ?? 'unavailable.'} Insights monitors: ` +
        `${capabilities.monitors.reason ?? 'unavailable.'} The table below is still a full coverage ` +
        'and health audit.',
    });
  } else {
    // Either one alone is a narrowed choice. Warning rather than danger, and the body says
    // what still works so the admin does not read it as "the app is broken".
    if (!capabilities.alerting.available) {
      entries.push({
        key: 'alerting',
        title: 'Cribl notifications cannot be created here',
        appearance: 'warning',
        body: `${capabilities.alerting.reason ?? 'Unavailable.'} Alerts are created as Insights monitors instead.`,
      });
    }
    if (!capabilities.monitors.available) {
      entries.push({
        key: 'monitors',
        title: 'Insights monitors cannot be created here',
        appearance: 'warning',
        body:
          `${capabilities.monitors.reason ?? 'Unavailable.'} Alerts are created as Cribl notifications ` +
          'instead, which are listed on the Insights alerts page but carry no chart of their own.',
      });
    }
  }

  push('routing', 'Notification routing targets could not be read', capabilities.routingTargets, 'info');
  push('registry', 'This app cannot record which alerts it created', capabilities.registry, 'warning');

  for (const note of perGroupNotes) {
    // The Pack is named because it is a different collection, not a different formatting of the
    // same one: "Sources in default were skipped" while the group's own Sources are on screen
    // reads as a contradiction.
    const scope = note.pack ? `Pack "${note.pack}" in "${note.group}"` : `"${note.group}"`;
    entries.push({
      key: `group-${note.group}-${note.pack ?? ''}-${note.direction}`,
      title: `${note.direction === 'source' ? 'Sources' : 'Destinations'} in ${scope} were skipped`,
      appearance: 'warning',
      body: `${note.message} Everything else loaded normally, so this table is incomplete rather than wrong.`,
    });
  }

  if (entries.length === 0 && notices.length === 0) return null;

  return (
    <div className="notice-stack">
      {entries.map((entry) => (
        <Alert key={entry.key} appearance={entry.appearance} title={entry.title} onDismiss>
          {entry.body}
        </Alert>
      ))}
      {notices.length > 0 ? (
        <Alert appearance="info" title="Worth knowing" onDismiss>
          <ul className="plain-list">
            {notices.map((notice) => (
              <li key={notice}>
                <Text variant="body-sm-normal">{notice}</Text>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}
