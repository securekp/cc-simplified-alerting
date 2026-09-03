/**
 * Schema-driven form logic. The app never hardcodes a condition's fields, so these tests
 * feed it schemas and assert on what it derives.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formFields, initialConf, pruneConf, validateConf } from '../src/lib/conditionForm.ts';
import type { ConditionSchema, NotificationCondition } from '../src/lib/types.ts';

const schema: ConditionSchema = {
  required: ['timeWindow'],
  properties: {
    name: { type: 'string', title: 'Destination' },
    timeWindow: { type: 'string', title: 'Time window', duration: { min: '60s' } },
    notifyOnResolution: { type: 'boolean', title: 'Notify on resolution', default: true },
    threshold: { type: 'number', minimum: 1, maximum: 100 },
    severity: { type: 'string', enum: ['warn', 'error'] },
    label: { type: 'string', pattern: '^[a-z]+$' },
  },
};

describe('formFields', () => {
  const fields = formFields(schema);

  it('never offers conf.name, which is the feed identity', () => {
    // A bulk template that let the admin type one feed name would create twenty alerts
    // all watching the same feed.
    assert.equal(
      fields.find((field) => field.key === 'name'),
      undefined,
    );
  });

  it('classifies each field from the schema', () => {
    const kinds = Object.fromEntries(fields.map((field) => [field.key, field.kind]));
    assert.deepEqual(kinds, {
      timeWindow: 'duration',
      notifyOnResolution: 'boolean',
      threshold: 'number',
      severity: 'enum',
      label: 'string',
    });
  });

  it('carries titles, requiredness, and the duration minimum in seconds', () => {
    const timeWindow = fields.find((field) => field.key === 'timeWindow');
    assert.equal(timeWindow?.label, 'Time window');
    assert.equal(timeWindow?.required, true);
    assert.equal(timeWindow?.minDurationSeconds, 60);
  });

  it('falls back to the key when the schema gives no title', () => {
    assert.equal(formFields({ properties: { foo: { type: 'string' } } })[0].label, 'foo');
  });

  it('returns nothing for a condition with no schema', () => {
    assert.deepEqual(formFields(undefined), []);
  });
});

describe('initialConf', () => {
  const condition: NotificationCondition = { id: 'unhealthy-dest', name: 'Unhealthy', schema };

  it('starts from the schema defaults', () => {
    assert.equal(initialConf(condition, undefined).notifyOnResolution, true);
  });

  it('overlays saved values', () => {
    assert.equal(initialConf(condition, { timeWindow: '5m' }).timeWindow, '5m');
  });

  it('drops saved keys the current schema does not declare', () => {
    // A stale template default must never smuggle an unknown key into a payload.
    assert.equal(Object.hasOwn(initialConf(condition, { removedField: 'x' }), 'removedField'), false);
  });

  it('defaults a boolean with no schema default to false rather than leaving it unset', () => {
    const values = initialConf({ id: 'c', name: 'c', schema: { properties: { flag: { type: 'boolean' } } } }, undefined);
    assert.equal(values.flag, false);
  });
});

describe('validateConf', () => {
  const fields = formFields(schema);

  it('accepts a valid form', () => {
    assert.deepEqual(
      validateConf(fields, {
        timeWindow: '60s',
        notifyOnResolution: true,
        threshold: 5,
        severity: 'warn',
        label: 'abc',
      }),
      {},
    );
  });

  it('requires a required field', () => {
    assert.equal(validateConf(fields, {}).timeWindow, 'Required.');
  });

  it('enforces the duration minimum Cribl declares', () => {
    assert.match(validateConf(fields, { timeWindow: '30s' }).timeWindow ?? '', /at least 60s/);
    assert.match(validateConf(fields, { timeWindow: 'soon' }).timeWindow ?? '', /like 60s, 5m, or 2h/);
    assert.equal(validateConf(fields, { timeWindow: '2h' }).timeWindow, undefined);
  });

  it('enforces numeric bounds and enum membership', () => {
    assert.match(validateConf(fields, { timeWindow: '60s', threshold: 0 }).threshold ?? '', /at least 1/);
    assert.match(validateConf(fields, { timeWindow: '60s', threshold: 101 }).threshold ?? '', /at most 100/);
    assert.match(validateConf(fields, { timeWindow: '60s', threshold: 'x' }).threshold ?? '', /must be a number/i);
    assert.match(validateConf(fields, { timeWindow: '60s', severity: 'panic' }).severity ?? '', /Must be one of/);
  });

  it('enforces a pattern but does not block on an unparseable one', () => {
    assert.match(validateConf(fields, { timeWindow: '60s', label: 'ABC' }).label ?? '', /Must match/);
    const broken = formFields({ properties: { label: { type: 'string', pattern: '([' } } });
    assert.deepEqual(validateConf(broken, { label: 'anything' }), {});
  });

  it('does not fail an optional field left empty', () => {
    assert.deepEqual(validateConf(fields, { timeWindow: '60s' }), {});
  });
});

describe('pruneConf', () => {
  const fields = formFields(schema);

  it('keeps only declared, non-empty fields', () => {
    assert.deepEqual(
      pruneConf(fields, { timeWindow: '60s', notifyOnResolution: false, severity: '', invented: 'x' }),
      { timeWindow: '60s', notifyOnResolution: false },
    );
  });

  it('drops name even if it is somehow present', () => {
    assert.equal(Object.hasOwn(pruneConf(fields, { name: 'other_feed' }), 'name'), false);
  });
});
