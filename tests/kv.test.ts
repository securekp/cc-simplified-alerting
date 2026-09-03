/**
 * The KV store is the app's only persistence, so its round-trip has to be exact.
 *
 * Two rules are load-bearing here. Values are written as serialized strings, per the
 * Cribl Apps KV guidance. And reads accept both a string and a raw object, because a
 * value written by an earlier build is still out there — a decode that only handled one
 * form would silently drop the registry and make every covered feed look unmanaged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  kvGet,
  kvListKeys,
  kvPut,
  loadRegistry,
  loadTemplateDefaults,
  normalizeRegistryKey,
  registryKindOf,
  saveRegistryEntry,
  saveTemplateDefaults,
} from '../src/api/kv.ts';

interface Capture {
  url: string;
  method: string;
  body: string | undefined;
}

/** Stub the platform globals, capturing what was requested. */
function installFetch(
  respond: (url: string, requestBody: string | undefined) => { status: number; body: string },
) {
  const calls: Capture[] = [];
  globalThis.window = { CRIBL_API_URL: 'https://cribl.test/api/v1' } as unknown as Window &
    typeof globalThis;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const requestBody = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body: requestBody });
    const { status, body } = respond(url, requestBody);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return calls;
}

/** The prefix a `POST /kvstore/keys` call asked for. */
function listedPrefix(requestBody: string | undefined): string {
  const parsed: unknown = JSON.parse(requestBody ?? '{}');
  const prefix = (parsed as { prefix?: unknown }).prefix;
  return typeof prefix === 'string' ? prefix : '';
}

const ok = (body: string) => () => ({ status: 200, body });

