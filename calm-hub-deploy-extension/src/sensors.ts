import {
  architectureVersionPath,
  CalmHubError,
  evidenceDecorator,
  isStale,
  mirrorEvaluation,
  type EvidenceDecorator,
  type EvidenceResult,
} from '@internal/backstage-plugin-calm-common';
import { controlIdOf, requirementUrlOf } from './evaluation';
import { kubectlJson, parsePolicies, type Policy } from './platform';
import { versionTargets } from './record';
import { findArchitecture, readService, type ServiceInfo } from './resolve';
import type { ReadDeps } from './status';
import { NODE_LABEL, oneLine } from './deploy/kube';
import type { Jobs } from './deploy/job';

/**
 * Runtime evidence: on a timer and on demand, checks that what the architecture's controls ask of each connection
 * still holds in the cluster, and records what it saw in CALM Hub as an evidence decorator per check plus a standard
 * control evaluation per relationship, which CALM Hub's Control evaluations view draws (red when not met).
 */

export const SENSOR = 'platform-connector-sensors';
/** How often the sensors run. */
export const INTERVAL_MS = 5_000;
/** An unchanged result is written again this often, so its evidence stays fresh. */
export const HEARTBEAT_MS = 60_000;
/** How long one observation holds; past it, the evidence is stale and the control is not met. */
export const VALID_FOR_MS = 90_000;

const CONTROL = 'security';

export type SensorDeps = Pick<ReadDeps, 'hub' | 'gitea' | 'settings' | 'kubectl' | 'logger'> & {
  /** Deployments this connector runs: while one runs for a service, Git is ahead of the cluster, so it is not sensed. */
  jobs?: Pick<Jobs, 'isRunning'>;
  /** How long one write to CALM Hub may take before the sensors give up on it (default 5 s). */
  writeTimeoutMs?: number;
  now?: () => number;
};

/** One check on one relationship, as observed now. */
export interface CheckResult {
  /** The relationship's unique-id. */
  element: string;
  check: 'network-policy' | 'tls';
  result: 'pass' | 'fail';
  expected: string;
  observed: string;
  paths: string[];
}

export interface Sensing {
  namespace: string;
  architecture: string;
  version: string;
  observedAt: string;
  checks: CheckResult[];
  /** Reads that failed: their checks were not made (never reported as failed). */
  problems: string[];
}

/** A check as the panel shows it: its latest recorded result, stale once its observation is too old. */
export interface EvidenceRow {
  element: string;
  check: string;
  result: EvidenceResult;
  observed: string;
  observedAt: string;
  path?: string;
}

interface Tracked {
  id: number;
  namespace: string;
  architecture: string;
  /** `<architecture>-<environment>-<element>`: the evaluation is `<base>-security`, the evidence `<base>-<check>`. */
  base: string;
  body: any;
}

const items = (json: any): any[] => (Array.isArray(json?.items) ? json.items : []);

/** What a policy allows, for comparing Git with the cluster: every peer (pods, namespaces, addresses) and port. */
const shape = (p: Policy) =>
  JSON.stringify([p.node, p.ingress, p.egress, p.peers, p.ports, p.allPods]);

/** What a default-deny covers, for saying how the cluster's differs from Git's. */
const denyScope = (p: Policy) =>
  [p.allPods ? 'every pod' : `pods of ${p.node ?? 'some pods'}`, [p.ingress && 'ingress', p.egress && 'egress'].filter(Boolean).join(' and ') || 'nothing', p.peers === 'nothing allowed' ? '' : `but allows ${p.peers}`]
    .filter(Boolean)
    .join(', ');

/** A write CALM Hub did not answer in time: it may still land. */
class WriteTimeout extends Error {
  constructor(ms: number) {
    super(`CALM Hub did not answer within ${ms} ms`);
    this.name = 'WriteTimeout';
  }
}

