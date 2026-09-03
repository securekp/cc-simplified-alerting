/** Display helpers. Duration parsing is load-bearing: it validates condition schemas. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatBytes,
  formatDurationSeconds,
  formatTimestamp,
  parseDurationSeconds,
  truncate,
} from '../src/lib/format.ts';

describe('parseDurationSeconds', () => {
  it('parses the Cribl duration spellings', () => {
    assert.equal(parseDurationSeconds('60s'), 60);
    assert.equal(parseDurationSeconds(' 5m '), 300);
    assert.equal(parseDurationSeconds('2h'), 7200);
    assert.equal(parseDurationSeconds('1d'), 86_400);
  });

  it('returns null rather than a plausible number for anything else', () => {
    for (const value of ['', '60', 'm', '1.5m', '-5s', '5 minutes', '5w']) {
      assert.equal(parseDurationSeconds(value), null, `${value} must not parse`);
    }
  });

  it('round-trips through formatDurationSeconds', () => {
    for (const value of ['45s', '5m', '2h', '1d']) {
      assert.equal(formatDurationSeconds(parseDurationSeconds(value) as number), value);
    }
  });
});

describe('formatBytes', () => {
  it('scales and never reports a negative or non-finite value as data', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024 * 20), '20 MB');
  });
});

describe('formatTimestamp', () => {
  it('says unknown instead of inventing a date', () => {
    assert.equal(formatTimestamp(null), 'unknown');
    assert.equal(formatTimestamp(Number.NaN), 'unknown');
  });
});

describe('truncate', () => {
  it('marks that truncation happened', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc', 4), 'abc');
  });
});
