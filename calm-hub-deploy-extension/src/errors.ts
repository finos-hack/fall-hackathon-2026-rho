import type { FetchLike } from '@internal/backstage-plugin-calm-common';

/** An error with the HTTP status the backend answers with. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Each read of CALM Hub or Gitea gives up after this, so a slow one cannot use up CALM Hub's 10 s for a proxied call.
 * It is per call: a route that reads in sequence can still take longer.
 */
export const READ_TIMEOUT_MS = 4_000;

/** CALM Hub or Gitea did not answer a read in time. The read side shows it as a problem, never as a 5xx. */
export class ReadTimeout extends Error {
  constructor(readonly service: string, url: string, ms: number) {
    super(`${service} did not answer GET ${url.split('?')[0]} within ${ms / 1000} s`);
    this.name = 'ReadTimeout';
  }
}

type Reply = Awaited<ReturnType<FetchLike>>;

/**
 * `fetchImpl` with a timeout (`AbortSignal.timeout`) on every GET, covering the body as well as the headers. Other
 * methods pass through unchanged. A GET that times out rejects with `ReadTimeout`.
 */
export function timedGets(service: string, fetchImpl: FetchLike | undefined, ms: number): FetchLike {
  const base: FetchLike = fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));
  return async (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') return base(url, init);
    const signal = AbortSignal.timeout(ms);
    // Also races the signal, for a fetch that ignores it.
    const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    aborted.catch(() => undefined);
    try {
      const reply = await Promise.race([
        (async (): Promise<Reply> => {
          const res = await base(url, { ...init, signal });
          const text = await res.text();
          return { ok: res.ok, status: res.status, text: async () => text, json: async () => JSON.parse(text) };
        })(),
        aborted,
      ]);
      return reply;
    } catch (e) {
      if (signal.aborted) throw new ReadTimeout(service, url, ms);
      throw e;
    }
  };
}
