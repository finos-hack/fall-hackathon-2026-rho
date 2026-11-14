/*
 * What a published service has running in the local cluster: read with `kubectl get` from the namespace and label
 * its catalog-info.yaml names, for the architecture card.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import {
  CALM_KUBERNETES,
  KUBERNETES_ANNOTATIONS as K8S,
  KUBERNETES_ID_LABEL,
  isDnsLabel,
} from '@internal/backstage-plugin-calm-common';
import {
  KubernetesDeploySettings,
  requireKubernetesDeploy,
  runKubectl,
} from '@internal/backstage-plugin-calm-node';

/** The `deployment` part of `GET /architecture`. */
export interface DeploymentInfo {
  /** The kubectl context the objects were read from. */
  cluster: string;
  namespace: string;
  /** NetworkPolicies of the service; `relationship` and `protocol` on those rendered from a `connects` relationship. */
  networkPolicies: { name: string; relationship?: string; protocol?: string }[];
  /** Deployments; `ready` when every replica is. */
  workloads: { name: string; ready: boolean }[];
}

const READ_TIMEOUT_MS = 5000;

/** Maps the Deployments and NetworkPolicies of a `kubectl get -o json` list. */
export function deploymentFromObjects(
  cluster: string,
  namespace: string,
  items: any[],
): DeploymentInfo {
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  return {
    cluster,
    namespace,
    networkPolicies: items
      .filter(i => i?.kind === 'NetworkPolicy')
      .map(i => {
        const a = i.metadata?.annotations ?? {};
        const relationship = a[CALM_KUBERNETES.relationshipAnnotation];
        const protocol = a[CALM_KUBERNETES.protocolAnnotation];
        return {
          name: String(i.metadata?.name),
          ...(relationship ? { relationship: String(relationship) } : {}),
          ...(protocol ? { protocol: String(protocol) } : {}),
        };
      })
      .sort(byName),
    workloads: items
      .filter(i => i?.kind === 'Deployment')
      .map(i => ({
        name: String(i.metadata?.name),
        ready: (i.status?.readyReplicas ?? 0) >= (i.spec?.replicas ?? 1),
      }))
      .sort(byName),
  };
}

/**
 * The deployment of an entity with the Kubernetes annotations, or undefined: when `calm.deploy.kubernetes` is not
 * configured, the cluster does not answer within a few seconds, or nothing with the entity's label is in the
 * namespace. The annotations are data: only a namespace with the configured prefix is read.
 */
export async function readDeployment(
  entity: Entity,
  settings: KubernetesDeploySettings | undefined,
  logger: LoggerService,
): Promise<DeploymentInfo | undefined> {
  const a = entity.metadata.annotations ?? {};
  const id = a[K8S.id];
  const namespace = a[K8S.namespace];
  if (!settings || !id || !namespace) {
    return undefined;
  }
  if (
    !isDnsLabel(id) ||
    !isDnsLabel(namespace) ||
    !settings.namespacePrefix ||
    !namespace.startsWith(settings.namespacePrefix)
  ) {
    logger.warn(
      `Not reading the deployment of ${entity.metadata.name}: namespace ${namespace} is not under ${settings.namespacePrefix}`,
    );
    return undefined;
  }
  try {
    await requireKubernetesDeploy(settings);
    const { stdout } = await runKubectl(
      settings,
      [
        '-n',
        namespace,
        'get',
        'deployments,networkpolicies',
        '-l',
        `${KUBERNETES_ID_LABEL}=${id}`,
        '-o',
        'json',
      ],
      {
        cwd: process.cwd(),
        logger,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        quietStdout: true,
      },
    );
    const items = JSON.parse(stdout).items ?? [];
    return items.length
      ? deploymentFromObjects(settings.context, namespace, items)
      : undefined;
  } catch (e) {
    logger.warn(
      `The deployment of ${entity.metadata.name} in ${
        settings.context
      } / ${namespace} was not read: ${(e as Error).message ?? e}`,
    );
    return undefined;
  }
}
