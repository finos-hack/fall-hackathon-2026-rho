/*
 * The few Gitea REST calls the CALM plugins make (the local Git server that stands in for GitHub): look up a
 * repository, open and merge a pull request, and build the web URLs Backstage links to. Repositories are created by
 * pushing to them (push-to-create), so there is no create call.
 */
import type { FetchLike } from './hubClient';

export interface GiteaAuth {
  username: string;
  password: string;
}

const enc = encodeURIComponent;

export class GiteaClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly auth: GiteaAuth,
    private readonly fetchImpl?: FetchLike,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const f = this.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await f(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(
          `${this.auth.username}:${this.auth.password}`,
        )}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json: json ?? text };
  }

  private static fail(what: string, r: { status: number; json: any }): never {
    const msg =
      typeof r.json === 'object' && r.json?.message
        ? r.json.message
        : String(r.json ?? '');
    throw new Error(`Gitea ${what} returned ${r.status}: ${msg}`);
  }

  async repoExists(owner: string, repo: string): Promise<boolean> {
    const r = await this.call('GET', `/repos/${enc(owner)}/${enc(repo)}`);
    if (r.status === 404) {
      return false;
    }
    if (r.status >= 300) {
      GiteaClient.fail(`GET /repos/${owner}/${repo}`, r);
    }
    return true;
  }

  async createPullRequest(
    owner: string,
    repo: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const path = `/repos/${enc(owner)}/${enc(repo)}/pulls`;
    const r = await this.call('POST', path, pr);
    if (r.status >= 300) {
      GiteaClient.fail(`POST ${path}`, r);
    }
    return { number: r.json.number, url: r.json.html_url };
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    title: string,
  ): Promise<void> {
    const path = `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/merge`;
    const r = await this.call('POST', path, {
      Do: 'merge',
      MergeTitleField: title,
      delete_branch_after_merge: true,
    });
    if (r.status >= 300) {
      GiteaClient.fail(`POST ${path}`, r);
    }
  }

  repoWebUrl(owner: string, repo: string): string {
    return `${this.baseUrl}/${owner}/${repo}`;
  }

  cloneUrl(owner: string, repo: string): string {
    return `${this.repoWebUrl(owner, repo)}.git`;
  }

  commitWebUrl(owner: string, repo: string, sha: string): string {
    return `${this.repoWebUrl(owner, repo)}/commit/${sha}`;
  }

  treeWebUrl(owner: string, repo: string, sha: string, path: string): string {
    return `${this.repoWebUrl(owner, repo)}/src/commit/${sha}/${path.replace(
      /^\/+/,
      '',
    )}`;
  }
}