/** The checks for one service, from what `main` renders (Git) and what the cluster holds. */
export async function senseService(deps: SensorDeps, service: ServiceInfo): Promise<{ checks: CheckResult[]; problems: string[] }> {
  const ns = service.kubernetesNamespace;
  const problems: string[] = [];
  const read = (kind: string) =>
    kubectlJson(deps, ns, kind).catch(e => {
      problems.push(`Cannot read the ${kind} objects in ${ns}: ${oneLine(e)}`);
      return undefined;
    });
  const gitPolicies = parsePolicies({ items: service.manifests.filter(m => m?.kind === 'NetworkPolicy') });
  const related = gitPolicies.filter(p => p.relationship);
  if (!related.length) return { checks: [], problems };
  // TLS is checked only against a Certificate Git renders: older bundles (k8s-deploy 1.2.x) annotate HTTPS but render
  // none, and their clusters may lack cert-manager, where reading Certificates fails on every tick for nothing.
  const tls = related.some(p => p.protocol === 'HTTPS') && service.manifests.some(m => m?.kind === 'Certificate');
  const [policyJson, certJson, deployJson] = await Promise.all([
    read('networkpolicy'),
    tls ? read('certificate') : undefined,
    tls ? read('deploy') : undefined,
  ]);
  const checks: CheckResult[] = [];
  const path = (kind: string, name: string) => `k8s://${ns}/${kind}/${name}`;

  if (policyJson) {
    const live = parsePolicies(policyJson);
    // default-deny holds when the cluster's has the shape Git's has (an ingress-only default-deny is as Git asks).
    const gitDeny = gitPolicies.find(p => p.name === 'default-deny');
    const denyInGit = gitDeny !== undefined;
    const liveDeny = live.find(p => p.name === 'default-deny');
    const denyLive = gitDeny !== undefined && liveDeny !== undefined && shape(liveDeny) === shape(gitDeny);
    for (const element of [...new Set(related.map(p => p.relationship!))]) {
      const mine = related.filter(p => p.relationship === element);
      const reasons: string[] = [];
      const broken: string[] = [];
      for (const p of mine) {
        const q = live.find(x => x.name === p.name);
        if (!q) reasons.push(`${p.name} is missing`);
        else if (shape(q) !== shape(p)) reasons.push(`${p.name} allows ${q.peers}; Git asks ${p.peers}`);
        else continue;
        broken.push(p.name);
      }
      // The policy that broke first, so the panel's evidence link points at it.
      const ordered = [...mine].sort((a, b) => Number(broken.includes(b.name)) - Number(broken.includes(a.name)));
      if (denyInGit && !denyLive) {
        reasons.push(
          liveDeny
            ? `default-deny is not as Git asks (it denies ${denyScope(liveDeny)}; Git asks ${denyScope(gitDeny!)}): traffic is no longer limited to the architecture`
            : 'default-deny is missing: traffic is no longer limited to the architecture',
        );
      }
      const expected = mine.map(p => `${p.name}: ${p.peers}`).join('; ');
      checks.push({
        element,
        check: 'network-policy',
        result: reasons.length ? 'fail' : 'pass',
        expected,
        observed: reasons.length ? reasons.join('; ') : `as Git asks: ${expected}`,
        paths: [...ordered.map(p => path('networkpolicy', p.name)), ...(denyInGit ? [path('networkpolicy', 'default-deny')] : [])],
      });
    }
  }

  if (certJson && deployJson) {
    for (const element of [...new Set(related.filter(p => p.protocol === 'HTTPS').map(p => p.relationship!))]) {
      const destination = related.find(p => p.relationship === element && p.ingress)?.node;
      const cert = service.manifests.find(m => m?.kind === 'Certificate' && m.metadata?.labels?.[NODE_LABEL] === destination);
      if (!destination || !cert) continue;
      const name = String(cert.metadata.name);
      const liveCert = items(certJson).find(c => c?.metadata?.name === name);
      const ready = (liveCert?.status?.conditions ?? []).some((c: any) => c?.type === 'Ready' && c?.status === 'True');
      const workload = items(deployJson).find(
        d => (d?.spec?.template?.metadata?.labels ?? d?.metadata?.labels ?? {})[NODE_LABEL] === destination,
      );
      const sidecar = (workload?.spec?.template?.spec?.containers ?? []).some((c: any) => c?.name === 'tls-proxy');
      const reasons = [
        ...(!liveCert ? [`Certificate ${name} is missing`] : !ready ? [`Certificate ${name} is not Ready`] : []),
        ...(!sidecar ? [`${destination} does not run the tls-proxy container`] : []),
      ];
      checks.push({
        element,
        check: 'tls',
        result: reasons.length ? 'fail' : 'pass',
        expected: `Certificate ${name} Ready and ${destination} behind tls-proxy`,
        observed: reasons.length ? reasons.join('; ') : `Certificate ${name} Ready, ${destination} runs tls-proxy`,
        paths: [path('certificate', name), path('deployment', String(workload?.metadata?.name ?? destination))],
      });
    }
  }
  return { checks, problems };
}

