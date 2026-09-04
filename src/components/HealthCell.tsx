import { useCallback, useState } from 'react';
import { IconButton, Pill, Popover, Spinner, Text } from '@capra/core';
import { ChevronDown } from '@capra/icons';
import { fetchHealthDetail, type FeedScope, type HealthDetail } from '../api/feeds.ts';
import { describeError } from '../api/client.ts';
import { formatTimestamp } from '../lib/format.ts';
import type { Direction, Feed, Health } from '../lib/types.ts';

/** Health maps onto Capra's semantic appearances so it reads right in both themes. */
const APPEARANCE: Record<Health, 'success' | 'warning' | 'danger' | 'default'> = {
  Green: 'success',
  Yellow: 'warning',
  Red: 'danger',
  Unknown: 'default',
};

/**
 * One in-flight fetch per scope+direction, shared across every row.
 *
 * Without this, expanding five rows in a group fires five identical requests for the
 * same list. The Pack is part of the key because it is part of the collection: a Pack's status
 * list is a different response, and keying without it would hand a Pack row the group's list —
 * where its feed is absent — and report "not in the status response" for a feed that is fine.
 */
const detailCache = new Map<string, Promise<Map<string, HealthDetail>>>();

function loadDetail(scope: FeedScope, direction: Direction): Promise<Map<string, HealthDetail>> {
  const key = `${scope.group}|${scope.pack ?? ''}|${direction}`;
  const existing = detailCache.get(key);
  if (existing) return existing;
  const promise = fetchHealthDetail(scope, direction).catch((error: unknown) => {
    // Do not cache a failure: the admin may retry after fixing permissions.
    detailCache.delete(key);
    throw error;
  });
  detailCache.set(key, promise);
  return promise;
}

export interface HealthCellProps {
  feed: Feed;
}

export function HealthCell({ feed }: HealthCellProps) {
  const [detail, setDetail] = useState<HealthDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open || detail || loading) return;
      setLoading(true);
      setError(null);
      loadDetail({ group: feed.group, pack: feed.pack }, feed.direction)
        .then((byId) => {
          const entry = byId.get(feed.id);
          if (entry) setDetail(entry);
          else setError('This feed was not in the status response.');
        })
        .catch((cause: unknown) => setError(describeError(cause)))
        .finally(() => setLoading(false));
    },
    [detail, loading, feed.group, feed.pack, feed.direction, feed.id],
  );

  const counts = detail ? Object.entries(detail.healthCounts) : [];

  return (
    <span className="cell-inline">
      <Pill appearance={APPEARANCE[feed.health]} variant="muted">
        {feed.healthKnown ? feed.health : 'Unknown'}
      </Pill>
      <Popover
        onOpenChange={onOpenChange}
        content={
          <div className="popover-body">
            <Text variant="body-sm-semibold" as="p">
              Worker Process health — {feed.id}
            </Text>
            {loading ? <Spinner size="sm" title="Loading health detail" /> : null}
            {error ? (
              <Text variant="body-xs-normal" color="subtle" as="p">
                Per-process detail unavailable: {error} The health above still comes from discovery.
              </Text>
            ) : null}
            {detail && counts.length > 0 ? (
              <ul className="plain-list">
                {counts.map(([state, count]) => (
                  <li key={state}>
                    <Text variant="body-xs-normal">
                      {state}: {count}
                    </Text>
                  </li>
                ))}
              </ul>
            ) : null}
            {detail && counts.length === 0 && !error ? (
              <Text variant="body-xs-normal" color="subtle" as="p">
                No per-process breakdown was reported.
              </Text>
            ) : null}
            {detail?.error ? (
              <Text variant="body-xs-normal" color="attention" as="p">
                Reported error: {detail.error}
              </Text>
            ) : null}
            {detail ? (
              <Text variant="body-xs-normal" color="subtle" as="p">
                As of {formatTimestamp(detail.timestamp)}
              </Text>
            ) : null}
          </div>
        }
      >
        <IconButton
          icon={ChevronDown}
          size="sm"
          variant="tertiary"
          aria-label={`Show Worker Process health for ${feed.id}`}
        />
      </Popover>
    </span>
  );
}
