import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { handle } from './app';
import { HubClient } from './hub';
import { readService } from './resolve';
import { Sensors, senseService } from './sensors';
import type { Kubectl } from './deploy/kube';
import { architectureDoc, world, type World } from './test/fakes';

const worlds: World[] = [];
function make() {
  const w = world();
  worlds.push(w);
  return w;
}
afterEach(() => {
  for (const w of worlds.splice(0)) fs.rmSync(w.root, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const REQUIREMENT = 'http://hub.test/calm/namespaces/hackathon-security/controls/permitted-connection/requirement/1.0.0';

/** A sensor whose clock the test moves. */
function sensors(w: World) {
  const clock = { t: T0 };
  return { s: new Sensors({ ...w.deps, now: () => clock.t }), clock };
}

const byType = (w: World, type: string) => [...w.hub.decorators.values()].filter(d => d.type === type);
const evidence = (w: World, uid: string) => byType(w, 'evidence').find(d => d['unique-id'] === uid);
const evaluation = (w: World, uid: string) => byType(w, 'control-evaluation').find(d => d['unique-id'] === uid);

/** Deploys 1.0.2, whose web-service → cache relationship is HTTPS (a TLS sidecar and a Certificate on cache). */
async function deployHttps(w: World) {
  const doc = architectureDoc('events-stream', '1.0.2', ['database', 'cache']);
  doc.relationships[1].protocol = 'HTTPS';
  for (const r of doc.relationships) {
    r.controls = { security: { description: 'permitted', requirements: [{ 'requirement-url': REQUIREMENT }] } };
  }
  w.hub.architectures.get('events-stream')!.versions.set('1.0.2', doc);
  await handle(w.deps, {
    method: 'POST',
    url: '/deploy/hackathon/architectures/events-stream/1.0.2',
    identity: 'token',
    body: Buffer.from('{}'),
  });
  await w.deps.jobs.idle();
  w.hub.decorators.clear();
}

describe('runtime checks', () => {
  it('passes the network policy of every connects relationship Git renders', async () => {
    const w = make();
    const { s } = sensors(w);
    const r = await s.run('hackathon', 'events-stream');
    expect(r?.problems).toEqual([]);
    expect(r?.checks.map(c => [c.element, c.check, c.result])).toEqual([
      ['web-service-database', 'network-policy', 'pass'],
      ['web-service-cache', 'network-policy', 'pass'],
    ]);
  });

  it('fails a relationship whose egress policy is there but whose ingress policy was deleted', async () => {
    const w = make();
    w.cluster.dropPolicies.push('web-service-database-ingress');
    const r = await sensors(w).s.run('hackathon', 'events-stream');
    const db = r!.checks.find(c => c.element === 'web-service-database')!;
    expect(db.result).toBe('fail');
    expect(db.observed).toContain('web-service-database-ingress is missing');
    expect(r!.checks.find(c => c.element === 'web-service-cache')!.result).toBe('pass');
  });

  it('fails a policy that carries the right annotation but allows another port', async () => {
    const w = make();
    w.cluster.policyPort['web-service-cache-ingress'] = 5433;
    const r = await sensors(w).s.run('hackathon', 'events-stream');
    const cache = r!.checks.find(c => c.element === 'web-service-cache')!;
    expect(cache.result).toBe('fail');
    expect(cache.observed).toContain('5433');
  });

  it('fails a policy someone widened to let other peers in on the same port', async () => {
    const w = make();
    w.cluster.widen.push('web-service-database-ingress');
    const r = await sensors(w).s.run('hackathon', 'events-stream');
    expect(r!.checks.find(c => c.element === 'web-service-database')!.result).toBe('fail');
  });

  it('fails every relationship when default-deny is gone, since nothing else is then denied', async () => {
    const w = make();
    w.cluster.dropPolicies.push('default-deny');
    const r = await sensors(w).s.run('hackathon', 'events-stream');
    expect(r!.checks.map(c => c.result)).toEqual(['fail', 'fail']);
    expect(r!.checks[0].observed).toContain('default-deny');
  });

  it('compares default-deny with the one Git renders: an ingress-only default-deny holds when Git asks for that', async () => {
    const w = make();
    const service = (await readService(w.deps.gitea, w.deps.settings, 'events-stream'))!;
    const ingressOnly = (d: any) => (d?.metadata?.name === 'default-deny' ? { ...d, spec: { ...d.spec, policyTypes: ['Ingress'] } } : d);
    // The cluster's default-deny denies ingress only.
    const kubectl: Kubectl = async (args, ...rest) => {
      const out = await w.deps.kubectl(args, ...rest);
      if (!args.join(' ').includes('get networkpolicy')) return out;
      const json = JSON.parse(out);
      return JSON.stringify({ ...json, items: json.items.map(ingressOnly) });
    };
    // Git asks for ingress and egress: not as Git asks.
    const asks = await senseService({ ...w.deps, kubectl }, service);
    expect(asks.checks.map(c => c.result)).toEqual(['fail', 'fail']);
    expect(asks.checks[0].observed).toContain('default-deny is not as Git asks');
    // Git asks for ingress only too: it holds.
    const same = await senseService({ ...w.deps, kubectl }, { ...service, manifests: service.manifests.map(ingressOnly) });
    expect(same.checks.map(c => c.result)).toEqual(['pass', 'pass']);
  });

  it('checks TLS on an HTTPS relationship: the Certificate is Ready and the destination runs tls-proxy', async () => {
    const w = make();
    await deployHttps(w);
    const { s } = sensors(w);
    const tls = async () => (await s.run('hackathon', 'events-stream'))!.checks.find(c => c.check === 'tls');
    expect((await tls())).toMatchObject({ element: 'web-service-cache', result: 'pass' });
    w.cluster.certNotReady.push('cache-tls');
    expect((await tls())).toMatchObject({ result: 'fail', observed: expect.stringContaining('cache-tls is not Ready') });
    w.cluster.certNotReady.length = 0;
    w.cluster.dropContainer.cache = 'tls-proxy';
    expect((await tls())).toMatchObject({ result: 'fail', observed: expect.stringContaining('tls-proxy') });
  });

  it('reads no Certificates for an HTTPS relationship when Git renders none, as k8s-deploy 1.2.x without cert-manager', async () => {
    const w = make();
    await deployHttps(w);
    const service = (await readService(w.deps.gitea, w.deps.settings, 'events-stream'))!;
    // As k8s-deploy 1.2.x renders: the policies are annotated HTTPS, but there is no Certificate.
    service.manifests = service.manifests.filter(m => m?.kind !== 'Certificate');
    const certReads: string[] = [];
    const kubectl: Kubectl = async (args, ...rest) => {
      if (args.join(' ').includes('get certificate')) {
        certReads.push(args.join(' '));
        throw new Error('kubectl exited with code 1: error: the server doesn\'t have a resource type "certificate"');
      }
      return w.deps.kubectl(args, ...rest);
    };
    const r = await senseService({ ...w.deps, kubectl }, service);
    expect(r.problems).toEqual([]);
    expect(certReads).toEqual([]);
    expect(r.checks.map(c => [c.element, c.check, c.result])).toEqual([
      ['web-service-database', 'network-policy', 'pass'],
      ['web-service-cache', 'network-policy', 'pass'],
    ]);
  });

  it('reports a kubectl failure as a problem and never as a failed check', async () => {
    const w = make();
    w.cluster.failKinds.push('networkpolicy');
    const r = await sensors(w).s.run('hackathon', 'events-stream');
    expect(r!.checks.filter(c => c.result === 'fail')).toEqual([]);
    expect(r!.problems).toHaveLength(1);
    expect(byType(w, 'evidence')).toHaveLength(0);
  });
});

describe('verify command', () => {
  it('senses now, answers with every check, and records a failure', async () => {
    const w = make();
    w.cluster.dropPolicies.push('web-service-database-ingress');
    const r: any = await handle(w.deps, {
      method: 'POST',
      url: '/namespaces/hackathon/architectures/events-stream/verify',
      identity: 'token',
      body: Buffer.from('{}'),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ managed: true, version: '1.0.0', holding: 1, checked: 2, problems: [] });
    expect(r.body.checks.map((c: any) => [c.element, c.result])).toEqual([
      ['web-service-database', 'fail'],
      ['web-service-cache', 'pass'],
    ]);
    // The records reach CALM Hub after the reply; a sweep queues behind them.
    await w.deps.sensors.sweep();
    expect(evaluation(w, 'events-stream-local-web-service-database-security').data.status).toBe('not-met');
  });

  it('answers with the checks without waiting for CALM Hub to take the records', async () => {
    const w = make();
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    const hub = new HubClient('http://hub.test', async (url, init) => {
      if (init?.method === 'POST' || init?.method === 'PUT') await held;
      return w.hub.fetch(url, init);
    });
    w.deps.sensors = new Sensors({ ...w.deps, hub });
    const r: any = await handle(w.deps, {
      method: 'POST',
      url: '/namespaces/hackathon/architectures/events-stream/verify',
      identity: 'token',
      body: Buffer.from('{}'),
    });
    expect(r.body.checked).toBe(2);
    expect(byType(w, 'evidence')).toHaveLength(0);
    release();
    await w.deps.sensors.sweep();
    expect(byType(w, 'evidence')).toHaveLength(2);
  });

  it('neither senses nor records outside the deploy namespaces', async () => {
    const w = make();
    const settings = { ...w.deps.settings, deployNamespaces: ['elsewhere'] };
    const deps = { ...w.deps, settings, sensors: new Sensors({ ...w.deps, settings }) };
    const r: any = await handle(deps, {
      method: 'POST',
      url: '/namespaces/hackathon/architectures/events-stream/verify',
      identity: 'token',
      body: Buffer.from('{}'),
    });
    expect(r.body).toMatchObject({ managed: false, checks: [] });
    expect(r.body.problems[0]).toContain('DEPLOY_NAMESPACES');
    expect(await deps.sensors.run('hackathon', 'events-stream')).toBeUndefined();
    expect(byType(w, 'evidence')).toHaveLength(0);
  });

  it('says so for an architecture the platform does not run', async () => {
    const w = make();
    const r: any = await handle(w.deps, {
      method: 'POST',
      url: '/namespaces/hackathon/architectures/no-repo/verify',
      identity: 'token',
      body: Buffer.from('{}'),
    });
    expect(r.body).toEqual({ namespace: 'hackathon', architecture: 'no-repo', managed: false, checks: [], problems: [] });
  });
});

describe('evidence records', () => {
  const DB_EV = 'events-stream-local-web-service-database-network-policy';
  const DB_EVAL = 'events-stream-local-web-service-database-security';
  const CACHE_EVAL = 'events-stream-local-web-service-cache-security';

  it('first run writes one evidence decorator per check and one control evaluation per relationship', async () => {
    const w = make();
    await sensors(w).s.run('hackathon', 'events-stream');
    expect(byType(w, 'evidence')).toHaveLength(2);
    expect(byType(w, 'control-evaluation')).toHaveLength(2);
    const ev = evidence(w, DB_EV);
    expect(ev['applies-to']).toEqual(['web-service-database']);
    expect(ev.target).toEqual([
      '/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.0',
      '/api/calm/namespaces/hackathon/architectures/38/versions/1-0-0',
    ]);
    expect(ev.data).toMatchObject({
      result: 'pass',
      'observed-at': '2026-11-18T10:00:00.000Z',
      'valid-until': '2026-11-18T10:01:30.000Z',
      evidence: { 'evidence-paths': expect.arrayContaining(['k8s://calm-events-stream/networkpolicy/web-service-database-ingress']) },
    });
    const evalDb = evaluation(w, DB_EVAL);
    expect(evalDb['applies-to']).toEqual(['web-service-database']);
    expect(evalDb.data.status).toBe('met');
    expect(evalDb.data['report-uri']).toMatch(/^http:\/\/hub\.test\/api\/calm\/namespaces\/hackathon\/decorators\/\d+$/);
  });

  it('writes nothing for an unchanged result before the 60 s heartbeat, then refreshes only the evidence', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    const count = w.hub.decorators.size;
    clock.t = T0 + 30_000;
    await s.run('hackathon', 'events-stream');
    expect(w.hub.puts).toHaveLength(0);
    clock.t = T0 + 60_000;
    await s.run('hackathon', 'events-stream');
    expect(w.hub.decorators.size).toBe(count);
    expect(w.hub.puts).toHaveLength(2);
    expect(evidence(w, DB_EV).data['observed-at']).toBe('2026-11-18T10:01:00.000Z');
    expect(evaluation(w, DB_EVAL).data['evaluated-at']).toBe('2026-11-18T10:00:00.000Z');
  });

  it('turns a relationship not-met as soon as its policy is deleted, and met again once it is back', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    w.cluster.dropPolicies.push('web-service-database-ingress');
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(evidence(w, DB_EV).data.result).toBe('fail');
    const broken = evaluation(w, DB_EVAL).data;
    expect(broken.status).toBe('not-met');
    expect(broken.findings[0]).toMatchObject({ subject: 'web-service-database', check: 'network-policy' });
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('met');

    w.cluster.dropPolicies.length = 0;
    clock.t = T0 + 10_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, DB_EVAL).data.status).toBe('met');
  });

  it('keeps one relationship not-met while another one changes', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    w.cluster.dropPolicies.push('web-service-database-ingress');
    await s.run('hackathon', 'events-stream');
    w.cluster.policyPort['web-service-cache-ingress'] = 5433;
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    w.cluster.policyPort = {};
    clock.t = T0 + 10_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('met');
    expect(evaluation(w, DB_EVAL).data.status).toBe('not-met');
  });

  it('marks evidence stale after 90 s without an observation, and its relationship not-met', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    w.cluster.failKinds.push('networkpolicy');
    clock.t = T0 + 30_000;
    await s.run('hackathon', 'events-stream');
    clock.t = T0 + 89_000;
    await s.sweep();
    expect(evidence(w, DB_EV).data.result).toBe('pass');
    clock.t = T0 + 91_000;
    await s.sweep();
    expect(evidence(w, DB_EV).data.result).toBe('stale');
    expect(evaluation(w, DB_EVAL).data).toMatchObject({ status: 'not-met', findings: [expect.objectContaining({ cause: 'stale' })] });
  });

  it('after a restart, takes over its own records instead of writing new ones', async () => {
    const w = make();
    await sensors(w).s.run('hackathon', 'events-stream');
    const count = w.hub.decorators.size;
    const { s, clock } = sensors(w);
    await s.adopt(['hackathon']);
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(w.hub.decorators.size).toBe(count);
    expect(w.hub.puts).toHaveLength(0);
    w.cluster.dropPolicies.push('web-service-database-ingress');
    await s.run('hackathon', 'events-stream');
    expect(w.hub.decorators.size).toBe(count);
    expect(evaluation(w, DB_EVAL).data.status).toBe('not-met');
  });

  it('keeps its evaluations out of the deployment history, even when not met', async () => {
    const w = make();
    w.cluster.dropPolicies.push('web-service-database-ingress');
    await sensors(w).s.run('hackathon', 'events-stream');
    const r: any = await handle(w.deps, {
      method: 'GET',
      url: '/history/namespaces/hackathon/architectures/events-stream/deployments',
      identity: 'token',
      body: Buffer.from(''),
    });
    expect(r.status).toBe(200);
    expect(r.body.deployments).toEqual([]);
  });

  it('records nothing while a deployment of the service runs, since Git is then ahead of the cluster', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    w.deps.jobs.reserve('events-stream');
    let release!: () => void;
    w.deps.jobs.start('events-stream', { status: 'in-progress' } as any, () => new Promise<void>(r => (release = r)));
    w.cluster.dropPolicies.push('web-service-database-ingress');
    clock.t = T0 + 5_000;
    const during = await s.run('hackathon', 'events-stream');
    expect(during?.checks).toEqual([]);
    expect(during?.problems[0]).toContain('deployment');
    // Nor does its evidence go stale meanwhile: nobody could refresh it.
    clock.t = T0 + 120_000;
    await s.sweep();
    expect(evidence(w, DB_EV).data.result).toBe('pass');
    release();
    await w.deps.jobs.idle();
    await s.run('hackathon', 'events-stream');
    expect(evidence(w, DB_EV).data.result).toBe('fail');
  });

  it('drops a check the deployed version no longer makes, so it cannot keep the relationship red', async () => {
    const w = make();
    await deployHttps(w);
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    expect(evidence(w, 'events-stream-local-web-service-cache-tls')).toBeDefined();
    // 1.0.3 makes web-service → cache plain TCP: no TLS check any more.
    const doc = architectureDoc('events-stream', '1.0.3', ['database', 'cache']);
    w.hub.architectures.get('events-stream')!.versions.set('1.0.3', doc);
    await handle(w.deps, { method: 'POST', url: '/deploy/hackathon/architectures/events-stream/1.0.3', identity: 'token', body: Buffer.from('{}') });
    await w.deps.jobs.idle();
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    clock.t = T0 + 100_000;
    await s.sweep();
    await s.run('hackathon', 'events-stream');
    const cache = evaluation(w, CACHE_EVAL);
    expect(cache.data.status).toBe('met');
    expect(cache.target[0]).toBe('/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.3');
    expect(s.snapshot('hackathon', 'events-stream').rows.map(r => r.check)).not.toContain('tls');
  });

  it('after a restart, finds its records whichever target CALM Hub lists first, and only its own environment', async () => {
    const w = make();
    await sensors(w).s.run('hackathon', 'events-stream');
    for (const d of w.hub.decorators.values()) d.target = [...d.target].reverse();
    const foreign = { ...evidence(w, DB_EV), 'unique-id': 'events-stream-prod-web-service-database-network-policy' };
    w.hub.decorators.set(9999, foreign);
    const { s, clock } = sensors(w);
    await s.adopt(['hackathon']);
    expect(s.snapshot('hackathon', 'events-stream').rows).toHaveLength(2);
    clock.t = T0 + 100_000;
    await s.sweep();
    expect(w.hub.decorators.get(9999).data.result).toBe('pass');
  });

  it('retries an evaluation CALM Hub did not take, on the next run', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    let refused = 0;
    w.hub.rejectPut = (_n, d) => d.type === 'control-evaluation' && refused++ === 0;
    w.cluster.dropPolicies.push('web-service-database-ingress');
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, DB_EVAL).data.status).toBe('met');
    clock.t = T0 + 10_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, DB_EVAL).data.status).toBe('not-met');
  });

  it('gives up on a write that never returns, so sensing goes on', async () => {
    const w = make();
    let hung = 0;
    const hub = new HubClient('http://hub.test', async (url, init) =>
      init?.method === 'POST' && hung++ === 0 ? new Promise<never>(() => {}) : w.hub.fetch(url, init),
    );
    const s = new Sensors({ ...w.deps, hub, writeTimeoutMs: 20, now: () => T0 });
    await s.run('hackathon', 'events-stream');
    expect(byType(w, 'evidence')).toHaveLength(1);
    // A timed-out create is not sent again for six timeouts, in case it lands late; then it is.
    await new Promise(r => setTimeout(r, 150));
    await s.run('hackathon', 'events-stream');
    expect(byType(w, 'evidence')).toHaveLength(2);
  });

  it('tracks a create that lands after it timed out, rather than creating the record twice', async () => {
    const w = make();
    let slow = 0;
    const hub = new HubClient('http://hub.test', async (url, init) => {
      if (init?.method === 'POST' && slow++ === 0) await new Promise(r => setTimeout(r, 60));
      return w.hub.fetch(url, init);
    });
    const { s: _unused, clock } = sensors(w);
    const s = new Sensors({ ...w.deps, hub, writeTimeoutMs: 20, now: () => clock.t });
    await s.run('hackathon', 'events-stream');
    await new Promise(r => setTimeout(r, 200));
    w.cluster.dropPolicies.push('web-service-database-ingress');
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(byType(w, 'evidence').filter(d => d['unique-id'] === DB_EV)).toHaveLength(1);
    expect(evidence(w, DB_EV).data.result).toBe('fail');
  });

  it('records again a record someone deleted from CALM Hub', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    const [id] = [...w.hub.decorators].find(([, d]) => d['unique-id'] === DB_EV)!;
    w.hub.decorators.delete(id);
    w.cluster.dropPolicies.push('web-service-database-ingress');
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(evidence(w, DB_EV).data.result).toBe('fail');
    expect(evaluation(w, DB_EVAL).data.status).toBe('not-met');
  });

  it('tries again to replace the record of a check that comes back, when CALM Hub refused the first replacement', async () => {
    const w = make();
    await deployHttps(w);
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    const tlsId = 'events-stream-local-web-service-cache-tls';
    const deploy = async (version: string, https: boolean) => {
      const doc = architectureDoc('events-stream', version, ['database', 'cache']);
      if (https) doc.relationships[1].protocol = 'HTTPS';
      w.hub.architectures.get('events-stream')!.versions.set(version, doc);
      await handle(w.deps, { method: 'POST', url: `/deploy/hackathon/architectures/events-stream/${version}`, identity: 'token', body: Buffer.from('{}') });
      await w.deps.jobs.idle();
    };
    await deploy('1.0.3', false);
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    await deploy('1.0.4', true);
    let refused = 0;
    w.hub.rejectPut = (_n, d) => d['unique-id'] === tlsId && refused++ === 0;
    clock.t = T0 + 10_000;
    await s.run('hackathon', 'events-stream');
    clock.t = T0 + 15_000;
    await s.run('hackathon', 'events-stream');
    const tls = byType(w, 'evidence').filter(d => d['unique-id'] === tlsId);
    expect(tls).toHaveLength(1);
    expect(tls[0].target[0]).toBe('/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.4');
    expect(tls[0].data.result).toBe('pass');
  });

  it('leaves a relationship the deployed version no longer has not-applicable, not at its last status', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    w.cluster.dropPolicies.push('web-service-cache-ingress');
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('not-met');
    // 1.0.3 has no cache, so no web-service → cache relationship and no check on it.
    const doc = architectureDoc('events-stream', '1.0.3', ['database']);
    w.hub.architectures.get('events-stream')!.versions.set('1.0.3', doc);
    await handle(w.deps, { method: 'POST', url: '/deploy/hackathon/architectures/events-stream/1.0.3', identity: 'token', body: Buffer.from('{}') });
    await w.deps.jobs.idle();
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('not-applicable');
    expect(evidence(w, 'events-stream-local-web-service-cache-network-policy').data.result).toBe('not-applicable');
    // No longer tracked: nothing turns it stale (and red) later.
    clock.t = T0 + 200_000;
    await s.sweep();
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('not-applicable');
  });

  it('keeps a dropped relationship tracked until CALM Hub takes its not-applicable evaluation', async () => {
    const w = make();
    const { s, clock } = sensors(w);
    w.cluster.dropPolicies.push('web-service-cache-ingress');
    await s.run('hackathon', 'events-stream');
    const doc = architectureDoc('events-stream', '1.0.3', ['database']);
    w.hub.architectures.get('events-stream')!.versions.set('1.0.3', doc);
    await handle(w.deps, { method: 'POST', url: '/deploy/hackathon/architectures/events-stream/1.0.3', identity: 'token', body: Buffer.from('{}') });
    await w.deps.jobs.idle();
    let refused = 0;
    w.hub.rejectPut = (_n, d) => d['unique-id'] === CACHE_EVAL && refused++ === 0;
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('not-met');
    clock.t = T0 + 10_000;
    await s.run('hackathon', 'events-stream');
    expect(evaluation(w, CACHE_EVAL).data.status).toBe('not-applicable');
  });

  it('reads each stored architecture version from CALM Hub once, and each service from Gitea once per tick', async () => {
    const w = make();
    const versionReads: string[] = [];
    const hub = new HubClient('http://hub.test', async (url, init) => {
      if (/\/architectures\/[^/]+\/versions\/[\d.]+$/.test(String(url))) versionReads.push(String(url));
      return w.hub.fetch(url, init);
    });
    let giteaCalls = 0;
    const gitea = new Proxy(w.deps.gitea, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (...a: unknown[]) => (giteaCalls++, v.apply(target, a)) : v;
      },
    });
    await readService(gitea, w.deps.settings, 'events-stream');
    const perService = giteaCalls;
    giteaCalls = 0;
    const s = new Sensors({ ...w.deps, hub, gitea, now: () => T0 });
    await s.tick();
    expect(giteaCalls).toBe(1 + perService); // the list of repositories, then the one service
    await s.run('hackathon', 'events-stream');
    expect(versionReads.filter(u => u.endsWith('/versions/1.0.0'))).toHaveLength(1);
  });

  it('replaces, not duplicates, the record of a check that comes back', async () => {
    const w = make();
    await deployHttps(w);
    const { s, clock } = sensors(w);
    await s.run('hackathon', 'events-stream');
    const tlsId = 'events-stream-local-web-service-cache-tls';
    const plain = architectureDoc('events-stream', '1.0.3', ['database', 'cache']);
    w.hub.architectures.get('events-stream')!.versions.set('1.0.3', plain);
    await handle(w.deps, { method: 'POST', url: '/deploy/hackathon/architectures/events-stream/1.0.3', identity: 'token', body: Buffer.from('{}') });
    await w.deps.jobs.idle();
    clock.t = T0 + 5_000;
    await s.run('hackathon', 'events-stream');
    const again = architectureDoc('events-stream', '1.0.4', ['database', 'cache']);
    again.relationships[1].protocol = 'HTTPS';
    w.hub.architectures.get('events-stream')!.versions.set('1.0.4', again);
    await handle(w.deps, { method: 'POST', url: '/deploy/hackathon/architectures/events-stream/1.0.4', identity: 'token', body: Buffer.from('{}') });
    await w.deps.jobs.idle();
    clock.t = T0 + 10_000;
    await s.run('hackathon', 'events-stream');
    const tls = byType(w, 'evidence').filter(d => d['unique-id'] === tlsId);
    expect(tls).toHaveLength(1);
    expect(tls[0].target[0]).toBe('/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.4');
  });

  it('runs every managed service on a tick', async () => {
    const w = make();
    await sensors(w).s.tick();
    expect(byType(w, 'evidence')).toHaveLength(2);
  });
});

