import { useMemo, useState } from 'react';
import { defineColumns, EmptyState, Pill, Table, Text } from '@capra/core';
import { CoverageCell } from './CoverageCell.tsx';
import { HealthCell } from './HealthCell.tsx';
import { truncate } from '../lib/format.ts';
import type { CoverageRow } from '../lib/rows.ts';
import type { AttributedAlert, Direction } from '../lib/types.ts';

export interface CoverageTableProps {
  rows: CoverageRow[];
  loading: boolean;
  selectedKeys: Set<string>;
  onSelectionChange: (keys: Set<string>) => void;
  /** Passed through to the coverage chips, which qualify a policy-routed alert with no policy. */
  policyCount: number | null;
  /** Opens an alert's configuration view. */
  onOpenAlert: (alert: AttributedAlert) => void;
}

const SORTABLE = new Set(['name', 'group', 'health', 'priority']);

/**
 * Sources and Destinations are shown as two separate tables under their own headings.
 *
 * They read as one list only if you notice a small subtitle on every row, and the two
 * directions are not interchangeable here: they have different health semantics, a
 * different metric, and — because the condition catalogue is asymmetric — a different
 * condition proving the same thing. Which one you are looking at should never be
 * something you have to squint for.
 */
const SECTIONS: { direction: Direction; title: string; label: string }[] = [
  { direction: 'source', title: 'Sources', label: 'Source alert coverage' },
  { direction: 'destination', title: 'Destinations', label: 'Destination alert coverage' },
];

export function CoverageTable(props: CoverageTableProps) {
  const { rows, loading, selectedKeys, onSelectionChange, onOpenAlert } = props;
  const [sort, setSort] = useState<{ column: string; direction: 'ascending' | 'descending' }>({
    column: 'priority',
    direction: 'descending',
  });

  const sorted = useMemo(() => {
    const factor = sort.direction === 'ascending' ? 1 : -1;
    const column = SORTABLE.has(sort.column) ? sort.column : 'priority';
    return [...rows].sort((a, b) => {
      if (column === 'priority') {
        // Ties inside a priority band fall back to the feed name, so the order is
        // stable rather than reshuffling on every render.
        return (a.priority - b.priority) * factor || a.name.localeCompare(b.name);
      }
      return String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * factor;
    });
  }, [rows, sort]);

  const columns = useMemo(
    () =>
      defineColumns<CoverageRow>([
        {
          id: 'name',
          label: 'Feed',
          allowsSorting: true,
          render: (_value, item) => (
            <span className="cell-stack">
              <Text variant="body-sm-semibold">{item.name}</Text>
              {/* Just the type. The direction is the section heading above, so repeating
                  it on every row was the only thing telling the two apart. */}
              <Text variant="body-xs-normal" color="subtle">
                {item.feed.type || 'unknown type'}
              </Text>
            </span>
          ),
        },
        { id: 'group', label: 'Worker group', allowsSorting: true },
        {
          id: 'health',
          label: 'Health',
          allowsSorting: true,
          render: (_value, item) => <HealthCell feed={item.feed} />,
        },
        {
          id: 'error',
          label: 'Error',
          // Its own always-visible column, not a detail behind an expander: feeds were
          // observed reporting "Green" while carrying a status error, so health alone
          // does not tell the admin a feed is not fine.
          render: (_value, item) =>
            item.error ? (
              <span className="cell-stack" title={item.error}>
                <Pill appearance="danger" variant="muted">
                  Error
                </Pill>
                <Text variant="body-xs-normal" color="subtle">
                  {truncate(item.error, 60)}
                </Text>
              </span>
            ) : (
              <Text variant="body-xs-normal" color="subtle">
                —
              </Text>
            ),
        },
        {
          id: 'alerts',
          // One column, because there is one question: is anything watching this feed for
          // a delivery stop? A Source answers it with `no-data`, a Destination with
          // `unhealthy-dest`, and the admin does not need to care which.
          label: 'Alert',
          render: (_value, item) => (
            <CoverageCell
              alerts={item.alerts}
              other={item.other}
              emptyLabel="Nothing is watching this feed"
              policyCount={props.policyCount}
              onOpen={onOpenAlert}
            />
          ),
        },
      ]),
    [onOpenAlert, props.policyCount],
  );

  const sections = useMemo(
    () =>
      SECTIONS.map((section) => {
        const sectionRows = sorted.filter((row) => row.direction === section.direction);
        return {
          ...section,
          rows: sectionRows,
          // Counted from the rows on screen, so it agrees with what the filters left
          // visible rather than with the whole deployment.
          unwatched: sectionRows.filter((row) => !row.alerts.some((alert) => !alert.disabled)).length,
        };
      // A direction the filters excluded gets no empty table and no heading.
      }).filter((section) => section.rows.length > 0),
    [sorted],
  );

  if (!loading && rows.length === 0) {
    return (
      <EmptyState
        title="No feeds match these filters"
        description="Clear the filters or pick another worker group. Disabled Sources and Destinations are never listed."
      />
    );
  }

  return (
    <div className="coverage-sections">
      {sections.map((section) => (
        <section key={section.direction} className="coverage-section">
          <div className="coverage-section-head">
            <Text variant="body-md-semibold">{section.title}</Text>
            <Pill variant="muted">{String(section.rows.length)}</Pill>
            {section.unwatched > 0 ? (
              <Pill appearance="warning" variant="muted">
                {`${section.unwatched} unwatched`}
              </Pill>
            ) : null}
          </div>
          <Table<CoverageRow>
            items={section.rows}
            columns={columns}
            visibleColumns={['name', 'group', 'health', 'error', 'alerts']}
            density="compact"
            appearance="zebra"
            isLoading={loading}
            selectionMode="multiple"
            // Scoped to this section, so the header checkbox reflects this table rather
            // than reading as half-selected because the other direction is selected.
            selectedKeys={new Set(section.rows.filter((row) => selectedKeys.has(row.id)).map((row) => row.id))}
            onSelectionChange={(keys) => {
              // `'all'` is react-aria's sentinel for the header checkbox. Expand it to
              // this section's rows, so apply never touches a feed the admin cannot see.
              const next =
                keys === 'all'
                  ? new Set(section.rows.map((row) => row.id))
                  : new Set([...keys].map((key) => String(key)));
              // Selection is shared across both tables, so replace only this section's
              // contribution and leave the other direction's rows selected.
              const merged = new Set([...selectedKeys].filter((key) => !sectionKeys(section.rows).has(key)));
              for (const key of next) merged.add(key);
              onSelectionChange(merged);
            }}
            sortDescriptor={{ column: sort.column, direction: sort.direction }}
            onSortChange={(descriptor) =>
              setSort({
                column: String(descriptor.column ?? 'priority'),
                direction: descriptor.direction ?? 'descending',
              })
            }
            aria-label={section.label}
          />
        </section>
      ))}
    </div>
  );
}

function sectionKeys(rows: readonly CoverageRow[]): Set<string> {
  return new Set(rows.map((row) => row.id));
}
