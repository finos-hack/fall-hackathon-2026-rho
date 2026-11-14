/*
 * The Flux objects that deploy one service from its Git repository, and how to read their status. Flux runs in the
 * local cluster (source- and kustomize-controller, installed by `yarn k8s:up`).
 */

export const FLUX_NAMESPACE = 'flux-system';
/** The folder of a service's repository that Flux applies. */
export const GITOPS_PATH = './deploy/k8s-overlay';
/** Annotation that asks a Flux controller to reconcile now (any new value). */
export const FLUX_RECONCILE_ANNOTATION = 'reconcile.fluxcd.io/requestedAt';

/** Name of a service's GitRepository and Kustomization: `calm-<name>`. */
export const fluxObjectName = (service: string) => `calm-${service}`;

/** The `calm.finos.org/gitops` annotation value: `<namespace>/<name>` of the service's Kustomization. */
export const gitopsAnnotationValue = (service: string) =>
  `${FLUX_NAMESPACE}/${fluxObjectName(service)}`;

/** A `GitRepository` and a `Kustomization` that apply `path` of `repoUrl` at `branch`, pruning what is removed. */
export function fluxObjects(o: {
  name: string;
  repoUrl: string;
  branch: string;
  path?: string;
}): object[] {
  const name = fluxObjectName(o.name);
  const labels = { 'calm.finos.org/service': o.name };
  return [
    {
      apiVersion: 'source.toolkit.fluxcd.io/v1',
      kind: 'GitRepository',
      metadata: { name, namespace: FLUX_NAMESPACE, labels },
      spec: { interval: '1m', url: o.repoUrl, ref: { branch: o.branch } },
    },
    {
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
      kind: 'Kustomization',
      metadata: { name, namespace: FLUX_NAMESPACE, labels },
      spec: {
        interval: '1m',
        path: o.path ?? GITOPS_PATH,
        prune: true,
        wait: false,
        timeout: '3m',
        sourceRef: { kind: 'GitRepository', name },
      },
    },
  ];
}

export interface FluxStatus {
  ready: boolean;
  /** The Ready condition's message (why it is not ready, or what was applied). */
  message: string;
  /** `status.lastAppliedRevision`, e.g. `main@sha1:<sha>`. */
  appliedRevision?: string;
  /** `status.lastAttemptedRevision`. */
  attemptedRevision?: string;
}

/** The Ready condition and revisions of a Flux object (`kubectl get -o json`). */
export function readFluxStatus(obj: any): FluxStatus {
  const ready = (obj?.status?.conditions ?? []).find(
    (c: any) => c?.type === 'Ready',
  );
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const appliedRevision = s(obj?.status?.lastAppliedRevision);
  const attemptedRevision = s(obj?.status?.lastAttemptedRevision);
  return {
    ready: ready?.status === 'True',
    message: s(ready?.message) ?? 'no Ready condition yet',
    ...(appliedRevision ? { appliedRevision } : {}),
    ...(attemptedRevision ? { attemptedRevision } : {}),
  };
}

/** The commit SHA in a Flux revision (`main@sha1:<sha>`, or a bare SHA). */
export function revisionCommit(
  revision: string | undefined,
): string | undefined {
  const m = /(?:^|:)([0-9a-f]{40})$/.exec(revision ?? '');
  return m?.[1];
}

/** True when a Flux revision names the commit `sha`. */
export function revisionHasCommit(
  revision: string | undefined,
  sha: string,
): boolean {
  return Boolean(sha) && revisionCommit(revision) === sha;
}
