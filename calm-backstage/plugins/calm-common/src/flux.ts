/*
 * The Flux objects that deploy one service from its Git repository, and how to read their status. Flux runs in the
 * local cluster (source- and kustomize-controller, installed by `yarn k8s:up`).
 */

import { CALM_KUBERNETES, namespaceManifest } from './deploy';

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

/**
 * A `GitRepository` and a `Kustomization` that apply `path` of `repoUrl` at `branch` into `namespace`, pruning what is
 * removed. The Kustomization applies as the service account `calm-<name>` that `fluxTenantObjects` creates, not as
 * the kustomize-controller's own cluster-admin account.
 */
export function fluxObjects(o: {
  name: string;
  namespace: string;
  repoUrl: string;
  branch: string;
  path?: string;
}): object[] {
  const name = fluxObjectName(o.name);
  const labels = { [CALM_KUBERNETES.serviceLabel]: o.name };
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
        serviceAccountName: name,
        targetNamespace: o.namespace,
      },
    },
  ];
}

/** Flux annotation that keeps an object when it leaves a pruned Kustomization's inventory. */
const FLUX_PRUNE_ANNOTATION = 'kustomize.toolkit.fluxcd.io/prune';

/**
 * Pod Security admission at `baseline` for a service's namespace: `admin` there cannot run privileged pods or pods
 * that use the host's namespaces, paths or ports. The bundles' workloads need none of that.
 */
const POD_SECURITY_LABELS = {
  'pod-security.kubernetes.io/enforce': 'baseline',
  'pod-security.kubernetes.io/warn': 'baseline',
};

/**
 * What a service's Kustomization needs before Flux can apply it, in apply order: the service's Namespace, the
 * service account `calm-<name>` in `flux-system` (Flux impersonates an account in the Kustomization's own namespace),
 * a RoleBinding of the built-in ClusterRole `admin` to it in the service's namespace, and the ClusterRole and
 * ClusterRoleBinding `calm-<name>-namespace` described below. `admin` covers namespaced objects only, so a push to
 * the service's repository cannot touch other namespaces or cluster-scoped objects.
 *
 * The service account cannot create a Namespace, so the Namespace is applied here and not from Git, with Pod
 * Security `baseline` enforced. It is marked prune-disabled: a service deployed before this change has it in its
 * Kustomization's inventory, and the push that drops it from the overlay would otherwise make Flux delete the
 * namespace and everything in it.
 *
 * Flux prunes that stale inventory entry as the service account too: it reads the Namespace, finds the annotation
 * and keeps it, without writing to it. A RoleBinding cannot grant access to a cluster-scoped object, so a ClusterRole
 * `calm-<name>-namespace` allows `get` on this one Namespace (by name) and a ClusterRoleBinding of the same name
 * grants it to the service account.
 */
export function fluxTenantObjects(o: {
  name: string;
  namespace: string;
}): object[] {
  const name = fluxObjectName(o.name);
  const namespaceRole = `${name}-namespace`;
  const labels = { [CALM_KUBERNETES.serviceLabel]: o.name };
  const ns = namespaceManifest(o.name, o.namespace);
  return [
    {
      ...ns,
      metadata: {
        ...ns.metadata,
        labels: {
          ...(ns.metadata.labels as Record<string, string>),
          ...POD_SECURITY_LABELS,
        },
        annotations: { [FLUX_PRUNE_ANNOTATION]: 'disabled' },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name, namespace: FLUX_NAMESPACE, labels },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name, namespace: o.namespace, labels },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'admin',
      },
      subjects: [{ kind: 'ServiceAccount', name, namespace: FLUX_NAMESPACE }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: namespaceRole, labels },
      rules: [
        {
          apiGroups: [''],
          resources: ['namespaces'],
          resourceNames: [o.namespace],
          verbs: ['get'],
        },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: namespaceRole, labels },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: namespaceRole,
      },
      subjects: [{ kind: 'ServiceAccount', name, namespace: FLUX_NAMESPACE }],
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
