import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import { handle } from './app';
import { world, type World } from './test/fakes';

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
    expect(kv).toContainEqual({ label: 'Deployment rules', value: 'k8s-deploy@1.2.1' });
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
});

describe('deploy', () => {
  it('deploys a version: pending → in-progress → completed, through a merged pull request and Flux', async () => {
    const w = make();
    w.gitea.merge405s = 1;
    const r: any = await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', { namespace: 'hackathon' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ hubApi: 0, status: 'pending', deploymentId: 'events-stream-1.0.1-aaaa1111' });
    await w.deps.jobs.idle();

    const d = w.hub.latest();
    expect(d.target).toEqual([
      '/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1',
      '/api/calm/namespaces/hackathon/architectures/38/versions/1-0-1',
    ]);
    expect(d['applies-to']).toEqual(['web-service']);
    expect(d.data).toMatchObject({
      status: 'completed',
      environment: 'local',
      'architecture-version': '1.0.1',
      'requested-by': 'alice',
      'hub-audit-id': 'aaaa1111-2222',
      'deployed-by': 'gitops-deploy',
      'pull-request': 'http://gitea.test/calm-services/events-stream/pulls/1',
      commit: w.gitea.head('events-stream'),
    });
    expect(w.hub.puts.map(p => p.status)).toEqual(['in-progress', 'in-progress', 'in-progress', 'in-progress', 'in-progress', 'completed']);

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

    // The tab now says this version is deployed and lists the deployment.
    const t: any = await tab(w, 'events-stream', '1.0.1');
    expect(t.body.blocks[0]).toMatchObject({ tone: 'positive' });
    const table = t.body.blocks.find((b: any) => b.type === 'table');
    expect(table.rows[0][0]).toBe('1.0.1');
    expect(table.rows[0][1]).toEqual({ badge: 'completed', tone: 'positive' });
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

  it('stops at the controls gate: a version that fails validation is recorded failed and nothing is pushed', async () => {
    const w = make({ validateErrors: ['control encryption-at-rest not met'] });
    const before = w.gitea.head('events-stream');
    await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1', {});
    await w.deps.jobs.idle();
    expect(w.hub.latest().data.status).toBe('failed');
    expect(w.hub.latest().data.notes).toContain('control encryption-at-rest not met');
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

  it('refuses unknown versions and services without a repository', async () => {
    const w = make();
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/9.9.9', {})).status).toBe(404);
    expect((await call(w, 'POST', '/deploy/hackathon/architectures/no-repo/1.0.0', {})).status).toBe(409);
  });
});
