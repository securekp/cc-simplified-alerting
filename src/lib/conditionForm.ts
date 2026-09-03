/**
 * Driving the connectivity form from the condition's own JSON Schema.
 *
 * The app never hardcodes a condition's fields. `GET /conditions` returns a schema per
 * condition — titles, descriptions, enums, patterns, duration minimums — and this module
 * turns that into a field list plus validation. A future Cribl version that renames
 * `timeWindow` therefore produces a differently-labelled form, not a payload with a
 * silently dropped field.
 */

import { parseDurationSeconds } from './format.ts';
import type { ConditionField, ConditionSchema, NotificationCondition } from './types.ts';

/**
 * `conf.name` is the feed identity and is set per feed by the payload builder, so it is
 * never offered as an editable field — a bulk template that let the admin type one
 * feed name would create twenty alerts all watching the same feed.
 */
const RESERVED_FIELDS = new Set(['name']);

export type FieldKind = 'boolean' | 'number' | 'enum' | 'duration' | 'string';

export interface FormField {
  key: string;
  kind: FieldKind;
  label: string;
  description?: string;
  required: boolean;
  options: string[];
  /** Minimum duration in seconds, from the schema's `duration.min`. */
  minDurationSeconds: number | null;
  minimum: number | null;
  maximum: number | null;
  pattern: string | null;
  default: unknown;
}

function kindOf(key: string, field: ConditionField): FieldKind {
  if (Array.isArray(field.enum) && field.enum.length > 0) return 'enum';
  if (field.type === 'boolean') return 'boolean';
  if (field.type === 'number' || field.type === 'integer') return 'number';
  // A duration is a string in the schema; the `duration` extension or the field name is
  // what marks it as one, and it needs different validation from free text.
  if (field.duration || /window|interval|duration|timeout/i.test(key)) return 'duration';
  return 'string';
}

export function formFields(schema: ConditionSchema | undefined): FormField[] {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(properties)
    .filter(([key]) => !RESERVED_FIELDS.has(key))
    .map(([key, field]) => ({
      key,
      kind: kindOf(key, field),
      label: field.title ?? key,
      description: field.description,
      required: required.has(key),
      options: Array.isArray(field.enum) ? field.enum.map((value) => String(value)) : [],
      minDurationSeconds: field.duration?.min ? parseDurationSeconds(field.duration.min) : null,
      minimum: typeof field.minimum === 'number' ? field.minimum : null,
      maximum: typeof field.maximum === 'number' ? field.maximum : null,
      pattern: typeof field.pattern === 'string' ? field.pattern : null,
      default: field.default,
    }));
}

/**
 * Starting values: the schema's defaults, overlaid with anything saved from last time.
 *
 * Saved values for fields the current schema does not have are dropped, so a stale
 * template default can never smuggle an unknown key into a payload.
 */
export function initialConf(
  condition: NotificationCondition | undefined,
  saved: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const fields = formFields(condition?.schema);
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (saved && Object.hasOwn(saved, field.key)) {
      values[field.key] = saved[field.key];
    } else if (field.default !== undefined) {
      values[field.key] = field.default;
    } else if (field.kind === 'boolean') {
      values[field.key] = false;
    }
  }
  return values;
}

/** Field key → message. An empty object means the form is valid. */
export function validateConf(
  fields: readonly FormField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    const empty = value === undefined || value === null || value === '';

    if (field.required && empty && field.kind !== 'boolean') {
      errors[field.key] = 'Required.';
      continue;
    }
    if (empty) continue;

    if (field.kind === 'number') {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        errors[field.key] = 'Must be a number.';
      } else if (field.minimum !== null && numeric < field.minimum) {
        errors[field.key] = `Must be at least ${field.minimum}.`;
      } else if (field.maximum !== null && numeric > field.maximum) {
        errors[field.key] = `Must be at most ${field.maximum}.`;
      }
      continue;
    }

    if (field.kind === 'duration') {
      const seconds = parseDurationSeconds(String(value));
      if (seconds === null) {
        errors[field.key] = 'Use a duration like 60s, 5m, or 2h.';
      } else if (field.minDurationSeconds !== null && seconds < field.minDurationSeconds) {
        errors[field.key] = `Cribl requires at least ${field.minDurationSeconds}s here.`;
      }
      continue;
    }

    if (field.kind === 'enum' && !field.options.includes(String(value))) {
      errors[field.key] = `Must be one of: ${field.options.join(', ')}.`;
      continue;
    }

    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(String(value))) {
          errors[field.key] = `Must match ${field.pattern}.`;
        }
      } catch {
        // An unparseable pattern is the schema's problem, not the admin's — don't
        // block the form over it.
        console.warn(`[cc-simplified-alerting] condition field ${field.key} has an invalid pattern.`);
      }
    }
  }
  return errors;
}

/** Drop keys the schema does not declare, so the payload carries only known fields. */
export function pruneConf(
  fields: readonly FormField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(fields.map((field) => field.key));
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key) && value !== undefined && value !== '') pruned[key] = value;
  }
  return pruned;
}
