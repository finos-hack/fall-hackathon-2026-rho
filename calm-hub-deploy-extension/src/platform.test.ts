import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
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

const call = (w: World, method: string, url: string) =>
  handle(w.deps, { method, url, identity: 'token', body: Buffer.from('') }) as Promise<any>;
const status = async (w: World) => (await call(w, 'GET', '/namespaces/hackathon/architectures/events-stream/status')).body;
const tab = async (w: World, version: string) =>
  (await call(w, 'GET', `/tab/hackathon/architectures/events-stream?namespace=hackathon&version=${version}`)).body.blocks;
const node = async (w: World, element: string, id = 'events-stream') =>
  (
    await call(
      w,
      'GET',
      `/node/hackathon/architectures/${id}/${element}?namespace=hackathon&resource=architectures%2F${id}&resourceType=architectures&resourceId=${id}&version=1.0.0&selectedElement=${element}`,
    )
  ).body.blocks;
const keyValues = (blocks: any[]) => blocks.filter(b => b.type === 'keyValue').flatMap(b => b.items);
const value = (blocks: any[], label: string) => keyValues(blocks).find(i => i.label === label)?.value;

let nextRecord = 500;
/** A deployment record in CALM Hub, as any writer (here Backstage's layout) would leave it. */
function addRecord(w: World, version: string, status: string, startTime: string, appliesTo = ['web-service']) {
  const id = nextRecord++;
  w.hub.decorators.set(id, {
    'unique-id': `backstage-${id}`,
    type: 'deployment',
    target: [`/calm/namespaces/hackathon/architectures/events-stream/versions/${version}`],
    'target-type': ['architecture'],
    'applies-to': appliesTo,
    data: { 'start-time': startTime, 'end-time': startTime, status, 'deployed-by': 'backstage' },
  });
  return id;
}

/** Holds a manual-approval deployment at the approval step until `release` (then the pull request is rejected). */
async function waitingForApproval(w: World) {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  w.deps.sleep = async () => {
    await gate;
    for (const pr of w.gitea.pulls) pr.state = 'closed';
  };
  expect((await call(w, 'POST', '/deploy/hackathon/architectures/events-stream/1.0.1')).status).toBe(202);
  for (let i = 0; i < 500 && !w.deps.jobs.current('events-stream')?.pendingApproval; i++) await new Promise(r => setTimeout(r, 10));
  expect(w.deps.jobs.current('events-stream')?.pendingApproval).toBeDefined();
  return async () => {
    release();
    await w.deps.jobs.idle();
  };
}

