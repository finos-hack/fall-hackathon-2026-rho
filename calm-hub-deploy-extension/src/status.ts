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
const KUBECTL_TIMEOUT_MS = 5_000;

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
 * holds no record of yet, from memory).
 */
export async function readHistory(
  hub: HubClient,
  namespace: string,
  architecture: string,
  versions: string[],
  unrecorded: HistoryEntry[] = [],
): Promise<HistoryEntry[]> {
  const ids = new Map<number, { version: string; type: string }>();
  for (const v of versions) {
    for (const type of ['deployment', 'control-evaluation']) {
      const list = await hub.listDecorators(namespace, { target: architectureVersionPath(namespace, architecture, v), type });
      for (const id of list) if (!ids.has(id)) ids.set(id, { version: v, type });
    }
  }
  const newest = [...ids.entries()].sort((a, b) => b[0] - a[0]).slice(0, HISTORY_LIMIT);
  const read = await Promise.all(
    newest.map(async ([id, { version, type }]) => {
      const d = { ...(await hub.getDecorator(namespace, id)), id };
      if (type === 'deployment') return historyEntry(d, version);
      return isOwnEvaluation(d) ? evaluationEntry(d, version) : undefined;
    }),
  );
  return newestFirst([...unrecorded, ...read.filter((e): e is HistoryEntry => e !== undefined)]).slice(0, HISTORY_LIMIT);
}

/** The status of `<namespace>/<architecture>`; `service` is passed when the caller already read it. */
export async function readStatus(
  deps: ReadDeps,
  namespace: string,
  architecture: string,
  opts: { service?: ServiceInfo | null; history?: HistoryEntry[] } = {},
): Promise<Status> {
  const versions = (await deps.hub.architectureVersions(namespace, architecture)).sort(compareVersions);
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
  const history = opts.history ?? (await readHistory(deps.hub, namespace, architecture, versions));
  const running = history.find(h => RUNNING.has(h.status));
  if (running) {
    status.running = {
      status: running.status,
      ...(running.version ? { version: running.version } : {}),
      ...(running.notes ? { notes: running.notes } : {}),
    };
  }
  return status;
}
