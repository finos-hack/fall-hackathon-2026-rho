import { CalmHubError, CalmHubWriteClient, type FetchLike } from '@internal/backstage-plugin-calm-common';
import { READ_TIMEOUT_MS, timedGets } from './errors';

/**
 * CALM Hub refused a decorator (400), typically `Decorator does not match its $schema`. The message carries CALM
 * Hub's error and the first few `location: error` lines it gave. Sending the same record again will not help.
 */
export class DecoratorRejected extends CalmHubError {
  constructor(url: string, message: string) {
    super(400, url, message);
    this.name = 'DecoratorRejected';
  }
}

/** The message for a 400 body such as `{"error": "...", "errors": [{"location": "/data/kubernetes", "error": "..."}]}`. */
export function rejectionMessage(body: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `CALM Hub refused the decorator: ${body.slice(0, 300) || 'no reason given'}`;
  }
  const errors: any[] = Array.isArray(parsed?.errors) ? parsed.errors : [];
  const lines = errors.slice(0, 3).map(e => `${e?.location ?? '?'}: ${e?.error ?? '?'}`);
  if (errors.length > 3) lines.push(`and ${errors.length - 3} more`);
  const reason = typeof parsed?.error === 'string' ? parsed.error : 'no reason given';
  return `CALM Hub refused the decorator: ${reason}${lines.length ? `: ${lines.join('; ')}` : ''}`;
}

/**
 * The calm-common write client plus replacing a decorator (PUT), to move it through statuses. Decorator writes go
 * through `send` rather than calm-common so a refusal keeps CALM Hub's whole reason (`DecoratorRejected`). Every GET
 * gives up after `readTimeoutMs` (4 s) with `ReadTimeout`; writes have no timeout.
 */
export class HubClient extends CalmHubWriteClient {
  constructor(baseUrl: string, fetchImpl?: FetchLike, opts: { readTimeoutMs?: number } = {}) {
    super(baseUrl, timedGets('CALM Hub', fetchImpl, opts.readTimeoutMs ?? READ_TIMEOUT_MS));
  }

  private async send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const doFetch: FetchLike = this.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    const res = await doFetch(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let text = '';
    try {
      text = await res.text();
    } catch {
      // no body
    }
    if (res.status === 400) throw new DecoratorRejected(url, rejectionMessage(text));
    if (!res.ok) {
      throw new CalmHubError(res.status, url, `${method} ${url} -> ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return text;
  }

  /** Stores a decorator (posted in kebab case: `unique-id`, `target-type`, `applies-to`); gives the Hub's id. */
  override async createDecorator(namespace: string, decorator: unknown): Promise<number> {
    const path = `/api/calm/namespaces/${encodeURIComponent(namespace)}/decorators`;
    const text = await this.send('POST', path, decorator);
    let id: unknown;
    try {
      id = JSON.parse(text)?.id;
    } catch {
      // reported below
    }
    if (typeof id !== 'number') throw new CalmHubError(502, path, `POST ${path} gave no decorator id: ${text.slice(0, 200)}`);
    return id;
  }

  /** Replaces decorator `id` with `decorator` (the whole document: CALM Hub keeps the old one in its history). */
  async updateDecorator(namespace: string, id: number, decorator: unknown): Promise<void> {
    await this.send('PUT', `/api/calm/namespaces/${encodeURIComponent(namespace)}/decorators/${id}`, decorator);
  }
}
