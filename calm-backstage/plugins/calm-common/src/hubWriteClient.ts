/*
 * The CALM Hub calls that write: a new architecture version and a new decorator. Kept apart from the read-only
 * client, which the catalog provider and calm-backend use. No auth here: the hackathon Hub runs the `no-auth` profile.
 */
import { CalmHubClient, CalmHubError, FetchLike } from './hubClient';
import { architectureVersionPath } from './hubRecord';

export class CalmHubWriteClient extends CalmHubClient {
  /** POST a JSON body to a path under the base URL; gives the response text. Throws a CalmHubError unless 2xx. */
  private async post(path: string, body: unknown): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const doFetch: FetchLike =
      this.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    let text = '';
    try {
      text = await res.text();
    } catch {
      // no body
    }
    if (!res.ok) {
      throw new CalmHubError(
        res.status,
        url,
        `POST ${url} -> ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      );
    }
    return text;
  }

  /**
   * Stores an architecture as `<name>` version `<version>` through the name-based API, which keeps the document's
   * `$id`. Versions are immutable: the Hub answers 409 when the version exists. Gives the version's URL.
   */
  async createArchitectureVersion(
    namespace: string,
    name: string,
    version: string,
    doc: unknown,
  ): Promise<string> {
    const path = architectureVersionPath(namespace, name, version);
    await this.post(path, doc);
    return `${this.baseUrl}${path}`;
  }

  /** Stores a decorator (posted in kebab case: `unique-id`, `target-type`, `applies-to`); gives the Hub's id. */
  async createDecorator(
    namespace: string,
    decorator: unknown,
  ): Promise<number> {
    const path = `/api/calm/namespaces/${encodeURIComponent(
      namespace,
    )}/decorators`;
    const text = await this.post(path, decorator);
    let id: unknown;
    try {
      id = JSON.parse(text)?.id;
    } catch {
      // reported below
    }
    if (typeof id !== 'number') {
      throw new CalmHubError(
        502,
        `${this.baseUrl}${path}`,
        `POST ${this.baseUrl}${path} gave no decorator id: ${text.slice(
          0,
          200,
        )}`,
      );
    }
    return id;
  }
}