describe('kvPut', () => {
  it('serializes the value to a string instead of sending a bare object', () => {
    const calls = installFetch(ok('{}'));
    void kvPut('cc-simplified-alerting/thing', { id: 'n1', nested: { deep: true } });
    assert.equal(calls[0].method, 'PUT');
    // The body is a JSON string *literal*, so parsing once yields the string and twice
    // yields the object. That is what "serialized as a string" means on the wire.
    const once: unknown = JSON.parse(calls[0].body ?? '');
    assert.equal(typeof once, 'string');
    assert.deepEqual(JSON.parse(once as string), { id: 'n1', nested: { deep: true } });
  });

  it('encodes each key segment but leaves the store’s own path separator alone', () => {
    const calls = installFetch(ok('{}'));
    void kvPut('cc-simplified-alerting/managed/notification/ally-default-in syslog', {});
    assert.match(calls[0].url, /\/kvstore\/cc-simplified-alerting\/managed\/notification\//);
    assert.match(calls[0].url, /in%20syslog$/);
  });
});

describe('kvGet', () => {
  it('reads back a value this app wrote', async () => {
    installFetch(ok(JSON.stringify(JSON.stringify({ id: 'n1' }))));
    assert.deepEqual(await kvGet('k'), { id: 'n1' });
  });

  it('reads back a raw object, as an earlier build would have written it', async () => {
    // No migration is performed, so this form has to keep working indefinitely.
    installFetch(ok(JSON.stringify({ id: 'n1' })));
    assert.deepEqual(await kvGet('k'), { id: 'n1' });
  });

  it('treats a missing key as absent rather than an error', async () => {
    installFetch(() => ({ status: 404, body: 'not found' }));
    assert.equal(await kvGet('k'), null);
  });

  it('returns null for an unreadable value instead of throwing', async () => {
    // A corrupt cache entry must not stop the app loading.
    installFetch(ok('"{not json"'));
    assert.equal(await kvGet('k'), null);
  });

  it('returns null for an empty value', async () => {
    installFetch(ok(''));
    assert.equal(await kvGet('k'), null);
  });

  it('propagates a denial, so the caller can say the registry is unreadable', async () => {
    installFetch(() => ({ status: 403, body: '{"message":"nope"}' }));
    await assert.rejects(kvGet('k'), /403|permitted/i);
  });
});

describe('kvListKeys', () => {
  // The bug this guards against: an unrecognised envelope used to read as "no keys", so a
  // readable-looking registry came back empty and every alert the app had created was
  // labelled "Not created by this app" — with no warning anywhere.
  it('accepts a bare array', async () => {
    installFetch(ok(JSON.stringify(['a', 'b'])));
    assert.deepEqual(await kvListKeys('p'), ['a', 'b']);
  });

  it('accepts the items and keys envelopes', async () => {
    installFetch(ok(JSON.stringify({ items: ['a'], count: 1 })));
    assert.deepEqual(await kvListKeys('p'), ['a']);
    installFetch(ok(JSON.stringify({ keys: ['a'] })));
    assert.deepEqual(await kvListKeys('p'), ['a']);
  });

  it('accepts keys wrapped in objects', async () => {
    installFetch(ok(JSON.stringify({ items: [{ key: 'a' }, { name: 'b' }, { id: 'c' }] })));
    assert.deepEqual(await kvListKeys('p'), ['a', 'b', 'c']);
  });

  it('reports an empty list as empty', async () => {
    installFetch(ok(JSON.stringify({ items: [], count: 0 })));
    assert.deepEqual(await kvListKeys('p'), []);
  });

  it('throws rather than reporting an unrecognised shape as an empty registry', async () => {
    installFetch(ok(JSON.stringify({ status: 'error', message: 'nope' })));
    await assert.rejects(kvListKeys('p'), /unrecognised shape/);
  });
});

describe('normalizeRegistryKey', () => {
  it('accepts a full key, a kind-relative key, and a bare id', () => {
    const full = 'cc-simplified-alerting/managed/notification/ally-default-in_syslog';
    assert.equal(normalizeRegistryKey(full), full);
    assert.equal(normalizeRegistryKey('notification/ally-default-in_syslog'), full);
    assert.equal(normalizeRegistryKey('ally-default-in_syslog'), full);
    assert.equal(normalizeRegistryKey('/ally-default-in_syslog'), full);
  });

  it('keeps a bare id under the kind it was listed from', () => {
    // The two mechanisms produce the *same* id for a feed, so a bare key from the monitor
    // listing must not be normalised onto the Notification path — that is how one record
    // would overwrite the other and the app would forget which mechanism it used.
    assert.equal(
      normalizeRegistryKey('ally-default-in_syslog', 'monitor'),
      'cc-simplified-alerting/managed/monitor/ally-default-in_syslog',
    );
    assert.equal(
      normalizeRegistryKey('monitor/ally-default-in_syslog', 'notification'),
      'cc-simplified-alerting/managed/monitor/ally-default-in_syslog',
      'an explicit kind in the listed key wins over the queried one',
    );
  });
});

describe('registryKindOf', () => {
  it('reads the mechanism the record itself recorded, defaulting to a Notification', () => {
    assert.equal(registryKindOf({ settings: { mechanism: 'monitor' } }), 'monitor');
    assert.equal(registryKindOf({ settings: { mechanism: 'notification' } }), 'notification');
    // Records written before the monitor mechanism existed have no mechanism at all.
    assert.equal(registryKindOf({ settings: {} }), 'notification');
  });
});

describe('loadRegistry', () => {
  const record = {
    id: 'ally-default-in_syslog',
    signal: 'volume',
    group: 'default',
    direction: 'source',
    feedId: 'in_syslog',
    settings: {},
    createdAt: 1,
  };

  /** Serve one list per kind, then the record behind every key. */
  function installRegistry(byKind: Record<string, string[]>, value: () => { status: number; body: string }) {
    return installFetch((url, body) => {
      if (!url.includes('/kvstore/keys')) return value();
      const kind = listedPrefix(body).split('/').pop() ?? '';
      return { status: 200, body: JSON.stringify({ items: byKind[kind] ?? [] }) };
    });
  }

  it('reads the records behind the listed keys', async () => {
    installRegistry({ notification: ['ally-default-in_syslog'] }, () => ({
      status: 200,
      body: JSON.stringify(JSON.stringify(record)),
    }));
    const load = await loadRegistry();
    assert.deepEqual(load.records, [record]);
    assert.deepEqual(load.unreadable, []);
  });

  it('lists both mechanisms, so a monitor record is not invisible', async () => {
    const monitorRecord = { ...record, settings: { mechanism: 'monitor' } };
    const calls = installRegistry(
      { notification: ['ally-default-in_syslog'], monitor: ['ally-default-in_syslog'] },
      () => ({ status: 200, body: JSON.stringify(JSON.stringify(monitorRecord)) }),
    );
    const load = await loadRegistry();
    // Same id, two paths, two records: the ids collide by design because the objects live in
    // different Cribl collections, and one KV path would silently drop one of them.
    assert.equal(load.records.length, 2);
    const prefixes = calls
      .filter((call) => call.url.includes('/kvstore/keys'))
      .map((call) => listedPrefix(call.body));
    assert.deepEqual(prefixes, [
      'cc-simplified-alerting/managed/notification',
      'cc-simplified-alerting/managed/monitor',
    ]);
  });

  it('counts a listed key whose value will not read back', async () => {
    // The app wrote the key and cannot read it: that is exactly the state that makes an
    // app-created alert look like somebody else's, so it is reported, not skipped.
    installRegistry({ notification: ['ally-default-in_syslog'] }, () => ({
      status: 404,
      body: 'not found',
    }));
    const load = await loadRegistry();
    assert.deepEqual(load.records, []);
    assert.equal(load.unreadable.length, 1);
  });

  it('fails the whole read when one listing fails, rather than half a registry', async () => {
    installFetch((url, body) => {
      if (!url.includes('/kvstore/keys')) return { status: 200, body: '{}' };
      return listedPrefix(body).endsWith('monitor')
        ? { status: 403, body: '{"message":"nope"}' }
        : { status: 200, body: JSON.stringify({ items: [] }) };
    });
    await assert.rejects(loadRegistry(), /403|permitted/i);
  });
});

describe('saveRegistryEntry', () => {
  it('writes a monitor record to the monitor path, not the Notification one', async () => {
    const calls = installFetch(ok('{}'));
    await saveRegistryEntry({
      id: 'ally-default-in_syslog',
      signal: 'volume',
      group: 'default',
      direction: 'source',
      feedId: 'in_syslog',
      settings: { mechanism: 'monitor', hostGroup: 'default_search' },
    });
    assert.match(calls[0].url, /\/kvstore\/cc-simplified-alerting\/managed\/monitor\/ally-default-in_syslog$/);
  });
});

describe('template defaults', () => {
  it('round-trip through the same serialization as everything else', async () => {
    // Stored per direction, because the two directions land on different conditions with
    // different `conf` fields — so a shared `conf` would carry a field the other condition
    // does not declare.
    const defaults = {
      sourceConditionId: 'low-volume',
      sourceConf: { dataVolume: 1024, timeWindow: '60s' },
      destinationConditionId: 'unhealthy-dest',
      destinationConf: { timeWindow: '60s', notifyOnResolution: true },
      notificationTargets: ['system_notifications'],
    };
    const calls = installFetch(ok('{}'));
    await saveTemplateDefaults(defaults);
    const written = JSON.parse(calls[0].body ?? '') as string;

    installFetch(ok(JSON.stringify(written)));
    assert.deepEqual(await loadTemplateDefaults(), defaults);
  });
});