describe('drift', () => {
  it('is empty when the platform runs what Git asks and CALM Hub records', async () => {
    const w = make();
    addRecord(w, '1.0.0', 'completed', '2026-11-01T10:00:00Z');
    const s = await status(w);
    expect(s).toMatchObject({
      managed: true,
      inSync: true,
      drift: [],
      fluxAtMain: true,
      mainCommit: w.gitea.head('events-stream'),
      workloads: [{ name: 'web-service', node: 'web-service', desired: 1, replicas: 1, ready: 1, images: ['events-stream:abc123'] }],
      hubRecord: { version: '1.0.0', status: 'completed', appliesTo: ['web-service'] },
    });
    expect(s.problems).toBeUndefined();
  });

  it('names a workload scaled away from what Git asks', async () => {
    const w = make();
    w.cluster.scaled['web-service'] = 0;
    const s = await status(w);
    expect(s.inSync).toBe(false);
    expect(s.drift).toEqual(['web-service runs 0 replicas; Git asks for 1']);
  });

  it('names a workload that is not ready', async () => {
    const w = make();
    w.cluster.ready['web-service'] = 0;
    expect((await status(w)).drift).toEqual(['web-service: 0 of 1 ready']);
  });

  it('names Flux behind main', async () => {
    const w = make();
    w.cluster.fluxBehind = true;
    const s = await status(w);
    expect(s.fluxAtMain).toBe(false);
    expect(s.drift).toEqual([
      `Flux has not applied main: it applied 0123456789ab, main is at ${w.gitea.head('events-stream').slice(0, 12)}`,
    ]);
  });

  it('names Flux not ready', async () => {
    const w = make({ fluxReady: false });
    expect((await status(w)).drift[0]).toBe('Flux is not ready: kustomize build failed');
  });

  it('names CALM Hub’s newest completed record when it says another version, whoever wrote it', async () => {
    const w = make();
    addRecord(w, '1.0.0', 'completed', '2026-11-01T10:00:00Z');
    addRecord(w, '1.0.1', 'completed', '2026-11-02T10:00:00Z');
    // A newer failed attempt is not what runs: the newest completed record is.
    addRecord(w, '1.0.0', 'failed', '2026-11-03T10:00:00Z');
    const s = await status(w);
    expect(s.hubRecord).toMatchObject({ version: '1.0.0', status: 'failed' });
    expect(s.drift).toEqual(["CALM Hub's newest record says 1.0.1; the platform runs 1.0.0"]);
  });

  it('reports a cluster it cannot read as a problem, neither in sync nor drift', async () => {
    const w = make();
    w.cluster.unreachable = true;
    const s = await status(w);
    expect(s.inSync).toBe(false);
    expect(s.drift).toEqual([]);
    expect(s.problems[0]).toContain('Cannot read the workloads: Unable to connect to the server');
  });

  it('reports deploying instead of drift while a connector job runs', async () => {
    const w = make({ approval: 'manual' });
    const done = await waitingForApproval(w);
    w.cluster.scaled['web-service'] = 0;
    const s = await status(w);
    expect(s.deploying).toMatchObject({ version: '1.0.1', status: 'in-progress' });
    expect(s.drift).toEqual([]);
    expect(s.pendingApproval).toBe('http://gitea.test/calm-services/events-stream/pulls/1');
    await done();
    expect((await status(w)).deploying).toBeUndefined();
  });
});

describe('designer tab (platform)', () => {
  it('shows no history table, and points to the Deployments view instead', async () => {
    const w = make();
    addRecord(w, '1.0.0', 'completed', '2026-11-01T10:00:00Z');
    const blocks = await tab(w, '1.0.0');
    expect(blocks.some((b: any) => b.type === 'table')).toBe(false);
    expect(blocks).toContainEqual({ type: 'markdown', text: 'Deployment history: the Deployments view on the diagram (View all).' });
    expect(value(blocks, "CALM Hub's record")).toBe('1.0.0 completed — matches the platform');
    expect(value(blocks, 'Commit applied')).toBe(w.gitea.head('events-stream').slice(0, 12));
    expect(value(blocks, 'Pending approval')).toBeUndefined();
    expect(blocks.find((b: any) => b.type === 'links').items.map((l: any) => l.label)).toEqual([
      'Service repository',
      `Commit ${w.gitea.head('events-stream').slice(0, 12)}`,
    ]);
  });

  it('leads with the first drift reason', async () => {
    const w = make();
    w.cluster.scaled['web-service'] = 0;
    w.cluster.fluxBehind = true;
    const blocks = await tab(w, '1.0.0');
    expect(blocks[0]).toEqual({ type: 'alert', tone: 'warning', text: expect.stringMatching(/^Drift: Flux has not applied main/) });
  });

  it('says when CALM Hub’s record disagrees with the platform', async () => {
    const w = make();
    addRecord(w, '1.0.1', 'completed', '2026-11-02T10:00:00Z');
    const blocks = await tab(w, '1.0.0');
    expect(blocks[0]).toEqual({
      type: 'alert',
      tone: 'warning',
      text: "Drift: CALM Hub's newest record says 1.0.1; the platform runs 1.0.0",
    });
    expect(value(blocks, "CALM Hub's record")).toBe('1.0.1 completed — drift: the platform runs 1.0.0');
  });

  it('shows the pull request a manual-approval job waits for', async () => {
    const w = make({ approval: 'manual' });
    const done = await waitingForApproval(w);
    const blocks = await tab(w, '1.0.1');
    expect(blocks[0]).toMatchObject({ type: 'alert', tone: 'info', text: expect.stringMatching(/^Deploying 1\.0\.1 \(in-progress\)/) });
    expect(value(blocks, 'Pending approval')).toBe('pull request #1');
    expect(blocks.find((b: any) => b.type === 'links').items).toContainEqual({
      label: 'Pending pull request #1',
      href: 'http://gitea.test/calm-services/events-stream/pulls/1',
    });
    await done();
  });
});

