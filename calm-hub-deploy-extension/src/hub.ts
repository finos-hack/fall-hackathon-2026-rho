import { CalmHubError, CalmHubWriteClient, type FetchLike } from '@internal/backstage-plugin-calm-common';

/** The calm-common write client plus the one call it lacks: replacing a decorator (PUT), to move it through statuses. */
export class HubClient extends CalmHubWriteClient {
  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    super(baseUrl, fetchImpl);
  }

  /** Replaces decorator `id` with `decorator` (the whole document: CALM Hub keeps the old one in its history). */
  async updateDecorator(namespace: string, id: number, decorator: unknown): Promise<void> {
    const url = `${(this as any).baseUrl}/api/calm/namespaces/${encodeURIComponent(namespace)}/decorators/${id}`;
    const doFetch: FetchLike = (this as any).fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    const res = await doFetch(url, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(decorator),
    });
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        // no body
      }
      throw new CalmHubError(res.status, url, `PUT ${url} -> ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
  }
}
