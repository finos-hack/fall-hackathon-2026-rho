import {
  architectureVersionPath,
  compareVersions,
  readFluxStatus,
  revisionCommit,
  type DeploymentStatus,
} from '@internal/backstage-plugin-calm-common';
import type { Settings } from './config';
import type { Gitea } from './gitea';
import type { HubClient } from './hub';
import type { Logger } from './logger';
import { evaluationEntry, isOwnEvaluation } from './evaluation';
import { historyEntry, newestFirst, type HistoryEntry } from './record';
import { readService, type ServiceInfo } from './resolve';
import { oneLine, readKustomization, type Kubectl } from './deploy/kube';

const HISTORY_LIMIT = 20;
/** Statuses of an attempt that has not finished: `validating` is a job at the controls gate (from memory). */
const RUNNING = new Set(['validating', 'pending', 'in-progress']);
/** Each kubectl read on the read side gives up after this, to stay within CALM Hub's 10 s for a proxied call. */
export const KUBECTL_TIMEOUT_MS = 5_000;
const RECORD_TYPES = ['deployment', 'control-evaluation'];
const MAX_HISTORY_PAGES = 5;

export interface ReadDeps {
  settings: Settings;
  hub: HubClient;
  gitea: Gitea;
  kubectl: Kubectl;
  logger: Logger;
}

/** Where an architecture's service runs: the `status` command's output (the profile's status). */
export interface Status {
  namespace: string;
  architecture: string;
  /** The service is deployed through this extension's Git repository and Flux. */
  managed: boolean;
  /** Why it is not managed, when it is not. */
  reason?: string;
  repository?: string;
  deploymentRules?: string;
  environment: string;
  deployedVersion?: string;
  latestVersion?: string;
  versions: string[];
  ready?: boolean;
  message?: string;
  commit?: string;
  commitUrl?: string;
  /** A deployment of this architecture that has not finished. */
  running?: { version?: string; status: DeploymentStatus | string; notes?: string };
}

/**
 * The deployment attempts on every version of an architecture, newest first (at most 20): its deployment decorators,
 * this connector's refusals at the controls gate (control-evaluation decorators), and `unrecorded` (jobs CALM Hub
 * holds no record of yet, from memory). Entries read from deployment decorators carry `appliesTo`; the history route
 * leaves it out.
 */
export async function readHistory(
  hub: HubClient,
  namespace: string,
  architecture: string,
  versions: string[],
  unrecorded: HistoryEntry[] = [],
): Promise<HistoryEntry[]> {
  // CALM Hub gives each proxied call 10 s: list every version's decorators at once.
  const pairs = versions.flatMap(version => RECORD_TYPES.map(type => ({ version, type })));
  const lists = await Promise.all(
    pairs.map(p => hub.listDecorators(namespace, { target: architectureVersionPath(namespace, architecture, p.version), type: p.type })),
  );
  const ids = new Map<number, { version: string; type: string }>();
  lists.forEach((list, i) => {
    for (const id of list) if (!ids.has(id)) ids.set(id, pairs[i]);
  });
  const newest = [...ids.entries()].sort((a, b) => b[0] - a[0]);
  // Other connectors' evaluations are dropped only once read: read newest first, a page at a time, until 20 are kept
  // (at most 5 pages, so many foreign evaluations cannot eat CALM Hub's 10 s).
  const kept: HistoryEntry[] = [];
  const end = Math.min(newest.length, HISTORY_LIMIT * MAX_HISTORY_PAGES);
  for (let i = 0; i < end && kept.length < HISTORY_LIMIT; i += HISTORY_LIMIT) {
    const read = await Promise.all(
      newest.slice(i, i + HISTORY_LIMIT).map(async ([id, { version, type }]) => {
        const d = { ...(await hub.getDecorator(namespace, id)), id };
        if (type === 'deployment') return { ...historyEntry(d, version), ...(d.appliesTo?.length ? { appliesTo: d.appliesTo } : {}) };
        return isOwnEvaluation(d) ? evaluationEntry(d, version) : undefined;
      }),
    );
    kept.push(...read.filter((e): e is HistoryEntry => e !== undefined));
  }
  return newestFirst([...unrecorded, ...kept.slice(0, HISTORY_LIMIT)]).slice(0, HISTORY_LIMIT);
}

/** A history entry as the history route gives it (without the nodes a deployment applies to). */
export const publicEntry = ({ appliesTo: _appliesTo, ...e }: HistoryEntry): HistoryEntry => e;

/** The first attempt in `history` that has not finished. */
export function runningOf(history: HistoryEntry[]): Status['running'] {
  const running = history.find(h => RUNNING.has(h.status));
  if (!running) return undefined;
  return {
    status: running.status,
    ...(running.version ? { version: running.version } : {}),
    ...(running.notes ? { notes: running.notes } : {}),
  };
}

/**
 * The status of `<namespace>/<architecture>`. Pass what the caller already read: `service`, `versions`, and `history`
 * (a promise is awaited last, so it can be read while Flux is).
 */
export async function readStatus(
  deps: ReadDeps,
  namespace: string,
  architecture: string,
  opts: { service?: ServiceInfo | null; versions?: string[]; history?: HistoryEntry[] | Promise<HistoryEntry[]> } = {},
): Promise<Status> {
  // Read while Flux is; never left unhandled when the status returns before awaiting it.
  const historyRead = opts.history === undefined ? undefined : Promise.resolve(opts.history);
  historyRead?.catch(() => undefined);
  const versions = [...(opts.versions ?? (await deps.hub.architectureVersions(namespace, architecture)))].sort(compareVersions);
  const base: Status = {
    namespace,
    architecture,
    managed: false,
    environment: deps.settings.environment,
    versions,
    ...(versions.length ? { latestVersion: versions[versions.length - 1] } : {}),
  };
  const service =
    opts.service === undefined ? await readService(deps.gitea, deps.settings, architecture) : opts.service ?? undefined;
  if (!service) {
    return { ...base, reason: `No GitOps service repository ${deps.settings.gitops.servicesOrg}/${architecture}` };
  }
  if (service.architecture !== architecture || service.architectureNamespace !== namespace) {
    return {
      ...base,
      repository: service.webUrl,
      reason: `${service.owner}/${service.name} runs ${service.architectureNamespace}/${service.architecture}, not this architecture`,
    };
  }
  const status: Status = {
    ...base,
    managed: true,
    repository: service.webUrl,
    ...(service.deployBundle ? { deploymentRules: `${service.deployBundle.name}@${service.deployBundle.version}` } : {}),
    ...(service.deployedVersion ? { deployedVersion: service.deployedVersion } : {}),
  };
  try {
    const ks = await readKustomization(deps.kubectl, architecture, KUBECTL_TIMEOUT_MS);
    if (ks) {
      const flux = readFluxStatus(ks);
      const commit = revisionCommit(ks?.status?.lastAppliedRevision);
      Object.assign(status, {
        ready: flux.ready,
        message: flux.message,
        ...(commit ? { commit, commitUrl: deps.gitea.commitWebUrl(service.owner, service.name, commit) } : {}),
      });
    } else {
      Object.assign(status, { ready: false, message: 'Flux has no Kustomization for this service' });
    }
  } catch (e) {
    deps.logger.warn(`Could not read Flux status of ${architecture}: ${oneLine(e)}`);
    Object.assign(status, { message: `Flux status unavailable: ${oneLine(e)}` });
  }
  const history = (await historyRead) ?? (await readHistory(deps.hub, namespace, architecture, versions));
  const running = runningOf(history);
  if (running) status.running = running;
  return status;
}
