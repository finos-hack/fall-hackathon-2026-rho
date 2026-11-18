import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import type { FetchLike } from '@internal/backstage-plugin-calm-common';
import { handle } from './app';
import { Gitea } from './gitea';
import { HubClient } from './hub';
import { architectureDoc, fakeValidate, world, type World } from './test/fakes';

const worlds: World[] = [];
function make(opts?: Parameters<typeof world>[0]) {
  const w = world(opts);
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds.splice(0)) fs.rmSync(w.root, { recursive: true, force: true });
});

const call = (w: World, method: string, url: string, body?: unknown) =>
  handle(w.deps, { method, url, identity: 'token', body: Buffer.from(body ? JSON.stringify(body) : '') });

const tab = (w: World, name: string, version: string) =>
  call(w, 'GET', `/tab/hackathon/architectures/${name}?namespace=hackathon&resourceId=${name}&resourceType=architectures&version=${version}`);

describe('designer tab', () => {
  it('warns when the version on screen is not the one deployed', async () => {
    const w = make();
    const r: any = await tab(w, 'events-stream', '1.0.1');
    expect(r.status).toBe(200);
    expect(r.body.blocks[0]).toMatchObject({ type: 'alert', tone: 'warning' });
    expect(r.body.blocks[0].text).toContain('local runs 1.0.0; this page shows 1.0.1');
    const kv = r.body.blocks.find((b: any) => b.type === 'keyValue').items;
    expect(kv).toContainEqual({ label: 'Running version', value: '1.0.0' });
    expect(kv).toContainEqual({ label: 'This version', value: '1.0.1' });
    expect(kv).toContainEqual({ label: 'Flux', value: 'Ready' });
    expect(kv).toContainEqual({ label: "CALM Hub's record", value: 'none' });
  });

  it('says so when the version on screen is deployed, and accepts a numeric id', async () => {
    const w = make();
    const r: any = await call(w, 'GET', '/tab/hackathon/architectures/38?version=1.0.0');
    expect(r.body.blocks[0]).toMatchObject({ tone: 'positive' });
  });

  it('explains an architecture with no GitOps repository instead of failing', async () => {
    const w = make();
    const r: any = await tab(w, 'no-repo', '1.0.0');
    expect(r.status).toBe(200);
    expect(r.body.blocks[0].text).toContain('Not deployed through GitOps');
  });

  it('shows an unknown architecture as an alert in the tab', async () => {
    const w = make();
    const r: any = await tab(w, 'nope', '1.0.0');
    expect(r.body.blocks[0]).toMatchObject({ tone: 'negative' });
  });

  it('refuses a request whose assertion does not verify', async () => {
    const w = make();
    w.deps.verify = async () => {
      const { AssertionError } = await import('./identity');
      throw new AssertionError('bad signature');
    };
    expect((await tab(w, 'events-stream', '1.0.0')).status).toBe(401);
  });

  it('logs each request CALM Hub vouched for, and not a refused one', async () => {
    const { createLogger } = await import('./logger');
    const lines: string[] = [];
    const w = make();
    w.deps.logger = createLogger('test', 'info', l => lines.push(l));
    await tab(w, 'events-stream', '1.0.0');
    expect(lines.filter(l => l.includes('← CALM Hub'))).toEqual([
      expect.stringContaining('GET /tab/hackathon/architectures/events-stream ← CALM Hub route=tab scope=- ns=hackathon sub=alice jti=aaaa1111-2222'),
    ]);
    lines.length = 0;
    w.deps.verify = async () => {
      const { AssertionError } = await import('./identity');
      throw new AssertionError('bad signature');
    };
    await tab(w, 'events-stream', '1.0.0');
    expect(lines.some(l => l.includes('← CALM Hub'))).toBe(false);
  });

  it('refuses a request whose checked namespace is not the one in the path', async () => {
    const w = make();
    const verify = w.deps.verify;
    w.deps.verify = async (t, req) => ({ ...(await verify(t, req)), ns: 'other' });
    expect((await tab(w, 'events-stream', '1.0.0')).status).toBe(403);
  });
});

