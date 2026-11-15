import { GiteaClient } from './gitea';
import type { FetchLike } from './hubClient';

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: any;
}

function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      auth: init?.headers?.Authorization,
      ...(init?.body ? { body: JSON.parse(init.body) } : {}),
    });
    const route = routes[`${method} ${url}`];
    const status = route ? route.status ?? 200 : 404;
    const text = JSON.stringify(route?.body ?? { message: 'not found' });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const base = 'http://gitea:3300';
const auth = { username: 'calm', password: 'pw' };

describe('GiteaClient', () => {
  it('createPullRequest posts head, base, title and body and returns number and html_url', async () => {
    const fetch = fakeFetch({
      [`POST ${base}/api/v1/repos/calm-services/orders/pulls`]: {
        status: 201,
        body: {
          number: 3,
          html_url: `${base}/calm-services/orders/pulls/3`,
        },
      },
    });
    const client = new GiteaClient(`${base}/`, auth, fetch);
    expect(
      await client.createPullRequest('calm-services', 'orders', {
        head: 'upgrade/deploy-1.1.0',
        base: 'main',
        title: 'Upgrade',
        body: 'k8s-deploy 1.0.0 → 1.1.0',
      }),
    ).toEqual({ number: 3, url: `${base}/calm-services/orders/pulls/3` });
    expect(fetch.calls[0]).toEqual({
      method: 'POST',
      url: `${base}/api/v1/repos/calm-services/orders/pulls`,
      auth: `Basic ${btoa('calm:pw')}`,
      body: {
        head: 'upgrade/deploy-1.1.0',
        base: 'main',
        title: 'Upgrade',
        body: 'k8s-deploy 1.0.0 → 1.1.0',
      },
    });
  });

  it('mergePullRequest posts Do: merge and deletes the branch', async () => {
    const url = `${base}/api/v1/repos/calm-services/orders/pulls/3/merge`;
    const fetch = fakeFetch({ [`POST ${url}`]: { status: 200 } });
    await new GiteaClient(base, auth, fetch).mergePullRequest(
      'calm-services',
      'orders',
      3,
      'Upgrade',
    );
    expect(fetch.calls[0].body).toEqual({
      Do: 'merge',
      MergeTitleField: 'Upgrade',
      delete_branch_after_merge: true,
    });
  });

  it('throws with Gitea’s message when a call fails', async () => {
    const fetch = fakeFetch({
      [`POST ${base}/api/v1/repos/o/r/pulls/1/merge`]: {
        status: 405,
        body: { message: 'not mergeable' },
      },
    });
    await expect(
      new GiteaClient(base, auth, fetch).mergePullRequest('o', 'r', 1, 't'),
    ).rejects.toThrow(/405.*not mergeable/);
  });

  it('repoExists maps 404 to false and 200 to true', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/api/v1/repos/calm-services/a`]: { body: {} },
    });
    const client = new GiteaClient(base, auth, fetch);
    expect(await client.repoExists('calm-services', 'a')).toBe(true);
    expect(await client.repoExists('calm-services', 'b')).toBe(false);
  });

  it('builds web URLs for a repository, a commit and a folder at a commit', () => {
    const client = new GiteaClient(base, auth);
    expect(client.repoWebUrl('calm-services', 'orders')).toBe(
      `${base}/calm-services/orders`,
    );
    expect(client.cloneUrl('calm-services', 'orders')).toBe(
      `${base}/calm-services/orders.git`,
    );
    expect(client.commitWebUrl('calm-services', 'orders', 'abc')).toBe(
      `${base}/calm-services/orders/commit/abc`,
    );
    expect(
      client.treeWebUrl('calm-templates', 'bundles', 'abc', 'k8s-deploy/1.0.0'),
    ).toBe(`${base}/calm-templates/bundles/src/commit/abc/k8s-deploy/1.0.0`);
  });
});
