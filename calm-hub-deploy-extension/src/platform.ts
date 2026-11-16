import { ReadTimeout } from './errors';
import type { HistoryEntry } from './record';
import { readService, type ServiceInfo } from './resolve';
import { KUBECTL_TIMEOUT_MS, readHistory, readStatus, type ReadDeps, type Status } from './status';
import type { Jobs } from './deploy/job';
import { NODE_LABEL, OVERLAY_FILE, imageRepository, oneLine, parseOverlayImage, type OverlayImage } from './deploy/kube';

/**
 * What only the platform knows, next to what CALM Hub records: what really runs for a service, and whether it
 * matches Git and CALM Hub's newest deployment record (drift). CALM Hub draws deployment records but cannot tell
 * whether one is still true.
 */

export type PlatformDeps = ReadDeps & { jobs: Jobs };

/** A Deployment in the service's Kubernetes namespace, with what Git asks of it. */
export interface Workload {
  name: string;
  /** The architecture node it runs (label `calm.finos.org/node`). */
  node?: string;
  /** Replicas Git asks for (`deploy/k8s` on `main`); undefined when Git has no such Deployment. */
  desired?: number;
  /** `spec.replicas` in the cluster. */
  replicas: number;
  /** `status.readyReplicas` in the cluster (absent means 0). */
  ready: number;
  images: string[];
}

/** A NetworkPolicy: the node it selects, or every pod, and the directions it covers. */
export interface Policy {
  name: string;
  node?: string;
  /** Its pod selector is empty: it applies to every pod in the namespace. */
  allPods: boolean;
  ingress: boolean;
  egress: boolean;
  /** Who it lets in or out, e.g. `from api-gateway port 8080`. */
  peers: string;
  /** Nodes the policy's peers select. */
  peerNodes: string[];
}

/** A CALM Hub deployment record, as the platform compares it. */
export interface HubRecord {
  version?: string;
  status: string;
  startTime?: string;
  endTime?: string;
  appliesTo?: string[];
}

/** One reason the platform does not match Git or CALM Hub; `workload` when it is about one Deployment. */
export interface DriftReason {
  text: string;
  workload?: string;
}

export interface Platform {
  environment: string;
  /** The architecture version on `main` (`catalog-info.yaml`). */
  version?: string;
  flux: { ready?: boolean; message?: string; commit?: string; mainCommit?: string; atMain?: boolean };
  workloads: Workload[];
  /** Workloads Git asks for that the cluster does not run. */
  missing: string[];
  /** The image Git asks for: the overlay's `calm-service` entry (`deploy/k8s-overlay` on `main`). */
  image?: OverlayImage;
  policies: Policy[];
  /** CALM Hub's newest deployment record (any version, any writer), and its newest completed one. */
  record?: HubRecord;
  completed?: HubRecord;
  /** A connector job is running for the service: drift is not reported meanwhile. */
  deploying?: { version?: string; status: string; notes?: string };
  /** The pull request a connector job waits for a person to merge. */
  pendingApproval?: { number: number; url: string };
  drift: DriftReason[];
  /** Reads that failed: the platform's state is unknown, neither in sync nor drifted. */
  problems: string[];
}

/**
 * What the tab, panel, card and status read together. `platform` is undefined when the service is not managed, or
 * when whether it is could not be read; `problems` then says what could not be read.
 */
