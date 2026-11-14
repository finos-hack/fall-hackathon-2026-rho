/*
 * The Flux status of a service deployed through Git: its Kustomization's Ready condition and the commit Flux applied.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import {
  CALM_ANNOTATIONS as ANN,
  FLUX_NAMESPACE,
  fluxObjectName,
  isDnsLabel,
  readFluxStatus,
  revisionCommit,
} from '@internal/backstage-plugin-calm-common';
import {
  KubernetesDeploySettings,
  requireKubernetesDeploy,
  runKubectl,
} from '@internal/backstage-plugin-calm-node';

const READ_TIMEOUT_MS = 5000;

export interface GitopsInfo {
  /** `<namespace>/<name>` of the Kustomization. */
  kustomization: string;
  ready: boolean;
  message: string;
  /** The commit Flux last applied. */
  commit?: string;
  repoUrl?: string;
  commitUrl?: string;
}

/**
 * The Kustomization named by an entity's `calm.finos.org/gitops` annotation, when it is one this plugin made
 * (`flux-system/calm-<dns label>`); undefined otherwise.
 */
export function kustomizationOf(
  entity: Entity,
): { namespace: string; name: string } | undefined {
  const value = entity.metadata.annotations?.[ANN.gitops];
  const m = /^([^/]+)\/(.+)$/.exec(value ?? '');
  if (!m || m[1] !== FLUX_NAMESPACE) {
    return undefined;
  }
  const service = m[2].replace(/^calm-/, '');
  return isDnsLabel(service) && m[2] === fluxObjectName(service)
    ? { namespace: m[1], name: m[2] }
    : undefined;
}

/** Builds the GitOps info from a Kustomization object and the entity's repository link. */
export function gitopsInfo(
  ks: { namespace: string; name: string },
  obj: any,
  repoUrl: string | undefined,
): GitopsInfo {
  const status = readFluxStatus(obj);
  const commit = revisionCommit(status.appliedRevision);
  const repo = repoUrl && /^https?:\/\//.test(repoUrl) ? repoUrl.replace(/\/+$/, '') : undefined;
  return {
    kustomization: `${ks.namespace}/${ks.name}`,
    ready: status.ready,
    message: status.message,
    ...(commit ? { commit } : {}),
    ...(repo ? { repoUrl: repo } : {}),
    ...(repo && commit ? { commitUrl: `${repo}/commit/${commit}` } : {}),
  };
}

/** The Flux status of an entity deployed through Git, or undefined (no annotation, no cluster, not found). */
export async function readGitops(
  entity: Entity,
  settings: KubernetesDeploySettings | undefined,
  logger: LoggerService,
): Promise<GitopsInfo | undefined> {
  const ks = kustomizationOf(entity);
  if (!ks || !settings) {
    return undefined;
  }
  try {
    await requireKubernetesDeploy(settings);
    const { stdout } = await runKubectl(
      settings,
      ['-n', ks.namespace, 'get', 'kustomization', ks.name, '--ignore-not-found', '-o', 'json'],
      {
        cwd: process.cwd(),
        logger,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        quietStdout: true,
      },
    );
    if (!stdout.trim()) {
      return undefined;
    }
    return gitopsInfo(ks, JSON.parse(stdout), entity.metadata.annotations?.[ANN.gitRepo]);
  } catch (e) {
    logger.warn(
      `The Flux status of ${entity.metadata.name} was not read: ${(e as Error).message ?? e}`,
    );
    return undefined;
  }
}
