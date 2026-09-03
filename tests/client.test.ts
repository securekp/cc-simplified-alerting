/**
 * The API client's pagination and error-shaping rules.
 *
 * These matter for correctness, not just tidiness: reading only the first page of
 * `/notifications` makes a covered feed render as uncovered, and double-counting a
 * repeated page inflates the coverage numbers the admin is deciding from.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ApiError,
  assertPaginated,
  describeError,
  fetchAllPages,
  fetchAllUnique,
  mapLimit,
  PAGE_LIMIT,
} from '../src/api/client.ts';

/** Stand in for the platform globals the client reads. */
function installFetch(handler: (url: string) => unknown) {
  const calls: string[] = [];
  globalThis.window = { CRIBL_API_URL: 'https://cribl.test/api/v1' } as unknown as Window &
    typeof globalThis;
  globalThis.fetch = ((url: string) => {
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(handler(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return calls;
}

/** Run `body` against a stubbed fetch and return the URLs it requested. */
async function withFetch(
  handler: (url: string) => unknown,
  body: () => Promise<unknown>,
): Promise<string[]> {
  const calls = installFetch(handler);
  await body();
  return calls;
}

describe('assertPaginated', () => {
  it('fails loudly instead of reading a changed shape as "no items"', () => {
    // An empty list here renders covered feeds as uncovered, so a wrong shape must throw.
    assert.throws(() => assertPaginated({ data: [] }, '/notifications'), ApiError);
    assert.throws(() => assertPaginated(null, '/notifications'), ApiError);
    assert.deepEqual(assertPaginated<number>({ items: [1] }, '/x').items, [1]);
  });

  it('rejects the platform error envelope rather than treating it as an empty list', () => {
    // Observed live, verbatim, from /conditions, /notifications and /notification-targets
    // when `limit` was sent without `offset`. It is a JSON object with no `items` key, so
    // reading it as "nothing configured" would report every covered feed as uncovered.
    const envelope = {
      status: 'error',
      message: "missing 'offset' parameter, 'offset' is required when 'limit' is provided",
    };
    assert.throws(() => assertPaginated(envelope, '/conditions'), ApiError);
  });
});

describe('fetchAllUnique', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('stops when a page contributes nothing new, so a repeated page cannot inflate counts', async () => {
    // Some Cribl list endpoints ignore offset/limit and return the whole collection every
    // time. Under a plain page loop that looks like an endless supply of items.
    const page = { items: Array.from({ length: PAGE_LIMIT }, (_, index) => `name-${index}`) };
    const calls = installFetch(() => page);
    const names = await fetchAllUnique<string>('/system-insights/metrics', (name) => name);
    assert.equal(names.length, PAGE_LIMIT);
    assert.equal(new Set(names).size, PAGE_LIMIT);
    assert.equal(calls.length, 2, 'the second, wholly duplicate page ends the loop');
  });

  it('follows pages while they keep contributing, and asks for offset and limit', async () => {
    const calls = installFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return offset === 0
        ? { items: Array.from({ length: PAGE_LIMIT }, (_, index) => `a-${index}`) }
        : { items: ['tail'] };
    });
    const names = await fetchAllUnique<string>('/notifications', (name) => name);
    assert.equal(names.length, PAGE_LIMIT + 1);
    assert.equal(names.at(-1), 'tail');
    assert.match(calls[0], /offset=0&limit=200/);
  });

  it('never sends limit without offset, on either paginator', async () => {
    // Proven live: Cribl rejects `?limit=200` alone with
    // "missing 'offset' parameter, 'offset' is required when 'limit' is provided".
    // The two params are all-or-nothing, so every page request must carry both.
    const assertPaired = (calls: readonly string[]) => {
      assert.ok(calls.length > 0);
      for (const call of calls) {
        const params = new URL(call).searchParams;
        if (params.has('limit')) {
          assert.ok(params.has('offset'), `limit without offset in ${call}`);
        }
      }
    };

    assertPaired(await withFetch(() => ({ items: ['one'] }), () => fetchAllUnique<string>('/notifications', (name) => name)));
    assertPaired(await withFetch(() => ({ items: ['one'] }), () => fetchAllPages<string>('/conditions')));
  });

  it('skips items with no usable key rather than counting them', async () => {
    installFetch(() => ({ items: ['ok', '', null, 'ok'] }));
    const names = await fetchAllUnique<string>('/system-insights/metrics', (name) =>
      typeof name === 'string' && name ? name : null,
    );
    assert.deepEqual(names, ['ok']);
  });
});

describe('mapLimit', () => {
  it('preserves input order in the results', async () => {
    const results = await mapLimit([3, 1, 2], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 10;
    });
    assert.deepEqual(results, [30, 10, 20]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, index) => index), 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return null;
    });
    assert.equal(peak, 3);
  });

  it('handles an empty input without spawning workers', async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });
});

describe('describeError', () => {
  it('reports a denial as a permission problem so callers can degrade', () => {
    assert.equal(describeError(new ApiError('nope', 403, '/notifications')), 'Not permitted (403).');
    assert.equal(new ApiError('nope', 401, '/x').isDenied, true);
  });

  it('does not leak a stack trace', () => {
    const described = describeError(new ApiError('boom', 500, '/x', 'upstream exploded'));
    assert.equal(described, '500: upstream exploded');
    assert.doesNotMatch(described, /at .*client\.ts/);
  });

  it('describes a timeout in its own words', () => {
    const error = new ApiError('timed out', 0, '/x', 'GET /x did not complete (timeout).');
    assert.equal(error.isTimeout, true);
    assert.equal(describeError(error), 'GET /x did not complete (timeout).');
  });

  it('names the missing path on a 404, rather than relying on the upstream body', () => {
    // Several paths openapi.json documents are simply not served on a given deployment.
    // The admin can only act on that if the reason says *which* path is missing, and
    // Express echoing it in "Cannot GET ..." is its choice, not a contract — so the
    // client must not depend on the detail text being there.
    const described = describeError(new ApiError('boom', 404, '/alert/monitors'));
    assert.match(described, /\/alert\/monitors/);
    assert.match(described, /not available on this deployment/);
    // Still names the path even when the upstream sent no body at all.
    assert.match(
      describeError(new ApiError('boom', 404, '/system-insights/metrics', undefined)),
      /\/system-insights\/metrics/,
    );
  });

  it('handles non-Error throws', () => {
    assert.equal(describeError('plain string'), 'plain string');
    assert.equal(describeError(new Error('regular')), 'regular');
  });
});

describe('the client without platform globals', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {};
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('says what is missing instead of requesting a malformed URL', async () => {
    await assert.rejects(fetchAllUnique<string>('/x', (name) => name), /CRIBL_API_URL is not set/);
  });
});