describe('status and history commands', () => {
  it('reports where the service runs', async () => {
    const w = make();
    const r: any = await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status');
    expect(r.body).toMatchObject({
      managed: true,
      deployedVersion: '1.0.0',
      latestVersion: '1.0.1',
      ready: true,
      commit: w.gitea.head('events-stream'),
      deploymentRules: 'k8s-deploy@1.2.1',
    });
  });

  it('reads the architecture’s versions once', async () => {
    const w = make();
    let versionReads = 0;
    w.deps.hub = new HubClient('http://hub.test', async (url, init) => {
      if (/\/architectures\/events-stream\/versions$/.test(new URL(url).pathname)) versionReads++;
      return w.hub.fetch(url, init);
    });
    await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status');
    expect(versionReads).toBe(1);
  });

  it('keeps this connector’s attempts when more than 20 newer evaluations are other engines’', async () => {
    const w = make();
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    const own = Math.max(...w.hub.decorators.keys());
    for (let i = 0; i < 25; i++) {
      w.hub.decorators.set(1000 + i, {
        type: 'control-evaluation',
        target: ['/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1'],
        data: { status: 'met', 'evaluated-at': '2026-01-01T00:00:00Z', actors: { connector: 'someone-else' } },
      });
    }
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments.map((e: any) => e.id)).toEqual([own]);
  });

  it('reads the records of the newest 10 versions only, and of the running version', async () => {
    const w = make();
    const versions = w.hub.architectures.get('events-stream')!.versions;
    for (let i = 2; i <= 12; i++) versions.set(`1.0.${i}`, architectureDoc('events-stream', `1.0.${i}`, ['database']));
    const record = (id: number, version: string, startTime: string) =>
      w.hub.decorators.set(id, {
        type: 'deployment',
        target: [`/calm/namespaces/hackathon/architectures/events-stream/versions/${version}`],
        'target-type': ['architecture'],
        data: { 'start-time': startTime, status: 'completed' },
      });
    record(700, '1.0.0', '2026-11-01T10:00:00Z'); // running, older than the newest 10
    record(701, '1.0.1', '2026-11-02T10:00:00Z'); // neither
    record(702, '1.0.12', '2026-11-03T10:00:00Z');
    let listed = 0;
    w.deps.hub = new HubClient('http://hub.test', async (url, init) => {
      if (/\/decorators\?/.test(url)) listed++;
      return w.hub.fetch(url, init);
    });
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments.map((e: any) => e.id)).toEqual([702]);
    expect(listed).toBe(10 * 2);
    listed = 0;
    const s: any = (await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status')).body;
    expect(s.hubRecord).toMatchObject({ version: '1.0.12', status: 'completed' });
    // The running version's record is read too: 1.0.0 is not in the newest 10.
    expect(listed).toBe(11 * 2);
  });
});