/** Senses services and keeps their evidence in CALM Hub current: on change, on heartbeat, and stale when too old. */
export class Sensors {
  private readonly tracked = new Map<string, Tracked>();
  private readonly latest = new Map<string, Sensing>();
  private readonly running = new Map<string, Promise<{ sensing?: Sensing; recorded: Promise<void> }>>();
  /** Every write to CALM Hub, one at a time: a sweep and a run never race on the same record. */
  private writes: Promise<void> = Promise.resolve();
  /** CALM Hub ids of records no longer tracked, by unique-id: a check that comes back replaces its old record. */
  private readonly retired = new Map<string, number>();
  private readonly numericIds = new Map<string, number | undefined>();
  /** Architecture versions as CALM Hub stores them, which never change once stored: read once each. */
  private readonly docs = new Map<string, unknown>();
  /**
   * Records whose create timed out, by unique-id, until when (wall clock): the POST may still land, and is tracked if
   * it does, so the record is not created a second time meanwhile.
   */
  private readonly creating = new Map<string, number>();

  constructor(private readonly deps: SensorDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Takes over the records an earlier run of this connector wrote, so they are replaced rather than duplicated. */
  async adopt(namespaces: string[]): Promise<void> {
    for (const ns of namespaces) {
      for (const type of ['evidence', 'control-evaluation']) {
        let ids: number[] = [];
        try {
          ids = await this.deps.hub.listDecorators(ns, { type });
        } catch (e) {
          this.deps.logger.warn(`Could not list ${type} decorators in ${ns}: ${oneLine(e)}`);
          continue;
        }
        for (const id of ids) {
          const d = await this.deps.hub.getDecorator(ns, id).catch(() => undefined);
          const data: any = d?.data ?? {};
          if (!d || (data.sensor?.name ?? data.engine?.name) !== SENSOR) continue;
          const architecture = (d.target ?? [])
            .map(t => /^\/calm\/namespaces\/[^/]+\/architectures\/([^/]+)\/versions\/[^/]+$/.exec(t)?.[1])
            .find(Boolean);
          const uid = String(d.uniqueId);
          // Another environment's connector writes its own records.
          if (!architecture || !uid.startsWith(`${architecture}-${this.deps.settings.environment}-`)) continue;
          const suffix = type === 'evidence' ? `-${data.check}` : `-${CONTROL}`;
          this.tracked.set(uid, {
            id,
            namespace: ns,
            architecture,
            base: uid.slice(0, -suffix.length),
            body: {
              $schema: d.schema,
              'unique-id': uid,
              type,
              target: d.target,
              'target-type': d.targetType ?? ['architecture'],
              'applies-to': d.appliesTo,
              data,
            },
          });
        }
      }
    }
  }

  /** Senses one architecture's service now and records what changed; undefined when the platform does not run it. */
  async run(namespace: string, architecture: string, service?: ServiceInfo): Promise<Sensing | undefined> {
    const { sensing, recorded } = await this.start(namespace, architecture, service);
    await recorded;
    return sensing;
  }

  /** Senses now and answers as soon as the checks are made; the records reach CALM Hub after (CALM Hub's 10 s). */
  async check(namespace: string, architecture: string): Promise<Sensing | undefined> {
    return (await this.start(namespace, architecture)).sensing;
  }

  private start(namespace: string, architecture: string, service?: ServiceInfo) {
    const key = `${namespace}/${architecture}`;
    const busy = this.running.get(key);
    if (busy) return busy;
    const job = this.sense(namespace, architecture, service).finally(() => this.running.delete(key));
    this.running.set(key, job);
    return job;
  }

  /** Queues a write to CALM Hub behind the others. */
  private enqueue(write: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(write).catch(e => this.deps.logger.warn(`Sensors could not record: ${oneLine(e)}`));
    return this.writes;
  }

  /** Runs every service in the deploy namespaces. */
  async tick(): Promise<void> {
    const { gitea, settings, logger } = this.deps;
    let repos: string[] = [];
    try {
      repos = await gitea.listRepos(settings.gitops.servicesOrg);
    } catch (e) {
      logger.warn(`Sensors could not list the services: ${oneLine(e)}`);
    }
    for (const repo of repos) {
      const service = await readService(gitea, settings, repo).catch(() => undefined);
      const ns = service?.architectureNamespace;
      if (!service?.architecture || !ns || !settings.deployNamespaces.includes(ns)) continue;
      // The service as just read, so the run does not read it from Gitea again.
      await this.run(ns, service.architecture, service).catch(e => logger.warn(`Sensors failed on ${service.architecture}: ${oneLine(e)}`));
    }
    await this.sweep();
  }

  /** Marks evidence whose observation is too old as stale, and its relationship's control not met. */
  sweep(): Promise<void> {
    return this.enqueue(() => this.sweepNow());
  }

  private async sweepNow(): Promise<void> {
    const now = this.now();
    const bases = new Set<string>();
    for (const t of this.tracked.values()) {
      if (t.body.type !== 'evidence' || t.body.data.result === 'stale' || !isStale(t.body.data, now)) continue;
      if (this.deps.jobs?.isRunning(t.architecture)) continue;
      await this.put(t, { ...t.body, data: { ...t.body.data, result: 'stale' } });
      bases.add(t.base);
    }
    for (const base of bases) await this.evaluate(base, now);
  }

  /** Every check last recorded for `architecture`, with its result now. */
  snapshot(namespace: string, architecture: string): { rows: EvidenceRow[]; problems: string[] } {
    const now = this.now();
    const rows = [...this.tracked.values()]
      .filter(t => t.body.type === 'evidence' && t.namespace === namespace && t.architecture === architecture)
      .map(t => {
        const d = t.body.data;
        return {
          element: t.body['applies-to'][0],
          check: d.check,
          result: isStale(d, now) ? 'stale' : d.result,
          observed: d.observed,
          observedAt: d['observed-at'],
          ...(d.evidence?.['evidence-paths']?.[0] ? { path: d.evidence['evidence-paths'][0] } : {}),
        } as EvidenceRow;
      });
    return { rows, problems: this.latest.get(`${namespace}/${architecture}`)?.problems ?? [] };
  }

  private async sense(namespace: string, architecture: string, read?: ServiceInfo): Promise<{ sensing?: Sensing; recorded: Promise<void> }> {
    const { gitea, settings } = this.deps;
    const none = { recorded: Promise.resolve() };
    // Only the namespaces this connector deploys to: it records nothing anywhere else.
    if (!settings.deployNamespaces.includes(namespace)) return none;
    const service = read ?? (await readService(gitea, settings, architecture));
    const version = service?.deployedVersion;
    if (!service || !version || service.architecture !== architecture || service.architectureNamespace !== namespace) return none;
    const now = this.now();
    const observedAt = new Date(now).toISOString();
    const deploying = () => {
      const problem = `A deployment of ${architecture} is running: the sensors wait until it ends, as Git is ahead of the cluster meanwhile`;
      return { sensing: { namespace, architecture, version, observedAt, checks: [], problems: [problem] }, recorded: Promise.resolve() };
    };
    if (this.deps.jobs?.isRunning(architecture)) return deploying();
    const [found, doc, numericId] = await Promise.all([
      senseService(this.deps, service),
      this.architectureDoc(namespace, architecture, version),
      this.numericId(namespace, architecture),
    ]);
    // A deployment that started during the reads may have changed the cluster under them.
    if (this.deps.jobs?.isRunning(architecture)) return deploying();
    const sensing: Sensing = { namespace, architecture, version, observedAt, ...found };
    this.latest.set(`${namespace}/${architecture}`, sensing);
    const recorded = this.enqueue(() => this.record(sensing, doc, numericId, now));
    return { sensing, recorded };
  }

  /** Writes what changed since the last records of this service. */
  private async record(sensing: Sensing, doc: unknown, numericId: number | undefined, now: number): Promise<void> {
    const { settings } = this.deps;
    const { namespace, architecture, version, observedAt } = sensing;
    const target = versionTargets(namespace, architecture, version, numericId);
    const versionUrl = `${settings.hubUrl}${architectureVersionPath(namespace, architecture, version)}`;
    const baseOf = (element: string) => `${architecture}-${settings.environment}-${element}`;

    const bases = new Set<string>();
    for (const c of sensing.checks) {
      const base = baseOf(c.element);
      const relationship = (doc as any)?.relationships?.find((r: any) => r?.['unique-id'] === c.element);
      const requirementUrl = requirementUrlOf(relationship, { relationships: relationship ? [relationship] : [] }, versionUrl);
      const controlId = controlIdOf(requirementUrl);
      const configUrl = relationship?.controls?.[CONTROL]?.requirements?.[0]?.['config-url'];
      const body = evidenceDecorator({
        uniqueId: `${base}-${c.check}`,
        target,
        appliesTo: [c.element],
        control: {
          'unique-id': CONTROL,
          ...(controlId ? { 'control-id': controlId } : {}),
          'requirement-url': requirementUrl,
          ...(typeof configUrl === 'string' ? { 'config-url': configUrl } : {}),
        },
        check: c.check,
        result: c.result,
        expected: c.expected,
        observed: c.observed,
        evidencePaths: c.paths,
        observedAt,
        validForMs: VALID_FOR_MS,
        sensor: { name: SENSOR },
        deployment: { environment: settings.environment },
      });
      const prev = this.tracked.get(body['unique-id']);
      const due =
        !prev ||
        prev.body.data.result !== body.data.result ||
        prev.body.data.observed !== body.data.observed ||
        JSON.stringify(prev.body.target) !== JSON.stringify(body.target) ||
        now - Date.parse(prev.body.data['observed-at']) >= HEARTBEAT_MS;
      // Every checked relationship is evaluated again: one whose last evaluation CALM Hub did not take is retried
      // (evaluate() writes nothing when the evaluation is unchanged).
      bases.add(base);
      if (!due) continue;
      if (prev) await this.put(prev, body);
      else await this.create({ namespace, architecture, base }, body);
    }
    // Evidence of a check this version no longer makes is not kept fresh, so it would go stale and keep its
    // relationship red. It is written once more as not-applicable, its relationship evaluated from that (so a
    // relationship with no check left ends not-applicable in CALM Hub rather than keeping its last status), and then
    // no longer tracked. Only after a full read: when a read failed, the checks it would have made stay tracked and
    // go stale.
    const dropped: [string, Tracked][] = [];
    if (!sensing.problems.length) {
      const seen = new Set(sensing.checks.map(c => `${baseOf(c.element)}-${c.check}`));
      for (const [uid, t] of this.tracked) {
        if (t.namespace !== namespace || t.architecture !== architecture || t.body.type !== 'evidence' || seen.has(uid)) continue;
        dropped.push([uid, t]);
        bases.add(t.base);
      }
      for (const [, t] of dropped) {
        const d = t.body.data;
        await this.put(t, {
          ...t.body,
          data: {
            ...d,
            result: 'not-applicable',
            observed: `${version} no longer makes this check`,
            'observed-at': observedAt,
            'valid-until': new Date(now + VALID_FOR_MS).toISOString(),
          },
        });
      }
    }
    for (const base of bases) await this.evaluate(base, now);
    // Stop tracking only what CALM Hub took: a write that failed is tried again on the next run.
    const checked = (base: string) => sensing.checks.some(c => baseOf(c.element) === base);
    for (const [uid] of dropped) {
      const t = this.tracked.get(uid);
      if (t?.body.data.result !== 'not-applicable') continue;
      // A relationship with no check left keeps its evidence until its evaluation is written not-applicable too.
      const ev = this.tracked.get(`${t.base}-${CONTROL}`);
      if (!checked(t.base) && ev && ev.body.data.status !== 'not-applicable') continue;
      this.untrack(uid, t);
    }
    if (!sensing.problems.length) {
      for (const [uid, t] of this.tracked) {
        if (t.body.type === 'evidence' || t.namespace !== namespace || t.architecture !== architecture || checked(t.base)) continue;
        // The evaluation of a relationship with no check left, once it is not-applicable and its evidence is let go.
        const evidenceLeft = [...this.tracked.values()].some(e => e.base === t.base && e.body.type === 'evidence');
        if (t.body.data.status === 'not-applicable' && !evidenceLeft) this.untrack(uid, t);
      }
    }
  }

  /** Writes the control evaluation for one relationship from its evidence, when its status or target changed. */
  private async evaluate(base: string, now: number): Promise<void> {
    const evidence = [...this.tracked.values()].filter(t => t.base === base && t.body.type === 'evidence');
    if (!evidence.length) return;
    const uid = `${base}-${CONTROL}`;
    const prev = this.tracked.get(uid);
    const failing = evidence.find(t => isStale(t.body.data, now) || t.body.data.result === 'fail') ?? evidence[0];
    const body = mirrorEvaluation(
      evidence.map(t => t.body as EvidenceDecorator),
      {
        uniqueId: uid,
        evaluatedAt: new Date(now).toISOString(),
        ...(prev ? { previousEvaluatedAt: prev.body.data['evaluated-at'] } : {}),
        engine: { name: SENSOR },
        reportUri: `${this.deps.settings.hubUrl}/api/calm/namespaces/${encodeURIComponent(failing.namespace)}/decorators/${failing.id}`,
      },
    );
    if (
      prev &&
      prev.body.data.status === body.data.status &&
      JSON.stringify(prev.body.data.findings) === JSON.stringify(body.data.findings) &&
      JSON.stringify(prev.body.target) === JSON.stringify(body.target)
    ) {
      return;
    }
    if (prev) await this.put(prev, body);
    else await this.create(evidence[0], body);
  }

  private untrack(uid: string, t: Tracked): void {
    this.tracked.delete(uid);
    this.retired.set(uid, t.id);
  }

  /** A write that CALM Hub does not answer in time fails, so one hung call cannot stop the sensors. */
  private bounded<T>(write: Promise<T>): Promise<T> {
    const ms = this.writeTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WriteTimeout(ms)), ms);
    });
    return Promise.race([write, timeout]).finally(() => clearTimeout(timer));
  }

  private writeTimeoutMs() {
    return this.deps.writeTimeoutMs ?? 5_000;
  }

  /** Writes a record not tracked yet: over the one it replaces when it comes back, else as a new one. */
  private async create(owner: Pick<Tracked, 'namespace' | 'architecture' | 'base'>, body: any): Promise<void> {
    const uid = body['unique-id'];
    const old = this.retired.get(uid);
    if (old === undefined) {
      await this.post(owner, body);
      return;
    }
    this.retired.delete(uid);
    const t: Tracked = { ...owner, id: old, body };
    const ok = await this.put(t, body);
    // put() may have recorded it afresh (the old record was gone); else it is tracked only once CALM Hub took it,
    // and the old record is kept to be replaced on the next try.
    if (this.tracked.has(uid)) return;
    if (ok) this.tracked.set(uid, t);
    else this.retired.set(uid, old);
  }

  /** POSTs a new record and tracks it. A POST that times out is tracked if it lands later, and not sent twice. */
  private async post(owner: Pick<Tracked, 'namespace' | 'architecture' | 'base'>, body: any): Promise<boolean> {
    const uid = body['unique-id'];
    if ((this.creating.get(uid) ?? 0) > Date.now()) return false;
    const write = this.deps.hub.createDecorator(owner.namespace, body);
    try {
      const id = await this.bounded(write);
      this.tracked.set(uid, { ...owner, id, body });
      return true;
    } catch (e) {
      this.deps.logger.warn(`Could not record ${uid}: ${oneLine(e)}`);
      if (e instanceof WriteTimeout) {
        this.creating.set(uid, Date.now() + 6 * this.writeTimeoutMs());
        write.then(
          id => {
            this.creating.delete(uid);
            const t = this.tracked.get(uid);
            if (!t) this.tracked.set(uid, { ...owner, id, body });
            else if (t.id !== id) this.deps.logger.warn(`A slow write of ${uid} landed late as decorator ${id}, beside decorator ${t.id}`);
          },
          () => this.creating.delete(uid),
        );
      }
      return false;
    }
  }

  /** Replaces a tracked record; one CALM Hub no longer has (deleted there) is recorded afresh. True if CALM Hub took it. */
  private async put(t: Tracked, body: any): Promise<boolean> {
    const uid = body['unique-id'];
    try {
      await this.bounded(this.deps.hub.updateDecorator(t.namespace, t.id, body));
      t.body = body;
      return true;
    } catch (e) {
      if (e instanceof CalmHubError && e.status === 404) {
        this.deps.logger.warn(`${uid} is gone from CALM Hub (decorator ${t.id}): recording it again`);
        if (this.tracked.get(uid) === t) this.tracked.delete(uid);
        return this.post(t, body);
      }
      this.deps.logger.warn(`Could not update ${uid}: ${oneLine(e)}`);
      return false;
    }
  }

  private async architectureDoc(namespace: string, architecture: string, version: string): Promise<unknown> {
    const key = `${namespace}/${architecture}/${version}`;
    if (this.docs.has(key)) return this.docs.get(key);
    try {
      const doc = await this.deps.hub.architecture(namespace, architecture, version);
      this.docs.set(key, doc);
      return doc;
    } catch (e) {
      this.deps.logger.warn(`Sensors could not read ${architecture} ${version}: ${oneLine(e)}`);
      return undefined;
    }
  }

  private async numericId(namespace: string, architecture: string): Promise<number | undefined> {
    const key = `${namespace}/${architecture}`;
    if (!this.numericIds.has(key)) {
      const ref = await findArchitecture(this.deps.hub, namespace, architecture).catch(() => undefined);
      if (!ref) return undefined;
      this.numericIds.set(key, ref.numericId);
    }
    return this.numericIds.get(key);
  }
}
