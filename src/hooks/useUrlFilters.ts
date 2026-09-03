/**
 * Filters live in the URL, not in the KV store.
 *
 * That is deliberate: a filtered view is a thing you share or bookmark ("here is the
 * uncovered list"), not a preference that should follow you into every future session.
 * Template settings are the opposite, and those do get persisted.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_FILTERS, type FilterState } from '../lib/filters.ts';
import type { Direction } from '../lib/types.ts';

function readDirection(value: string | null): Direction | null {
  return value === 'source' || value === 'destination' ? value : null;
}

export interface UrlFilters {
  filters: FilterState;
  setFilters: (patch: Partial<FilterState>) => void;
  reset: () => void;
}

export function useUrlFilters(): UrlFilters {
  const [params, setParams] = useSearchParams();

  const filters = useMemo<FilterState>(
    () => ({
      group: params.get('group') ?? DEFAULT_FILTERS.group,
      direction: readDirection(params.get('direction')),
      uncoveredOnly: params.get('uncovered') === '1',
      unhealthyOnly: params.get('unhealthy') === '1',
      hasErrorOnly: params.get('error') === '1',
      troubledOnly: params.get('trouble') === '1',
      search: params.get('q') ?? '',
    }),
    [params],
  );

  const setFilters = useCallback(
    (patch: Partial<FilterState>) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          const assign = (key: string, value: string | null) => {
            if (value === null || value === '' || value === '0') next.delete(key);
            else next.set(key, value);
          };
          if ('group' in patch) assign('group', patch.group ?? null);
          if ('direction' in patch) assign('direction', patch.direction ?? null);
          if ('uncoveredOnly' in patch) assign('uncovered', patch.uncoveredOnly ? '1' : null);
          if ('unhealthyOnly' in patch) assign('unhealthy', patch.unhealthyOnly ? '1' : null);
          if ('hasErrorOnly' in patch) assign('error', patch.hasErrorOnly ? '1' : null);
          if ('troubledOnly' in patch) assign('trouble', patch.troubledOnly ? '1' : null);
          if ('search' in patch) assign('q', patch.search ?? null);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);

  return { filters, setFilters, reset };
}