describe('reads that time out', () => {
  /** `fetch`, except that requests matching `hang` never answer until their signal aborts. */
  const hanging =
    (fetch: FetchLike, hang: RegExp): FetchLike =>
    (url, init) =>
      hang.test(url)
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason)))
        : fetch(url, init);
  const slowHub = (w: World, hang = /./) => (w.deps.hub = new HubClient('http://hub.test', hanging(w.hub.fetch, hang), { readTimeoutMs: 20 }));
  const slowGitea = (w: World, hang = /./) =>
    (w.deps.gitea = new Gitea('http://gitea.test', w.settings.gitops.auth, hanging(w.gitea.fetch, hang), { readTimeoutMs: 20 }));
  const routes = [
    '/tab/hackathon/architectures/events-stream?namespace=hackathon&version=1.0.0',
    '/node/hackathon/architectures/events-stream/web-service?namespace=hackathon&selectedElement=web-service',
    '/namespaces/hackathon/architectures/events-stream/status',
    '/history/namespaces/hackathon/architectures/events-stream/deployments',
    '/card',
    '/screen',
  ];

  it('shows a CALM Hub that does not answer as a problem on every read route, never a 5xx', async () => {
    for (const url of routes) {
      const w = make();
      slowHub(w);
      const r: any = await call(w, 'GET', url);
      expect(r.status, url).toBe(200);
      if (url === '/card') {
        // The card has only counts (CALM Hub draws no more): a problem is neither in sync nor drifted, like a cluster
        // read that failed. The screen, read from the same rows, names it.
        expect(r.body.blocks[0].items.map((i: any) => i.value)).toEqual(['1', '0', '0']);
      } else {
        expect(JSON.stringify(r.body), url).toContain('CALM Hub did not answer GET http://hub.test/');
      }
    }
  });

  it('shows a Gitea that does not answer as a problem on every route that reads it, never a 5xx', async () => {
    for (const url of routes) {
      const w = make();
      slowGitea(w);
      const r: any = await call(w, 'GET', url);
      expect(r.status, url).toBe(200);
      // The history reads only CALM Hub.
      if (!url.startsWith('/history')) expect(JSON.stringify(r.body), url).toContain('Gitea did not answer GET http://gitea.test/');
    }
    const w = make();
    slowGitea(w);
    const tabBlocks = ((await call(w, 'GET', routes[0])).body as any).blocks;
    expect(tabBlocks[0]).toEqual({
      type: 'alert',
      tone: 'warning',
      text: expect.stringMatching(/^Cannot read the service repository: Gitea did not answer GET .* within 0.02 s$/),
    });
    const status: any = (await call(w, 'GET', routes[2])).body;
    expect(status.problems).toEqual([status.reason]);
  });

  it('keeps the rest of the status when only CALM Hub’s records time out, and is neither in sync nor drifted', async () => {
    const w = make();
    slowHub(w, /\/decorators/);
    const s: any = (await call(w, 'GET', routes[2])).body;
    expect(s).toMatchObject({ managed: true, deployedVersion: '1.0.0', latestVersion: '1.0.1', inSync: false, drift: [] });
    expect(s.problems).toEqual([expect.stringMatching(/^Cannot read CALM Hub's deployment records: CALM Hub did not answer GET/)]);
  });

  it('keeps a service whose repository times out on the card and the screen, as a problem', async () => {
    const w = make();
    slowGitea(w, /catalog-info/);
    const card: any = (await call(w, 'GET', '/card')).body;
    expect(card.blocks[0].items.map((i: any) => i.value)).toEqual(['1', '0', '0']);
    const screen: any = (await call(w, 'GET', '/screen')).body;
    expect(screen.blocks[1].rows).toEqual([
      ['events-stream', 'unknown', 'unknown', expect.stringMatching(/^Cannot read calm-services\/events-stream: Gitea did not answer GET/)],
    ]);
  });

  it('gives the service repository’s own problem as the reason when other reads time out too', async () => {
    const w = make();
    slowGitea(w, /catalog-info/);
    // The versions read times out first, so its problem comes first.
    w.deps.hub = new HubClient('http://hub.test', hanging(w.hub.fetch, /\/versions$/), { readTimeoutMs: 1 });
    const s: any = (await call(w, 'GET', routes[2])).body;
    expect(s.problems[0]).toMatch(/^Cannot read the versions in CALM Hub/);
    expect(s.reason).toMatch(/^Cannot read the service repository: Gitea did not answer GET/);
    expect(s.problems).toHaveLength(2);
    expect(s.problems).toContain(s.reason);
  });

  it('answers 503, not a problem, when CALM Hub’s keys cannot be read in time to verify the caller', async () => {
    const w = make();
    const { ReadTimeout } = await import('./errors');
    w.deps.verify = async () => {
      throw new ReadTimeout('CALM Hub', 'http://hub.test/api/calm/auth/jwks', 4000);
    };
    const r: any = await call(w, 'GET', routes[2]);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('cannot verify the request: CALM Hub did not answer GET http://hub.test/api/calm/auth/jwks within 4 s');
  });

  it('shows the overlay read timing out as a problem, not as image drift', async () => {
    const w = make();
    slowGitea(w, /k8s-overlay/);
    const s: any = (await call(w, 'GET', routes[2])).body;
    expect(s).toMatchObject({ managed: true, inSync: false, drift: [] });
    expect(s.problems).toEqual([expect.stringMatching(/^Cannot read the image Git asks for: Gitea did not answer GET/)]);
  });
});

describe('deploy', () => {
  it('deploys a version: pending → in-progress → completed, through a merged pull request and Flux', async () => {
    const w = make();
    w.gitea.merge405s = 1;
    const r: any = await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', { namespace: 'hackathon' });
    expect(r.status).toBe(202);
    expect(r.body).toStrictEqual({ hubApi: 0, status: 'pending', deploymentId: 'events-stream-1.0.1-aaaa1111' });
    await w.deps.jobs.idle();

    const d = w.hub.latest();
    expect(d.target).toEqual([
      '/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1',
      '/api/calm/namespaces/hackathon/architectures/38/versions/1-0-1',
    ]);
    expect(d['applies-to']).toEqual(['web-service']);
    expect(d.$schema).toBe('https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json');
    expect(d.data).toMatchObject({
      status: 'completed',
      kubernetes: { cluster: 'calm-backstage', namespace: 'calm-events-stream' },
      gitops: {
        connector: 'platform-connector',
        environment: 'local',
        repository: 'http://gitea.test/calm-services/events-stream',
        'architecture-version': '1.0.1',
        'requested-by': 'alice',
        'hub-audit-id': 'aaaa1111-2222',
        'pull-request': 'http://gitea.test/calm-services/events-stream/pulls/1',
        commit: w.gitea.head('events-stream'),
      },
    });
    expect(w.hub.puts.map(p => p.status)).toEqual(['in-progress', 'in-progress', 'in-progress', 'in-progress', 'completed']);

    // main now runs 1.0.1: one network policy fewer, the annotation and link updated, the image kept.
    const policies = w.gitea.show('events-stream', 'deploy/k8s/network-policy.yaml')!;
    expect(policies).toContain('web-service-database');
    expect(policies).not.toContain('web-service-cache');
    const info = YAML.parse(w.gitea.show('events-stream', 'catalog-info.yaml')!);
    expect(info.metadata.annotations['calm.finos.org/architecture-version']).toBe('1.0.1');
    expect(info.metadata.links[0].url).toMatch(/\/versions\/1\.0\.1$/);
    expect(w.gitea.show('events-stream', 'deploy/k8s-overlay/kustomization.yaml')).toContain('abc123');
    const message = require('node:child_process')
      .execFileSync('git', ['log', '-1', '--format=%B', 'main'], { cwd: w.gitea.bare('events-stream'), encoding: 'utf-8' });
    expect(message).toContain('Requested-by: alice via CALM Hub (audit aaaa1111-2222)');
    expect(w.kubectlCalls.some(c => c.includes('reconcile.fluxcd.io/requestedAt='))).toBe(true);
    expect(w.kubectlCalls.some(c => c.includes('rollout status deployment/web-service'))).toBe(true);

    // The tab now says this version runs, and that CALM Hub's record matches; history lists the deployment.
    const t: any = await tab(w, 'events-stream', '1.0.1');
    expect(t.body.blocks[0]).toStrictEqual({ type: 'alert', tone: 'positive', text: 'This version (1.0.1) is the one running in local.' });
    expect(t.body.blocks.find((b: any) => b.type === 'keyValue').items).toContainEqual({
      label: "CALM Hub's record",
      value: '1.0.1 completed — matches the platform',
    });
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments[0]).toMatchObject({ version: '1.0.1', status: 'completed' });
    expect(h.body.deployments[0].appliesTo).toBeUndefined();
  });

  it('deploys through the command route by name too', async () => {
    const w = make();
    const r: any = await call(w, 'POST', '/namespaces/hackathon/architectures/events-stream/versions/1.0.1/deployments', {});
    expect(r.status).toBe(202);
    await w.deps.jobs.idle();
    expect(w.hub.latest().data.status).toBe('completed');
  });

  it('is idempotent: deploying the version already running changes nothing and completes', async () => {
    const w = make();
    const before = w.gitea.head('events-stream');
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.0', {});
    await w.deps.jobs.idle();
    expect(w.hub.latest().data.status).toBe('completed');
    expect(w.hub.latest().data.notes).toContain('Already deployed');
    expect(w.gitea.head('events-stream')).toBe(before);
    expect(w.gitea.pulls).toHaveLength(0);
  });

  it('waits for a person to merge the pull request when approval is manual', async () => {
    const w = make({ approval: 'manual' });
    let polls = 0;
    w.deps.sleep = async () => {
      // Someone merges the pull request in Gitea after a few polls.
      if (++polls === 3 && w.gitea.pulls[0]?.state === 'open') w.gitea.merge('events-stream', 1);
    };
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    expect(w.hub.puts.some(p => p.notes.startsWith('Waiting for approval'))).toBe(true);
    expect(w.hub.latest().data.status).toBe('completed');
  });

  it('records a pull request closed without merging as a failed deployment', async () => {
    const w = make({ approval: 'manual' });
    w.deps.sleep = async () => {
      const pr = w.gitea.pulls[0];
      if (pr) pr.state = 'closed';
    };
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    expect(w.hub.latest().data).toMatchObject({ status: 'failed' });
    expect(w.hub.latest().data.notes).toContain('closed without merging');
  });

  it('records a deployment Flux does not apply as failed', async () => {
    const w = make({ fluxReady: false });
    let t = 0;
    w.deps.now = () => (t += 10_000);
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    expect(w.hub.latest().data.status).toBe('failed');
    expect(w.hub.latest().data.notes).toContain('Flux did not apply');
  });

  it('refuses a second deployment of the same service while one runs', async () => {
    const w = make({ approval: 'manual' });
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    // The job waits for approval until released; then the pull request is rejected, which ends it.
    w.deps.sleep = async () => {
      await gate;
      for (const pr of w.gitea.pulls) pr.state = 'closed';
    };
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {})).status).toBe(202);
    const second: any = await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('already running');
    release();
    await w.deps.jobs.idle();
  });

  it('accepts only one of two requests that arrive together', async () => {
    const w = make();
    const [a, b]: any[] = await Promise.all([
      call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {}),
      call(w, 'POST', '/namespaces/hackathon/architectures/events-stream/versions/1.0.1/deployments', {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await w.deps.jobs.idle();
    expect(w.hub.decorators.size).toBe(1);
    expect(w.gitea.pulls).toHaveLength(1);
    // The claim is released once the job ends: the next request is accepted.
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.0', {})).status).toBe(202);
    await w.deps.jobs.idle();
  });

  it('refuses a repository that runs another namespace’s architecture', async () => {
    const w = make();
    // The repository claims an architecture of the same name in another namespace.
    const { execFileSync } = require('node:child_process');
    const work = `${w.root}/rebind`;
    execFileSync('git', ['clone', '-q', w.gitea.bare('events-stream'), work]);
    const file = `${work}/catalog-info.yaml`;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('calm.finos.org/namespace: hackathon', 'calm.finos.org/namespace: other'));
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'rebind'], { cwd: work });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
    const r: any = await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('runs the architecture other/events-stream');
  });

  it('fails the step with CALM Hub’s reason when it refuses the record, and records that reason', async () => {
    const w = make();
    // CALM Hub refuses the first update (the "Rendering" step): nothing is pushed and the failure is recorded.
    w.hub.rejectPut = n => n === 1;
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    const d = w.hub.latest().data;
    expect(d.status).toBe('failed');
    expect(d.notes).toContain('Decorator does not match its $schema: /data/kubernetes: refused by the test');
    expect(w.gitea.pulls).toHaveLength(0);
  });

  it('logs, without throwing, when CALM Hub refuses even the record of the failure', async () => {
    const { createLogger } = await import('./logger');
    const lines: string[] = [];
    const w = make();
    w.deps.logger = createLogger('test', 'info', l => lines.push(l));
    w.hub.rejectPut = () => true;
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    expect(w.hub.latest().data.status).toBe('pending');
    expect(lines).toContainEqual(expect.stringContaining('Could not record that events-stream-1.0.1-aaaa1111 failed: CALM Hub refused'));
    // The outcome is not lost: history and status show it from memory, in place of the stale record.
    const id = Math.max(...w.hub.decorators.keys());
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments).toHaveLength(1);
    expect(h.body.deployments[0]).toMatchObject({ id, version: '1.0.1', status: 'failed' });
    expect(h.body.deployments[0].notes).toContain('CALM Hub did not record this');
    expect(((await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status')).body as any).running).toBeUndefined();
  });

  it('keeps the outcome in memory when CALM Hub does not take the final update, until it takes one', async () => {
    // CALM Hub refuses both final updates (completed, then failed): the decorator still says in-progress.
    const w = make();
    w.hub.rejectPut = (_n, d) => d.data.status === 'completed' || d.data.status === 'failed';
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    const id = Math.max(...w.hub.decorators.keys());
    expect(w.hub.decorators.get(id).data.status).toBe('in-progress');
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments).toHaveLength(1);
    expect(h.body.deployments[0]).toMatchObject({ id, status: 'failed', endTime: expect.any(String) });
    expect(h.body.deployments[0].notes).toMatch(/^Deployment failed: CALM Hub refused the decorator.*\(CALM Hub did not record this: /);
    const s: any = (await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status')).body;
    expect(s.running).toBeUndefined();
    expect(s.hubRecord).toMatchObject({ status: 'failed' });

    // CALM Hub refuses only "completed" and takes "failed": history reads CALM Hub's record, once.
    const v = make();
    v.hub.rejectPut = (_n, d) => d.data.status === 'completed';
    await call(v, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await v.deps.jobs.idle();
    const hv: any = await call(v, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(hv.body.deployments).toHaveLength(1);
    expect(hv.body.deployments[0]).toMatchObject({ status: 'failed' });
    expect(hv.body.deployments[0].notes).not.toContain('CALM Hub did not record this');
  });

  it('keeps CALM Hub’s reason in memory when it refuses the first record, and gives the claim back', async () => {
    const w = make();
    w.settings.kubernetes.context = '';
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {})).status).toBe(202);
    await w.deps.jobs.idle();
    expect(w.hub.decorators.size).toBe(0);
    expect(w.gitea.pulls).toHaveLength(0);
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments[0]).toMatchObject({ deploymentId: 'events-stream-1.0.1-aaaa1111', version: '1.0.1', status: 'failed' });
    expect(h.body.deployments[0].notes).toContain('Decorator does not match its $schema: /data/kubernetes: required property cluster missing');
    // The claim on the service was given back.
    w.settings.kubernetes.context = 'calm-backstage';
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {})).status).toBe(202);
    await w.deps.jobs.idle();
    expect(w.hub.latest().data.status).toBe('completed');
  });

  it('records a controls gate that could not run as a failed job in memory, with no decorator', async () => {
    const w = make();
    w.deps.validate = async () => {
      throw new Error('calm: command not found');
    };
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    expect(w.hub.decorators.size).toBe(0);
    const s: any = await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status');
    expect(s.body.running).toBeUndefined();
    const h: any = await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments');
    expect(h.body.deployments[0]).toMatchObject({ status: 'failed', notes: 'Deployment failed: calm: command not found' });
  });

  it('refuses unknown versions and services without a repository', async () => {
    const w = make();
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/9.9.9', {})).status).toBe(404);
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/no-repo/1.0.0', {})).status).toBe(409);
  });
});