describe('panels', () => {
  const get = async (w: World, url: string) =>
    ((await handle(w.deps, { method: 'GET', url, identity: 'token', body: Buffer.from('') })) as any).body.blocks;
  const tab = (w: World) => get(w, '/tab/hackathon/architectures/events-stream?namespace=hackathon&version=1.0.0');
  const panel = (w: World, element: string) =>
    get(
      w,
      `/node/hackathon/architectures/events-stream/${element}?namespace=hackathon&resource=architectures%2Fevents-stream&resourceType=architectures&resourceId=events-stream&version=1.0.0&selectedElement=${element}`,
    );

  it('the connection panel shows the runtime evidence, and says when the control is not met', async () => {
    const w = make();
    w.cluster.dropPolicies.push('web-service-database-ingress');
    await w.deps.sensors.run('hackathon', 'events-stream');
    const blocks = await panel(w, 'web-service-database');
    expect(blocks[0]).toMatchObject({ type: 'alert', tone: 'negative', text: expect.stringContaining('web-service-database-ingress is missing') });
    const table = blocks.find((b: any) => b.type === 'table');
    expect(table.columns).toEqual(['Check', 'Result', 'Observed', 'At', 'Evidence']);
    expect(table.rows).toEqual([
      [
        'network-policy',
        { badge: 'fail', tone: 'negative' },
        expect.stringContaining('is missing'),
        expect.stringMatching(/^\d{4}-/),
        'k8s://calm-events-stream/networkpolicy/web-service-database-ingress',
      ],
    ]);
    expect((await panel(w, 'web-service-cache'))[0]).toMatchObject({ tone: 'positive' });
  });

  it('the Deployment tab counts the runtime checks that hold, once the sensors have run', async () => {
    const w = make();
    expect((await tab(w)).some((b: any) => b.type === 'stats')).toBe(false);
    w.cluster.dropPolicies.push('web-service-database-ingress');
    await w.deps.sensors.run('hackathon', 'events-stream');
    expect((await tab(w)).find((b: any) => b.type === 'stats')).toEqual({
      type: 'stats',
      items: [{ label: 'Runtime checks holding', value: '1/2' }],
    });
    // The evidence is about the running version, not another one on screen.
    const other = await get(w, '/tab/hackathon/architectures/events-stream?namespace=hackathon&version=1.0.1');
    expect(other.some((b: any) => b.type === 'stats')).toBe(false);
  });
});