describe('node detail panel', () => {
  it('shows the workload the platform runs for a node, its policies and the record that applies to it', async () => {
    const w = make();
    addRecord(w, '1.0.0', 'completed', '2026-11-01T10:00:00Z');
    addRecord(w, '1.0.0', 'completed', '2026-11-02T10:00:00Z', ['database']);
    const blocks = await node(w, 'web-service');
    expect(blocks[0]).toEqual({ type: 'alert', tone: 'positive', text: 'In sync: web-service runs as Git asks.' });
    expect(keyValues(blocks)).toEqual([
      { label: 'Workload', value: 'web-service' },
      { label: 'Replicas ready', value: '1/1' },
      { label: 'Image', value: 'events-stream:abc123' },
      { label: 'Last change', value: `commit ${w.gitea.head('events-stream').slice(0, 12)}` },
      { label: 'Ingress allowed by', value: 'api-gateway-web-service-ingress (from api-gateway port 8080)' },
      {
        label: 'Egress allowed by',
        value: 'web-service-database-egress (to database port 5432); web-service-cache-egress (to cache port 5432)',
      },
      { label: 'Applies to all pods', value: 'default-deny, allow-dns' },
      { label: "CALM Hub's record", value: '1.0.0 completed at 2026-11-01 10:00:00Z' },
    ]);
    // A newer attempt that did not complete is shown with the newest completed one.
    addRecord(w, '1.0.1', 'failed', '2026-11-03T10:00:00Z');
    expect(value(await node(w, 'web-service'), "CALM Hub's record")).toBe(
      '1.0.1 failed at 2026-11-03 10:00:00Z; newest completed 1.0.0 at 2026-11-01 10:00:00Z',
    );
  });

  it('shows a scaled workload’s drift and the replicas the cluster asks for', async () => {
    const w = make();
    w.cluster.scaled['web-service'] = 0;
    const blocks = await node(w, 'web-service');
    expect(blocks[0]).toEqual({ type: 'alert', tone: 'warning', text: 'Drift: web-service runs 0 replicas; Git asks for 1' });
    expect(value(blocks, 'Replicas ready')).toBe('0/1 (the cluster asks for 0)');
  });

  it('shows the cluster read problem, not "Not run by the platform", for a node Git asks for', async () => {
    const w = make();
    w.cluster.unreachable = true;
    const blocks = await node(w, 'web-service');
    expect(blocks[0]).toEqual({
      type: 'alert',
      tone: 'warning',
      text: expect.stringContaining('Cannot read the workloads: Unable to connect to the server'),
    });
    expect(value(blocks, 'Workload')).toBe('web-service');
    expect(value(blocks, 'Replicas ready')).toBe('unknown/1 (cannot read the cluster)');
  });

  it('shows the drift of a node whose Deployment Git asks for is missing from the cluster', async () => {
    const w = make();
    const kubectl = w.deps.kubectl;
    // Someone deleted the Deployment: the cluster lists none.
    w.deps.kubectl = async (args, quiet, timeout) =>
      args.join(' ').includes('get deploy -o json') ? JSON.stringify({ items: [] }) : kubectl(args, quiet, timeout);
    const blocks = await node(w, 'web-service');
    expect(blocks[0]).toEqual({ type: 'alert', tone: 'warning', text: 'Drift: web-service is in Git but does not run in the cluster' });
    expect(value(blocks, 'Workload')).toBe('web-service');
    expect(value(blocks, 'Replicas ready')).toBe('0/1 (not in the cluster)');
    expect(value(blocks, 'Image')).toBe('none');
  });

  it('says a node is not run by the platform, with the policies naming it', async () => {
    const w = make();
    const blocks = await node(w, 'database');
    expect(blocks[0]).toEqual({ type: 'alert', tone: 'info', text: 'Not run by the platform' });
    expect(keyValues(blocks)).toEqual([
      { label: 'web-service-database-egress', value: 'Egress of web-service: to database port 5432' },
      { label: 'web-service-database-ingress', value: 'Ingress of database: from web-service port 5432' },
    ]);
    expect(keyValues(await node(w, 'api-gateway')).map(i => i.label)).toEqual(['api-gateway-web-service-ingress']);
    expect(await node(w, 'nothing-here')).toEqual([{ type: 'alert', tone: 'info', text: 'Not run by the platform' }]);
  });

  it('accepts the architecture’s numeric id', async () => {
    const w = make();
    expect(value(await node(w, 'web-service', '38'), 'Workload')).toBe('web-service');
  });

  it('explains an architecture the platform does not manage, and shows errors in the panel', async () => {
    const w = make();
    const blocks = await node(w, 'web-service', 'no-repo');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'alert', tone: 'info', text: expect.stringContaining('Not deployed through GitOps') });
    const r = await call(w, 'GET', '/node/hackathon/architectures/nope/web-service');
    expect(r.status).toBe(200);
    expect(r.body.blocks).toEqual([{ type: 'alert', tone: 'negative', text: 'No architecture nope in namespace hackathon' }]);
    w.deps.hub.architectures = async () => {
      throw new Error('socket hang up');
    };
    const broken = await call(w, 'GET', '/node/hackathon/architectures/events-stream/web-service');
    expect(broken.status).toBe(200);
    expect(broken.body.blocks[0]).toMatchObject({ tone: 'negative', text: 'socket hang up' });
  });
});

