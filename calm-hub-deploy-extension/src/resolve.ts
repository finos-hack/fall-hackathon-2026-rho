import YAML from 'yaml';
import { CALM_ANNOTATIONS as ANN, CalmHubError, deployNamespace } from '@internal/backstage-plugin-calm-common';
import type { Settings } from './config';
import { HttpError } from './errors';
import type { Gitea } from './gitea';
import type { HubClient } from './hub';
import { BASE_DIR, nodesInManifests } from './deploy/kube';

export const CATALOG_INFO_FILE = 'catalog-info.yaml';

/** An architecture in CALM Hub: its name in the name-based API and the numeric id the Hub UI targets. */
export interface ArchitectureRef {
  namespace: string;
  name: string;
  numericId?: number;
}

/**
 * Resolves the designer-tab context to an architecture. CALM Hub's UI sends `resourceType` `architectures` and the
 * architecture's name as `resourceId` (it browses by name); a numeric id is accepted too, as the Hub's own APIs use it.
 */
export async function resolveArchitecture(
  hub: HubClient,
  namespace: string,
  resourceType: string,
  resourceId: string,
): Promise<ArchitectureRef> {
  if (resourceType !== 'architectures' && resourceType !== 'architecture') {
    throw new HttpError(400, `Only architectures can be deployed, not ${resourceType}`);
  }
  return findArchitecture(hub, namespace, resourceId);
}

/** Finds an architecture by name or numeric id; 404 when the namespace has none such. */
export async function findArchitecture(hub: HubClient, namespace: string, idOrName: string): Promise<ArchitectureRef> {
  let list;
  try {
    list = await hub.architectures(namespace);
  } catch (e) {
    if (e instanceof CalmHubError && e.status === 404) throw new HttpError(404, `No namespace ${namespace} in CALM Hub`);
    throw e;
  }
  const numeric = /^\d+$/.test(idOrName) ? Number(idOrName) : undefined;
  const found = list.find(a => (numeric !== undefined ? a.numericId === numeric : a.customId === idOrName));
  if (!found) throw new HttpError(404, `No architecture ${idOrName} in namespace ${namespace}`);
  return { namespace, name: found.customId, ...(found.numericId !== undefined ? { numericId: found.numericId } : {}) };
}

/** A service deployed through Git and Flux, as its repository's `main` describes it. */
export interface ServiceInfo {
  name: string;
  owner: string;
  webUrl: string;
  annotations: Record<string, string>;
  /** Hub namespace and name of the architecture the service says it runs. */
  architectureNamespace?: string;
  architecture?: string;
  /** The architecture version deployed now (what `main` says). */
  deployedVersion?: string;
  deployBundle?: { name: string; version: string };
  /** Kubernetes namespace the service runs in. */
  kubernetesNamespace: string;
  /** The architecture nodes the rendered workloads run (their calm.finos.org/node labels). */
  nodes: string[];
}

/**
 * Reads a service's `catalog-info.yaml` and rendered manifests from `main` in Gitea. Undefined when there is no
 * repository `calm-services/<name>` or it was not made by a starter with deployment rules (nothing to deploy).
 */
export async function readService(gitea: Gitea, settings: Settings, name: string): Promise<ServiceInfo | undefined> {
  const owner = settings.gitops.servicesOrg;
  const ref = settings.gitops.branch;
  const catalogInfo = await gitea.rawFile(owner, name, ref, CATALOG_INFO_FILE);
  if (catalogInfo === undefined) return undefined;
  const entity = YAML.parseAllDocuments(catalogInfo)
    .map(d => d.toJS())
    .find((e: any) => e?.kind === 'Component');
  const annotations: Record<string, string> = entity?.metadata?.annotations ?? {};
  if (!annotations[ANN.gitops]) return undefined;
  const files = (await gitea.listFiles(owner, name, ref, BASE_DIR)).filter(f => /\.ya?ml$/.test(f));
  const texts = await Promise.all(files.map(f => gitea.rawFile(owner, name, ref, `${BASE_DIR}/${f}`)));
  const deployBundle =
    annotations[ANN.deployBundle] && annotations[ANN.deployBundleVersion]
      ? { name: annotations[ANN.deployBundle], version: annotations[ANN.deployBundleVersion] }
      : undefined;
  return {
    name,
    owner,
    webUrl: gitea.repoWebUrl(owner, name),
    annotations,
    architectureNamespace: annotations[ANN.architectureNamespace] ?? annotations[ANN.namespace],
    architecture: annotations[ANN.architecture],
    deployedVersion: annotations[ANN.architectureVersion],
    ...(deployBundle ? { deployBundle } : {}),
    kubernetesNamespace:
      annotations['backstage.io/kubernetes-namespace'] ?? deployNamespace(settings.kubernetes.namespacePrefix, name),
    nodes: nodesInManifests(texts.filter((t): t is string => t !== undefined)),
  };
}

/**
 * Why `service` must not be deployed as `<namespace>/<name>`, or undefined when it may. CALM Hub vouches only for the
 * caller's write scope on the path namespace, so the repository must say it runs exactly that architecture: otherwise
 * a same-named architecture in another namespace could deploy into someone else's service.
 */
export function bindingProblem(service: ServiceInfo, namespace: string, name: string): string | undefined {
  if (service.architecture !== name || service.architectureNamespace !== namespace) {
    return `The repository ${service.owner}/${service.name} runs the architecture ${service.architectureNamespace ?? '?'}/${
      service.architecture ?? '?'
    }, not ${namespace}/${name}`;
  }
  if (!service.deployBundle) {
    return `${service.owner}/${service.name} has no deployment rules (${ANN.deployBundle}): it was made with a full bundle; create it again with a starter`;
  }
  return undefined;
}