const REQUIREMENT = 'http://hub.test/calm/domains/security/controls/permitted-connection/requirement/versions/1.0.0';
const history = async (w: World) =>
  ((await call(w, 'GET', '/history/namespaces/hackathon/architectures/events-stream/deployments')) as any).body.deployments;
const status = async (w: World) => ((await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status')) as any).body;

/** Adds version 1.0.2: 1.0.0 plus a stream node and the relationship web-service → stream; database carries a control. */
function addStreamVersion(w: World) {
  const doc = architectureDoc('events-stream', '1.0.2', ['database', 'cache', 'stream']);
  doc.relationships[0].controls = { security: { description: 'permitted', requirements: [{ 'requirement-url': REQUIREMENT }] } };
  w.hub.architectures.get('events-stream')!.versions.set('1.0.2', doc);
}

describe('controls gate', () => {
  it.each([
    ['no $schema', undefined],
    ['a $schema that is not a pattern', 'https://calm.finos.org/release/1.3/meta/calm.json'],
  ])('refuses a version with %s, and writes nothing to Git', async (_, schema) => {
    // The gate itself would pass: only the missing pattern may refuse it.
    const w = make({ validateErrors: [] });
    addStreamVersion(w);
    const doc = w.hub.architectures.get('events-stream')!.versions.get('1.0.2');
    if (schema === undefined) delete doc.$schema;
    else doc.$schema = schema;
    const before = w.gitea.head('events-stream');
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.2', {});
    await w.deps.jobs.idle();

    expect(w.hub.decorators.size).toBe(1);
    const d = w.hub.latest();
    expect(d.type).toBe('control-evaluation');
    expect(d.data.status).toBe('not-met');
    expect(d.data.findings[0].description).toContain('names no pattern');
    expect(w.gitea.head('events-stream')).toBe(before);
    expect(w.gitea.pulls).toHaveLength(0);
    expect((await history(w))[0].status).toBe('refused');
  });

  it('records a refused version as one control evaluation on the relationship it adds, and nothing else', async () => {
    const errors = ['connection web-service → stream is not permitted', 'e2', 'e3', 'e4', 'e5', 'e6'];
    const w = make({ validateErrors: errors });
    addStreamVersion(w);
    const before = w.gitea.head('events-stream');
    const r: any = await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.2', {});
    expect(r.status).toBe(202);
    expect(r.body).toStrictEqual({ hubApi: 0, deploymentId: 'events-stream-1.0.2-aaaa1111', status: 'pending' });
    await w.deps.jobs.idle();

    expect(w.hub.decorators.size).toBe(1);
    expect(w.hub.latest()).toStrictEqual({
      $schema: 'https://calm.finos.org/standards/control-evaluation/1.0/control-evaluation.decorator.standard.json',
      'unique-id': 'events-stream-1.0.2-gate-aaaa1111',
      type: 'control-evaluation',
      target: [
        '/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.2',
        '/api/calm/namespaces/hackathon/architectures/38/versions/1-0-2',
      ],
      'target-type': ['architecture'],
      'applies-to': ['web-service-stream', 'web-service', 'stream'],
      data: {
        control: {
          'unique-id': 'security',
          'control-id': 'permitted-connection',
          'requirement-url': REQUIREMENT,
          'attached-to': 'web-service-stream',
        },
        status: 'not-met',
        'evaluated-at': expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        findings: errors.slice(0, 5).map(description => ({ subject: 'web-service-stream', description, check: 'calm validate' })),
        engine: { name: 'calm validate' },
        actors: { 'requested-by': 'alice', 'hub-audit-id': 'aaaa1111-2222', connector: 'platform-connector' },
      },
    });
    // No deployment decorator, no branch, no pull request.
    expect([...w.hub.decorators.values()].filter(d => d.type === 'deployment')).toHaveLength(0);
    expect(w.gitea.head('events-stream')).toBe(before);
    expect(w.gitea.pulls).toHaveLength(0);
    const branches = require('node:child_process').execFileSync('git', ['branch', '--format=%(refname:short)'], {
      cwd: w.gitea.bare('events-stream'),
      encoding: 'utf-8',
    });
    expect(branches.trim()).toBe('main');
  });

  it('applies the evaluation to every node when the error is not on a relationship the version adds', async () => {
    // 1.0.1 only removes a relationship from the deployed 1.0.0, and carries no controls.
    const w = make({ validateErrors: ['control encryption-at-rest not met'] });
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    const d = w.hub.latest();
    expect(d.type).toBe('control-evaluation');
    expect(d['applies-to']).toEqual(['api-gateway', 'web-service', 'database']);
    expect(d.data.control).toStrictEqual({
      'unique-id': 'security',
      'requirement-url': 'http://hub.test/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1',
    });
    expect(d.data.findings).toEqual([{ subject: '1.0.1', description: 'control encryption-at-rest not met', check: 'calm validate' }]);
  });

  it('applies the evaluation to every node when the deployed version cannot be read', async () => {
    const w = make({ validateErrors: ['not permitted'] });
    addStreamVersion(w);
    w.hub.architectures.get('events-stream')!.versions.delete('1.0.0');
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.2', {});
    await w.deps.jobs.idle();
    const d = w.hub.latest();
    expect(d['applies-to']).toEqual(['api-gateway', 'web-service', 'database', 'cache', 'stream']);
    expect(d.data.control['attached-to']).toBeUndefined();
    // The requirement still comes from the first relationship with a security control.
    expect(d.data.control['requirement-url']).toBe(REQUIREMENT);
  });

  it('reports the refused attempt in history and status, read back from CALM Hub, and only this connector’s', async () => {
    const w = make({ validateErrors: ['connection web-service → stream is not permitted'] });
    addStreamVersion(w);
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.2', {});
    await w.deps.jobs.idle();
    const id = Math.max(...w.hub.decorators.keys());
    // Another engine's evaluation of the same version is not this connector's attempt.
    w.hub.decorators.set(999, { ...w.hub.latest(), data: { ...w.hub.latest().data, actors: { connector: 'someone-else' } } });

    const h = await history(w);
    expect(h).toEqual([
      {
        id,
        evaluationId: id,
        version: '1.0.2',
        status: 'refused',
        startTime: w.hub.decorators.get(id).data['evaluated-at'],
        requestedBy: 'alice',
        notes: 'Refused at the controls gate: connection web-service → stream is not permitted',
        deployedBy: 'platform-connector',
      },
    ]);
    const s = await status(w);
    expect(s.running).toBeUndefined();
    expect(s.deployedVersion).toBe('1.0.0');
    // A refusal is not a deployment record: the tab's record line ignores it.
    const t: any = await tab(w, 'events-stream', '1.0.2');
    expect(t.body.blocks.find((b: any) => b.type === 'keyValue').items).toContainEqual({ label: "CALM Hub's record", value: 'none' });

    // A later deployment lists before the refusal.
    w.deps.validate = fakeValidate();
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.0', {});
    await w.deps.jobs.idle();
    expect((await history(w)).map((e: any) => e.status)).toEqual(['completed', 'refused']);
  });

  it('keeps the refusal in memory when CALM Hub cannot record the evaluation', async () => {
    const w = make({ validateErrors: ['not permitted'] });
    addStreamVersion(w);
    w.deps.hub = new HubClient('http://hub.test', async (url, init) =>
      init?.method === 'POST' && JSON.parse(init.body).type === 'control-evaluation'
        ? { ok: false, status: 503, json: async () => ({}), text: async () => 'down' }
        : w.hub.fetch(url, init),
    );
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.2', {});
    await w.deps.jobs.idle();
    expect(w.hub.decorators.size).toBe(0);
    expect(await history(w)).toEqual([
      expect.objectContaining({
        deploymentId: 'events-stream-1.0.2-aaaa1111',
        status: 'refused',
        notes: 'Refused at the controls gate: not permitted',
      }),
    ]);
    expect((await history(w))[0].id).toBeUndefined();
  });

  it('validates before any deployment record exists, showing the job from memory meanwhile', async () => {
    const w = make();
    const seen: any = {};
    w.deps.validate = async o => {
      seen.decorators = w.hub.decorators.size;
      seen.status = await status(w);
      seen.history = await history(w);
      seen.second = await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
      return fakeValidate()(o);
    };
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();

    expect(seen.decorators).toBe(0);
    const notes = 'Validating 1.0.1 against its pattern and controls';
    expect(seen.status.running).toEqual({ status: 'validating', version: '1.0.1', notes });
    expect(seen.history).toEqual([
      {
        deploymentId: 'events-stream-1.0.1-aaaa1111',
        version: '1.0.1',
        status: 'validating',
        startTime: expect.any(String),
        environment: 'local',
        requestedBy: 'alice',
        notes,
        deployedBy: 'platform-connector',
      },
    ]);
    expect(seen.second.status).toBe(409);

    // Then the run completes as before, recorded once.
    expect(w.hub.decorators.size).toBe(1);
    expect(w.hub.latest().data.status).toBe('completed');
    const h = await history(w);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ id: Math.max(...w.hub.decorators.keys()), status: 'completed' });
    expect(w.hub.puts[0].notes).toMatch(/^Rendering /);
  });
});
