import { GiteaClient, type FetchLike } from '@internal/backstage-plugin-calm-common';

const enc = encodeURIComponent;
const REPO_PAGE = 50;

export interface PullRequestState {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommit?: string;
}

/**
 * calm-common's GiteaClient plus the reads this extension needs: a file at a ref (the read side never touches a
 * working copy, so a tab opened during a deployment cannot disturb it), a folder listing, and a pull request's state
 * (to wait for a human to merge it).
 */
export class Gitea extends GiteaClient {
  constructor(
    baseUrl: string,
    private readonly credentials: { username: string; password: string },
    private readonly fetcher?: FetchLike,
  ) {
    super(baseUrl, credentials, fetcher);
  }

  private async get(path: string): Promise<{ status: number; text: string }> {
    const f = this.fetcher ?? ((globalThis as any).fetch as FetchLike);
    const res = await f(`${this.baseUrl}/api/v1${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`,
      },
    });
    return { status: res.status, text: await res.text() };
  }

  /** The text of `file` at `ref`, or undefined when the repository or file does not exist. */
  async rawFile(owner: string, repo: string, ref: string, file: string): Promise<string | undefined> {
    const filePath = file.split('/').map(enc).join('/');
    const r = await this.get(`/repos/${enc(owner)}/${enc(repo)}/raw/${filePath}?ref=${enc(ref)}`);
    if (r.status === 404) return undefined;
    if (r.status >= 300) throw new Error(`Gitea GET raw ${owner}/${repo}/${file}@${ref} returned ${r.status}`);
    return r.text;
  }

  /** Names of the files in `folder` at `ref` (empty when it does not exist). */
  async listFiles(owner: string, repo: string, ref: string, folder: string): Promise<string[]> {
    const folderPath = folder.split('/').map(enc).join('/');
    const r = await this.get(`/repos/${enc(owner)}/${enc(repo)}/contents/${folderPath}?ref=${enc(ref)}`);
    if (r.status === 404) return [];
    if (r.status >= 300) throw new Error(`Gitea GET contents ${owner}/${repo}/${folder}@${ref} returned ${r.status}`);
    const list = JSON.parse(r.text);
    return Array.isArray(list) ? list.filter((e: any) => e?.type === 'file').map((e: any) => String(e.name)) : [];
  }

  /** The commit `branch` points at; undefined when the repository or branch does not exist. */
  async branchHead(owner: string, repo: string, branch: string): Promise<string | undefined> {
    const r = await this.get(`/repos/${enc(owner)}/${enc(repo)}/branches/${enc(branch)}`);
    if (r.status === 404) return undefined;
    if (r.status >= 300) throw new Error(`Gitea GET branch ${owner}/${repo}@${branch} returned ${r.status}`);
    const id = JSON.parse(r.text)?.commit?.id;
    return typeof id === 'string' && id ? id : undefined;
  }

  /** Names of the repositories of `org` (empty when it does not exist). */
  async listRepos(org: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.get(`/orgs/${enc(org)}/repos?limit=${REPO_PAGE}&page=${page}`);
      if (r.status === 404) return [];
      if (r.status >= 300) throw new Error(`Gitea GET repos of ${org} returned ${r.status}`);
      const list = JSON.parse(r.text);
      if (!Array.isArray(list)) break;
      names.push(...list.filter((e: any) => typeof e?.name === 'string' && !e.empty).map((e: any) => String(e.name)));
      if (list.length < REPO_PAGE) break;
    }
    return names;
  }

  async pullRequest(owner: string, repo: string, number: number): Promise<PullRequestState> {
    const r = await this.get(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`);
    if (r.status >= 300) throw new Error(`Gitea GET pull ${owner}/${repo}#${number} returned ${r.status}`);
    const pr = JSON.parse(r.text);
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.state === 'closed' ? 'closed' : 'open',
      merged: Boolean(pr.merged),
      ...(pr.merge_commit_sha ? { mergeCommit: String(pr.merge_commit_sha) } : {}),
    };
  }
}
