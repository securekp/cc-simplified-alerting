import { Button, Checkbox, SelectField, Text, TextField, ToggleButtonGroup } from '@capra/core';
import { Reload, Search } from '@capra/icons';
import { hasActiveFilters, type CoverageSummary, type FilterState } from '../lib/filters.ts';
import type { Direction, WorkerGroup } from '../lib/types.ts';

export interface HeaderBarProps {
  groups: readonly WorkerGroup[];
  filters: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  summary: CoverageSummary;
  loading: boolean;
  onReload: () => void;
  /** Drops every filter at once. Offered only while something is actually narrowing the table. */
  onClearFilters: () => void;
}

const ALL_GROUPS = '__all__';

export function HeaderBar({
  groups,
  filters,
  onChange,
  summary,
  loading,
  onReload,
  onClearFilters,
}: HeaderBarProps) {
  const groupItems = [
    { id: ALL_GROUPS, label: `All worker groups (${groups.length})` },
    // Just the name. This used to append "— no Workers" on `workerCount === 0`, which
    // read live against a group that had Workers running. The field is not a reliable
    // statement about a group, so it is not repeated to the admin as one.
    ...groups.map((group) => ({ id: group.id, label: group.name })),
  ];

  return (
    <div className="header-bar">
      <div className="header-row">
        <div className="header-control header-control-group">
          <SelectField
            label="Worker group"
            items={groupItems}
            value={filters.group ?? ALL_GROUPS}
            onChange={(key) =>
              onChange({ group: key === null || key === ALL_GROUPS ? null : String(key) })
            }
            canSearch={groups.length > 8}
            searchPlaceholder="Find a group"
          />
        </div>

        <div className="header-control">
          <Text variant="body-xs-semibold" color="subtle" as="div">
            Direction
          </Text>
          <ToggleButtonGroup
            aria-label="Direction filter"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[filters.direction ?? 'all']}
            onSelectionChange={(keys) => {
              const [key] = [...keys];
              onChange({
                direction: key === 'source' || key === 'destination' ? (key as Direction) : null,
              });
            }}
            items={[
              { key: 'all', text: 'All' },
              { key: 'source', text: 'Sources' },
              { key: 'destination', text: 'Destinations' },
            ]}
          />
        </div>

        <div className="header-control header-control-search">
          <TextField
            label="Search"
            placeholder="Feed id, type, or group"
            value={filters.search}
            onChange={(value) => onChange({ search: value })}
            leadingSlot={<Search />}
          />
        </div>

        <div className="header-control header-control-actions">
          <Button variant="secondary" leadingIcon={Reload} onClick={onReload} pending={loading}>
            Rescan
          </Button>
        </div>
      </div>

      <div className="header-row header-row-filters">
        <Checkbox
          checked={filters.uncoveredOnly}
          onChange={(event) => onChange({ uncoveredOnly: event.target.checked })}
        >
          Nothing watching it
        </Checkbox>
        {/*
          The union filter. It reads as one idea ("something is wrong with this feed") because that
          is what the urgent count below measures; the two narrower boxes stay for the admin who
          wants exactly one of the two signals.
        */}
        <Checkbox
          checked={filters.troubledOnly}
          onChange={(event) => onChange({ troubledOnly: event.target.checked })}
        >
          Not Green or erroring
        </Checkbox>
        <Checkbox
          checked={filters.unhealthyOnly}
          onChange={(event) => onChange({ unhealthyOnly: event.target.checked })}
        >
          Not Green
        </Checkbox>
        <Checkbox
          checked={filters.hasErrorOnly}
          onChange={(event) => onChange({ hasErrorOnly: event.target.checked })}
        >
          Has an error
        </Checkbox>
        {hasActiveFilters(filters) ? (
          <Button variant="tertiary" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <div className="header-row header-row-summary">
        <Text variant="body-sm-normal" color="subtle">
          {summary.total} enabled {summary.total === 1 ? 'feed' : 'feeds'} · {summary.unhealthy} not
          Green · {summary.withError} carrying an error · {summary.uncovered} with nothing watching for
          a delivery stop
        </Text>
        {summary.urgent > 0 ? (
          /*
           * The app's headline finding, and the one row set worth acting on first — so it is a
           * button, not a sentence. It sets the union filter *and* clears the two narrower ones,
           * because those AND together and would otherwise cut the very rows being offered.
           */
          <div className="header-urgent">
            <Text variant="body-sm-semibold" color="attention">
              {summary.urgent} {summary.urgent === 1 ? 'feed is' : 'feeds are'} in trouble with nothing
              watching for it.
            </Text>
            <Button
              variant="tertiary"
              size="sm"
              onClick={() =>
                onChange({
                  troubledOnly: true,
                  uncoveredOnly: true,
                  unhealthyOnly: false,
                  hasErrorOnly: false,
                })
              }
            >
              {summary.urgent === 1 ? 'Show it' : 'Show them'}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