describe('landing card and services screen', () => {
  /** CALM Hub sends no namespace for an `authenticated` route. */
  function noNamespace(w: World) {
    const verify = w.deps.verify;
    w.deps.verify = async (t, req) => {
      const { ns: _ns, ...claims } = await verify(t, req);
      return claims;
    };
  }

  it('counts the services in sync and drifted, and names the first drift', async () => {
    const w = make();
    noNamespace(w);
    const card = await call(w, 'GET', '/card');
    expect(card.status).toBe(200);
    expect(card.body).toEqual({
      hubApi: 0,
      blocks: [
        {
          type: 'stats',
          items: [
            { label: 'Services', value: '1' },
            { label: 'In sync', value: '1' },
            { label: 'Drifted', value: '0' },
          ],
        },
      ],
    });

    const drifted = make();
    drifted.cluster.scaled['web-service'] = 0;
    const blocks = (await call(drifted, 'GET', '/card')).body.blocks;
    expect(blocks[0].items.map((i: any) => i.value)).toEqual(['1', '0', '1']);
    expect(blocks[1]).toEqual({ type: 'alert', tone: 'warning', text: 'events-stream: web-service runs 0 replicas; Git asks for 1' });
  });

  it('lists each service on the screen, linked to its architecture in CALM Hub', async () => {
    const w = make();
    noNamespace(w);
    const r = await call(w, 'GET', '/screen');
    expect(r.status).toBe(200);
    expect(r.body.blocks[0].type).toBe('stats');
    expect(r.body.blocks[1]).toEqual({
      type: 'table',
      columns: ['Service', 'Running version', 'Flux', 'Drift'],
      rows: [
        [
          { label: 'events-stream', hub: { namespace: 'hackathon', type: 'architectures', id: 'events-stream', version: '1.0.0' } },
          '1.0.0',
          'Ready',
          { badge: 'in sync', tone: 'positive' },
        ],
      ],
    });
  });

  it('counts only services whose architecture is in a namespace this instance deploys', async () => {
    const w = make();
    w.settings.deployNamespaces = ['other'];
    const r = await call(w, 'GET', '/screen');
    expect(r.body.blocks[0].items[0]).toEqual({ label: 'Services', value: '0' });
    expect(r.body.blocks[1]).toEqual({ type: 'markdown', text: 'No repository in calm-services names an architecture in other.' });
  });

  it('reuses one read for 10 s', async () => {
    const w = make();
    let t = 1_000_000;
    w.deps.now = () => t;
    const reads = () => w.kubectlCalls.filter(c => c.includes('get deploy -o json')).length;
    await call(w, 'GET', '/card');
    expect(reads()).toBe(1);
    t += 9_000;
    await call(w, 'GET', '/screen');
    await call(w, 'GET', '/card');
    expect(reads()).toBe(1);
    t += 1_001;
    await call(w, 'GET', '/card');
    expect(reads()).toBe(2);
  });
});
