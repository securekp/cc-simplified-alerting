/**
 * The Notification condition catalogue.
 *
 * Condition ids and their `conf` schemas are discovered here and never hardcoded, so
 * the app survives version differences and never fabricates a condition id. Each
 * condition carries a JSON Schema for its `conf` fields; the configure form is
 * generated from that schema.
 */

import { fetchAllUnique } from './client.ts';
import type { ConditionSchema, Direction, NotificationCondition } from '../lib/types.ts';

interface RawCondition {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  type?: unknown;
  schema?: unknown;
  description?: unknown;
}

export function categoryFor(direction: Direction): 'sources' | 'destinations' {
  return direction === 'source' ? 'sources' : 'destinations';
}

function toCondition(raw: RawCondition): NotificationCondition | null {
  if (typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    schema:
      raw.schema && typeof raw.schema === 'object' && !Array.isArray(raw.schema)
        ? (raw.schema as ConditionSchema)
        : undefined,
  };
}

/**
 * Conditions for one direction.
 *
 * `showHidden` is deliberately left off: a hidden condition is one Cribl does not
 * offer in its own Notification UI, and this app is an authoring front-end for that
 * same feature — offering more than Cribl does would be authoring configuration the
 * platform may not intend to support.
 */
export async function fetchConditions(
  direction: Direction,
  signal?: AbortSignal,
): Promise<NotificationCondition[]> {
  const raw = await fetchAllUnique<RawCondition>(
    '/conditions',
    (item) => (typeof item.id === 'string' ? item.id : null),
    { query: { category: categoryFor(direction), showHidden: false }, signal },
  );
  const conditions: NotificationCondition[] = [];
  for (const entry of raw) {
    const condition = toCondition(entry);
    // Trust the request filter but verify it: an unfiltered response would otherwise
    // mix Destination conditions into the Source list and break direction inference.
    if (condition && (!condition.category || condition.category === categoryFor(direction))) {
      conditions.push(condition);
    }
  }
  return conditions;
}
