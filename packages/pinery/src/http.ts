/**
 * Shared HTTP helper for network providers: a JSON GET with bounded retry +
 * exponential backoff on transient statuses (429/5xx). Browser-safe (uses the
 * global `fetch`); an alternate `fetchImpl` may be injected for tests.
 */
export interface FetchJsonOptions {
  /** Human label used in error messages (e.g. "Binance /klines"). */
  label?: string;
  headers?: Record<string, string>;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Max retry attempts on transient failures. Default 4. */
  retries?: number;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const label = opts.label ?? url;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.retries ?? 4;
  let backoff = 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { Accept: 'application/json', ...opts.headers } });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      throw new Error(`${label}: network error — ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.ok) return (await res.json()) as T;

    if (TRANSIENT.has(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new Error(`${label}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }

  throw new Error(`${label}: request failed`);
}

/** Read an env var in Node/Bun; returns undefined in the browser. Used for optional credential fallback. */
export function envVar(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