export interface PlatformView {
  status: Status;
  history: HistoryEntry[];
  service?: ServiceInfo;
  platform?: Platform;
  problems?: string[];
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const label = (o: any): string | undefined => {
  const v = o?.matchLabels?.[NODE_LABEL];
  return typeof v === 'string' ? v : undefined;
};
const isEmptySelector = (o: any) =>
  !o || (Object.keys(o.matchLabels ?? {}).length === 0 && list(o.matchExpressions).length === 0);

/** The Deployments of `kubectl get deploy -o json`. */
export function parseWorkloads(json: any, git: ServiceInfo['deployments']): Workload[] {
  return list(json?.items).map((d: any) => {
    const name = String(d?.metadata?.name ?? '');
    const node = d?.metadata?.labels?.[NODE_LABEL] ?? d?.spec?.template?.metadata?.labels?.[NODE_LABEL];
    const desired = git.find(g => g.name === name)?.replicas;
    const replicas = d?.spec?.replicas;
    const ready = d?.status?.readyReplicas;
    return {
      name,
      ...(typeof node === 'string' ? { node } : {}),
      ...(desired !== undefined ? { desired } : {}),
      replicas: typeof replicas === 'number' ? replicas : 1,
      ready: typeof ready === 'number' ? ready : 0,
      images: list(d?.spec?.template?.spec?.containers)
        .map((c: any) => c?.image)
        .filter((i: unknown): i is string => typeof i === 'string'),
    };
  });
}

function describePeers(rules: any[], word: 'from' | 'to'): { text: string[]; nodes: string[] } {
  const text: string[] = [];
  const nodes: string[] = [];
  for (const rule of rules) {
    const peers = list(rule?.[word]);
    const who = peers.length
      ? peers.map((p: any) => {
          const node = label(p?.podSelector);
          if (node) {
            nodes.push(node);
            return node;
          }
          const ns = p?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'];
          if (typeof ns === 'string') return `namespace ${ns}`;
          if (p?.ipBlock?.cidr) return String(p.ipBlock.cidr);
          return 'selected pods';
        })
      : ['anywhere'];
    const ports = list(rule?.ports)
      .map((p: any) => p?.port)
      .filter((p: unknown) => p !== undefined);
    text.push(`${word} ${who.join(', ')}${ports.length ? ` port ${[...new Set(ports)].join(', ')}` : ''}`);
  }
  return { text, nodes };
}

/** The NetworkPolicies of `kubectl get networkpolicy -o json`. */
export function parsePolicies(json: any): Policy[] {
  return list(json?.items).map((p: any) => {
    const spec = p?.spec ?? {};
    const types: string[] = Array.isArray(spec.policyTypes)
      ? spec.policyTypes
      : ['Ingress', ...(Array.isArray(spec.egress) ? ['Egress'] : [])];
    const ingress = describePeers(list(spec.ingress), 'from');
    const egress = describePeers(list(spec.egress), 'to');
    const allPods = isEmptySelector(spec.podSelector);
    const node = allPods ? undefined : label(spec.podSelector);
    const peers = [...ingress.text, ...egress.text];
    return {
      name: String(p?.metadata?.name ?? ''),
      ...(node ? { node } : {}),
      allPods,
      ingress: types.includes('Ingress'),
      egress: types.includes('Egress'),
      peers: peers.length ? peers.join('; ') : 'nothing allowed',
      peerNodes: [...new Set([...ingress.nodes, ...egress.nodes])],
    };
  });
}

/** Policies with an empty pod selector: they apply to every pod (e.g. default-deny, allow-dns). */
export const allPodsPolicies = (p: Platform) => p.policies.filter(x => x.allPods);

/**
 * Policies that name `id` (a node or relationship the platform does not run): by the labels they select, else by
 * name, where per-connection policies are `<source>-<destination>-<direction>` or `<relationship>-<direction>`.
 */
export function policiesNaming(p: Platform, id: string): Policy[] {
  const named = (name: string) => {
    const base = name.replace(/-(ingress|egress)$/, '');
    // Whole hyphen-separated words only, so `stream` does not match `stream-app-…` when `stream-app` is a node.
    const others = new Set(p.workloads.map(w => w.node).filter((n): n is string => !!n && n !== id && n.includes(id)));
    if (base === id) return true;
    const at = (s: string) => s === base || base.startsWith(`${s}-`) || base.endsWith(`-${s}`);
    return at(id) && ![...others].some(o => at(o));
  };
  return p.policies.filter(x => x.node === id || x.peerNodes.includes(id) || named(x.name));
}

const recordOf = (e: HistoryEntry): HubRecord => ({
  status: e.status,
  ...(e.version ? { version: e.version } : {}),
  ...(e.startTime ? { startTime: e.startTime } : {}),
  ...(e.endTime ? { endTime: e.endTime } : {}),
  ...(e.appliesTo ? { appliesTo: e.appliesTo } : {}),
});

/** CALM Hub's deployment records in `history` (not refusals, not jobs only in memory), newest first. */
export const hubRecords = (history: HistoryEntry[]) =>
  history.filter(h => h.id !== undefined && h.evaluationId === undefined).map(recordOf);

/**
 * True when container image `ref` is the one the overlay sets: still the placeholder (`calm-service`), or the image
 * kustomize puts in its place (`newName`, with whatever tag).
 */
export function usesOverlayImage(ref: string, image: OverlayImage): boolean {
  const repository = imageRepository(ref);
  return repository === image.name || repository === imageRepository(image.newName);
}

/** Why the platform does not match Git and CALM Hub; empty when in sync. */
export function driftOf(p: Omit<Platform, 'drift'>): DriftReason[] {
  const reasons: DriftReason[] = [];
  if (p.flux.ready === false) reasons.push({ text: `Flux is not ready: ${p.flux.message ?? 'no message'}` });
  if (p.flux.atMain === false) {
    reasons.push({
      text: `Flux has not applied main: it applied ${p.flux.commit ? p.flux.commit.slice(0, 12) : 'nothing'}, main is at ${p.flux.mainCommit!.slice(0, 12)}`,
    });
  }
  for (const w of p.workloads) {
    if (w.desired !== undefined && w.replicas !== w.desired) {
      reasons.push({ workload: w.name, text: `${w.name} runs ${w.replicas} replica${w.replicas === 1 ? '' : 's'}; Git asks for ${w.desired}` });
    }
    if (w.ready < w.replicas) reasons.push({ workload: w.name, text: `${w.name}: ${w.ready} of ${w.replicas} ready` });
    const image = p.image;
    const other = image ? w.images.filter(i => usesOverlayImage(i, image) && i !== image.image) : [];
    if (image && other.length) {
      reasons.push({ workload: w.name, text: `${w.name} runs image ${[...new Set(other)].join(', ')}; Git asks for ${image.image}` });
    }
  }
  for (const m of p.missing) reasons.push({ workload: m, text: `${m} is in Git but does not run in the cluster` });
  if (p.completed?.version && p.version && p.completed.version !== p.version) {
    reasons.push({ text: `CALM Hub's newest record says ${p.completed.version}; the platform runs ${p.version}` });
  }
  return reasons;
}

/** In sync: nothing deploying, nothing unknown, no drift. */
export const inSync = (p: Platform) => !p.deploying && !p.problems.length && !p.drift.length;

async function kubectlJson(deps: ReadDeps, ns: string, kind: string): Promise<any> {
  const text = await deps.kubectl(['-n', ns, 'get', kind, '-o', 'json'], true, KUBECTL_TIMEOUT_MS);
  return text.trim() ? JSON.parse(text) : { items: [] };
}

/**
 * Reads what runs for `<namespace>/<architecture>` with its status and history, every read at once to stay within
 * CALM Hub's 10 s: Gitea (`main`, the overlay's image), CALM Hub (versions and records), Flux, Deployments and
 * NetworkPolicies. A read that fails becomes a problem, never drift; so does a CALM Hub or Gitea read that times out
 * (`ReadTimeout`). Pass `service` when the caller already read it.
 */
export async function readPlatform(
  deps: PlatformDeps,
  namespace: string,
  architecture: string,
  opts: { service?: ServiceInfo | null } = {},
): Promise<PlatformView> {
  const problems: string[] = [];
  /** A CALM Hub or Gitea read that timed out is a problem, and the view goes on with `fallback`. */
  const timedOut =
    <T>(what: string, fallback: T) =>
    (e: unknown): T => {
      if (!(e instanceof ReadTimeout)) throw e;
      deps.logger.warn(`Could not read ${what} of ${architecture}: ${e.message}`);
      problems.push(`Cannot read ${what}: ${e.message}`);
      return fallback;
    };
  let serviceUnread = false;
  const [service, versions] = await Promise.all([
    opts.service === undefined
      ? readService(deps.gitea, deps.settings, architecture).catch(e => {
          const none = timedOut('the service repository', undefined)(e);
          serviceUnread = true;
          return none;
        })
      : Promise.resolve(opts.service ?? undefined),
    deps.hub.architectureVersions(namespace, architecture).catch(timedOut('the versions in CALM Hub', [] as string[])),
  ]);
  const unrecorded = deps.jobs.unrecorded(architecture);
  const historyRead = readHistory(deps.hub, namespace, architecture, versions, unrecorded, service?.deployedVersion).catch(
    timedOut("CALM Hub's deployment records", unrecorded),
  );
  const managed = service?.architecture === architecture && service?.architectureNamespace === namespace;
  const attempt = <T>(what: string, read: () => Promise<T>): Promise<T | undefined> =>
    managed
      ? read().catch(e => {
          deps.logger.warn(`Could not read ${what} of ${architecture}: ${oneLine(e)}`);
          problems.push(`Cannot read ${what}: ${oneLine(e)}`);
          return undefined;
        })
      : Promise.resolve(undefined);
  const [status, history, deployJson, policyJson, mainCommit, image] = await Promise.all([
    readStatus(deps, namespace, architecture, { service: service ?? null, versions, history: historyRead }),
    historyRead,
    attempt('the workloads', () => kubectlJson(deps, service!.kubernetesNamespace, 'deploy')),
    attempt('the network policies', () => kubectlJson(deps, service!.kubernetesNamespace, 'networkpolicy')),
    attempt('main', () => deps.gitea.branchHead(service!.owner, service!.name, deps.settings.gitops.branch)),
    attempt('the image Git asks for', async () =>
      parseOverlayImage(await deps.gitea.rawFile(service!.owner, service!.name, deps.settings.gitops.branch, OVERLAY_FILE)),
    ),
  ]);
  if (!managed || !service) {
    // Whether the service is managed is unknown: say why rather than "no repository".
    const shown = serviceUnread ? { ...status, reason: problems[0] } : status;
    return { status: shown, history, ...(service ? { service } : {}), ...(problems.length ? { problems } : {}) };
  }

  if (status.ready === undefined && status.message) problems.push(status.message);
  const workloads = deployJson ? parseWorkloads(deployJson, service.deployments) : [];
  const missing = deployJson ? service.deployments.filter(g => !workloads.some(w => w.name === g.name)).map(g => g.name) : [];
  const records = hubRecords(history);
  const job = deps.jobs.current(architecture);
  const deploying = job
    ? (status.running && status.running.version === job.version ? status.running : { version: job.version, status: job.status, notes: job.notes })
    : undefined;
  const base: Omit<Platform, 'drift'> = {
    environment: deps.settings.environment,
    ...(service.deployedVersion ? { version: service.deployedVersion } : {}),
    flux: {
      ...(status.ready !== undefined ? { ready: status.ready } : {}),
      ...(status.message ? { message: status.message } : {}),
      ...(status.commit ? { commit: status.commit } : {}),
      ...(mainCommit ? { mainCommit } : {}),
      ...(mainCommit && status.ready !== undefined ? { atMain: status.commit === mainCommit } : {}),
    },
    workloads,
    missing,
    ...(image ? { image } : {}),
    policies: policyJson ? parsePolicies(policyJson) : [],
    ...(records[0] ? { record: records[0] } : {}),
    ...(records.find(r => r.status === 'completed') ? { completed: records.find(r => r.status === 'completed') } : {}),
    ...(deploying ? { deploying } : {}),
    ...(job?.pendingApproval ? { pendingApproval: job.pendingApproval } : {}),
    problems,
  };
  return { status, history, service, platform: { ...base, drift: deploying ? [] : driftOf(base) } };
}

/** The platform facts the `status` command adds to the status. */
export function platformFacts(p: Platform) {
  return {
    inSync: inSync(p),
    drift: p.drift.map(d => d.text),
    ...(p.deploying ? { deploying: p.deploying } : {}),
    ...(p.problems.length ? { problems: p.problems } : {}),
    ...(p.flux.mainCommit ? { mainCommit: p.flux.mainCommit } : {}),
    ...(p.flux.atMain !== undefined ? { fluxAtMain: p.flux.atMain } : {}),
    workloads: p.workloads,
    ...(p.record ? { hubRecord: p.record } : {}),
    ...(p.pendingApproval ? { pendingApproval: p.pendingApproval.url } : {}),
  };
}
