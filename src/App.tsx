import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Spinner, Text } from '@capra/core';
import { AlertConfigModal } from './components/AlertConfigModal.tsx';
import { BulkApplyDrawer } from './components/BulkApplyDrawer.tsx';
import { CapabilityNotices } from './components/CapabilityNotices.tsx';
import { CoverageTable } from './components/CoverageTable.tsx';
import { HeaderBar } from './components/HeaderBar.tsx';
import { useDiscovery } from './hooks/useDiscovery.ts';
import { useUrlFilters } from './hooks/useUrlFilters.ts';
import { isCovered, matchesFilters, summarise } from './lib/filters.ts';
import { buildRows, describeSelection } from './lib/rows.ts';
import type { AttributedAlert, Feed } from './lib/types.ts';

export default function App() {
  const discovery = useDiscovery();
  const { filters, setFilters, reset } = useUrlFilters();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openAlert, setOpenAlert] = useState<AttributedAlert | null>(null);
  /*
   * Did the run that is still on screen write anything?
   *
   * A ref, and consumed on *close*, because the selection is what feeds the drawer: clearing it
   * the moment an alert is created would empty `feeds` and blank the results list the admin is
   * reading. Left uncleared, the action bar goes on offering "12 selected → Create alerts…" for
   * feeds that are now watched, which is an invitation to author a second alert on each.
   */
  const appliedSomething = useRef(false);

  // Feeds passing the current filters. Discovery always loads every group; the group
  // filter narrows the view, it does not narrow the fetch (see useDiscovery).
  const visibleFeeds = useMemo(
    () =>
      discovery.feeds.filter((feed) =>
        matchesFilters(feed, discovery.coverage.get(feed.rowId), filters),
      ),
    [discovery.feeds, discovery.coverage, filters],
  );

  const rows = useMemo(
    () => buildRows(visibleFeeds, discovery.coverage),
    [visibleFeeds, discovery.coverage],
  );

  const summary = useMemo(
    () => summarise(visibleFeeds, discovery.coverage),
    [visibleFeeds, discovery.coverage],
  );

  // A selection only ever means feeds that are currently visible. Narrowing a filter
  // must not leave a hidden feed queued up for creation.
  const selectedFeeds = useMemo<Feed[]>(
    () => visibleFeeds.filter((feed) => selected.has(feed.rowId)),
    [visibleFeeds, selected],
  );

  // The rows "select all uncovered" would take. Held rather than recomputed on click so the
  // button can carry the count and refuse the click at zero — where it was previously a dead
  // press that also wiped whatever the admin had already ticked.
  const uncoveredRowIds = useMemo(
    () =>
      visibleFeeds
        .filter((feed) => !isCovered(discovery.coverage.get(feed.rowId)))
        .map((feed) => feed.rowId),
    [visibleFeeds, discovery.coverage],
  );

  const selectAllUncovered = () => setSelected(new Set(uncoveredRowIds));

  const reload = discovery.reload;
  const handleApplied = useCallback(() => {
    appliedSomething.current = true;
    reload();
  }, [reload]);

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
    if (appliedSomething.current) {
      appliedSomething.current = false;
      setSelected(new Set());
    }
  }, []);

  if (discovery.fatal) {
    return (
      <div className="app">
        <Alert
          appearance="danger"
          title="Simplified Alerting could not read your worker groups"
          action={{ label: 'Try again', onClick: discovery.reload }}
        >
          {discovery.fatal} Without the worker-group list there is nothing to enumerate Sources and
          Destinations against, so the table cannot be built.
        </Alert>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <Text variant="heading-md" as="h1">
          Alert coverage
        </Text>
        <Text variant="body-sm-normal" color="subtle" as="p">
          Every enabled Source and Destination, its health right now, and whether anything is
          watching it stop delivering data. Alerts are either Cribl notifications on conditions this
          deployment actually offers, or Insights monitors on the Insights alerts page. This app
          authors them — Cribl evaluates them.
        </Text>
      </header>

      <CapabilityNotices
        capabilities={discovery.capabilities}
        notices={discovery.notices}
        perGroupNotes={discovery.perGroupNotes}
      />

      <HeaderBar
        groups={discovery.groups}
        filters={filters}
        onChange={setFilters}
        summary={summary}
        loading={discovery.loading}
        onReload={discovery.reload}
        onClearFilters={reset}
      />

      {discovery.unattributed.length > 0 ? (
        <Collapse
          title={`${discovery.unattributed.length} existing alerts could not be tied to one feed`}
        >
          <Text variant="body-xs-normal" color="subtle" as="p">
            These exist in Cribl but this app will not claim they cover a specific feed, because it
            could not tell which one they watch. They are not counted as coverage anywhere —
            assuming would be worse than saying so.
          </Text>
          <ul className="plain-list">
            {discovery.unattributed.map((alert) => (
              <li key={alert.id}>
                <Text variant="body-xs-normal">
                  {alert.id} — {alert.reason}
                </Text>
              </li>
            ))}
          </ul>
        </Collapse>
      ) : null}

      <div className="table-actions">
        <Button
          variant="secondary"
          onClick={selectAllUncovered}
          disabled={uncoveredRowIds.length === 0}
        >
          {`Select all uncovered (${uncoveredRowIds.length})`}
        </Button>
        {selected.size > 0 ? (
          <Button variant="tertiary" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        ) : null}
        {discovery.loading ? (
          <span className="cell-inline">
            <Spinner size="sm" />
            <Text variant="body-xs-normal" color="subtle">
              Loading groups, feeds, conditions, and existing alerts…
            </Text>
          </span>
        ) : null}
      </div>

      <CoverageTable
        rows={rows}
        loading={discovery.loading}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        policyCount={discovery.notificationPolicyCount}
        onOpenAlert={setOpenAlert}
      />

      <AlertConfigModal
        alert={openAlert}
        conditionsById={discovery.conditionsById}
        policyCount={discovery.notificationPolicyCount}
        onClose={() => setOpenAlert(null)}
      />

      {selectedFeeds.length > 0 ? (
        <div className="action-bar">
          <Text variant="body-sm-semibold">
            {describeSelection(rows, selected)} selected
          </Text>
          <Button variant="primary" onClick={() => setDrawerOpen(true)}>
            Create alerts…
          </Button>
        </div>
      ) : null}

      <BulkApplyDrawer
        open={drawerOpen}
        onClose={handleDrawerClose}
        feeds={selectedFeeds}
        allFeeds={discovery.feeds}
        coverage={discovery.coverage}
        conditionsById={discovery.conditionsById}
        conditionsByDirection={discovery.conditionsByDirection}
        capabilities={discovery.capabilities}
        targets={discovery.targets}
        templates={discovery.notificationTemplates}
        templatesReason={discovery.notificationTemplatesReason}
        policyCount={discovery.notificationPolicyCount}
        policyReason={discovery.notificationPolicyReason}
        monitorHost={discovery.monitorHost?.group ?? null}
        monitorTemplates={discovery.monitorTemplates}
        templateDefaults={discovery.templateDefaults}
        onApplied={handleApplied}
      />
    </div>
  );
}
