/**
 * Cribl API client.
 *
 * The platform intercepts every `fetch()` to `window.CRIBL_API_URL` and proxies it
 * through the parent window, injecting auth. This module therefore never handles
 * tokens; it only concerns itself with timeouts, pagination, and turning failures
 * into something the UI can explain (see AGENTS.md → "How API Calls Work").
 */

/** Platform proxy gives up at 30s. Bail a little earlier so we own the message. */
const DEFAULT_TIMEOUT_MS = 25_000;

/** Page size for list endpoints that support offset/limit. */
export const PAGE_LIMIT = 200;

/** Hard ceiling on pages per list endpoint, so a bad `count` can't loop forever. */
const MAX_PAGES = 50;

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail?: string;

  constructor(message: string, status: number, path: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.detail = detail;
  }

  /** The user is not allowed to do this. Callers degrade rather than fail. */
  get isDenied(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Client-side abort or timeout — no status came back from the platform. */
  get isTimeout(): boolean {
    return this.status === 0;
  }
}

function apiBase(): string {
  const base = window.CRIBL_API_URL;
  if (!base) {
    throw new ApiError(
      'window.CRIBL_API_URL is not set. The app must run inside Cribl (or `npm run dev` with the platform init script).',
      0,
      '',
    );
  }
  return base.replace(/\/$/, '');
}

export type Query = Record<string, string | number | boolean | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

export interface RequestOptions {
  query?: Query;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const url = apiBase() + withQuery(path, opts.query);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (opts.signal?.aborted) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Log with context, then surface a message the UI can show verbatim.
    console.error(`[cc-simplified-alerting] ${method} ${path} did not complete: ${reason}`);
    throw new ApiError(`${method} ${path} did not complete (${reason}).`, 0, path, reason);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    console.error(`[cc-simplified-alerting] ${method} ${path} -> ${response.status} ${detail ?? ''}`);
    throw new ApiError(
      `${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      path,
      detail,
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some endpoints (KV store values) return plain text.
    return text as unknown as T;
  }
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'message' in parsed) {
        const message = (parsed as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
    } catch {
      /* fall through to raw text */
    }
    return text.slice(0, 300);
  } catch {
    return undefined;
  }
}

export function apiGet<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, opts);
}

export function apiPost<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('POST', path, body ?? {}, opts);
}

export function apiPut<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('PUT', path, body ?? {}, opts);
}

/**
 * Update an existing object.
 *
 * Used for one thing: an Insights monitor whose id already exists. Cribl's own Insights UI
 * PATCHes monitors rather than PUTting them (captured live), and PATCH is also the only
 * verb proven to work on `/m/{gid}/alert/monitors/{id}`.
 */
export function apiPatch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('PATCH', path, body ?? {}, opts);
}

export function apiDelete<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('DELETE', path, undefined, opts);
}

/** Envelope every Cribl list endpoint returns. */
export interface Paginated<T> {
  items: T[];
  count?: number;
  offset?: number;
  limit?: number;
  totalCount?: number;
}

/**
 * Validate a list envelope before consuming it. An endpoint that starts returning
 * a different shape must fail loudly rather than silently read as "no items",
 * because an empty list here renders covered feeds as uncovered.
 */
export function assertPaginated<T>(body: unknown, path: string): Paginated<T> {
  if (!body || typeof body !== 'object' || !Array.isArray((body as Paginated<T>).items)) {
    throw new ApiError(`${path} did not return an { items: [] } envelope.`, 0, path);
  }
  return body as Paginated<T>;
}

/**
 * Read a list endpoint to exhaustion.
 *
 * Reading only the first page is a correctness bug for this app: an existing alert
 * that lives on page two makes a covered feed render as uncovered.
 */
export async function fetchAllPages<T>(path: string, opts: RequestOptions = {}): Promise<T[]> {
  const items: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT;
    const body = await apiGet<unknown>(path, {
      ...opts,
      query: { ...opts.query, offset, limit: PAGE_LIMIT },
    });
    const envelope = assertPaginated<T>(body, path);
    items.push(...envelope.items);

    if (envelope.items.length < PAGE_LIMIT) return items;
    if (typeof envelope.totalCount === 'number' && items.length >= envelope.totalCount) return items;
  }
  console.warn(
    `[cc-simplified-alerting] ${path} still had pages after ${MAX_PAGES * PAGE_LIMIT} items; truncating.`,
  );
  return items;
}

/**
 * Read a list endpoint to exhaustion, deduplicating by a stable key.
 *
 * Not every Cribl list endpoint honours `offset`/`limit`; some return the whole
 * collection on every request. Under the plain page loop above, a collection larger
 * than one page then looks like an endless supply of items and each page re-adds the
 * same objects. Here a page that contributes nothing new ends the loop, so a repeated
 * page is harmless and a duplicate can never inflate a coverage count.
 */
export async function fetchAllUnique<T>(
  path: string,
  keyOf: (item: T) => string | null,
  opts: RequestOptions = {},
): Promise<T[]> {
  const seen = new Set<string>();
  const items: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT;
    const body = await apiGet<unknown>(path, {
      ...opts,
      query: { ...opts.query, offset, limit: PAGE_LIMIT },
    });
    const envelope = assertPaginated<T>(body, path);
    let added = 0;
    for (const item of envelope.items) {
      const key = keyOf(item);
      if (key === null) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      added++;
    }
    if (added === 0) return items;
    if (envelope.items.length < PAGE_LIMIT) return items;
    if (typeof envelope.totalCount === 'number' && items.length >= envelope.totalCount) return items;
  }
  console.warn(
    `[cc-simplified-alerting] ${path} still had pages after ${MAX_PAGES * PAGE_LIMIT} items; truncating.`,
  );
  return items;
}

/** Run tasks with bounded concurrency so we never fan out unbounded requests. */
export async function mapLimit<In, Out>(
  inputs: readonly In[],
  limit: number,
  task: (input: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(inputs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= inputs.length) return;
      results[index] = await task(inputs[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Describe a failure in one sentence, without leaking a stack trace to the UI. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isDenied) return `Not permitted (${error.status}).`;
    if (error.isTimeout) return error.detail ?? 'The request did not complete.';
    // A 404 names the path itself. Several paths `openapi.json` documents are simply not
    // served on a given deployment (`/alert/monitors`, `/system-insights/metrics`), and an
    // admin can only act on that if the reason says which one is missing. Express happens
    // to echo the path in its own body, but that is its choice, not a contract.
    if (error.isNotFound) {
      return `${error.path} is not available on this deployment (404).`;
    }
    return error.detail ? `${error.status}: ${error.detail}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
