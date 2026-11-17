import {
  architectureVersionPath,
  architectureVersionUiTarget,
  type CalmHubDecorator,
  type DeploymentStatus,
} from '@internal/backstage-plugin-calm-common';

/**
 * The deployment decorator standard CALM Hub bundles and validates against: Kubernetes, with `data.kubernetes`
 * holding exactly the cluster and namespace. CALM Hub refuses (400) a decorator stamped with it that does not match.
 */
export const KUBERNETES_DEPLOYMENT_STANDARD =
  'https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json';

/** Names this connector in `data.gitops.connector`, so it can find its own records (e.g. to close those a restart cut off). */
export const CONNECTOR = 'platform-connector';

/** What records written before the rename carry in `data.deployed-by` (CALM Hub still holds some). */
export const LEGACY_CONNECTOR = 'gitops-deploy';

/**
 * One deployment as this connector tracks it. The decorator is rebuilt from it on every change (CALM Hub replaces the
 * whole document on PUT). What the deployment standard does not cover goes in `data.gitops`
 * (standards/gitops.decorator.standard.json); CALM Hub's Decorators tab shows it all.
 */
export interface DeploymentRecord {
  uniqueId: string;
  namespace: string;
  architecture: string;
  version: string;
  /** Numeric id of the architecture, for the target CALM Hub's own UI looks decorators up by. */
  numericId?: number;
  appliesTo: string[];
  status: DeploymentStatus;
  startTime: string;
  endTime?: string;
  notes: string;
  /** Where it runs: the kube context and the service's namespace (`data.kubernetes`, which allows nothing else). */
  kubernetes: { cluster: string; namespace: string };
  environment: string;
  /** Web URL of the service repository. */
  repository?: string;
  requestedBy: string;
  /** The `jti` of the call that asked for the deployment: its id in CALM Hub's audit log. */
  hubAuditId: string;
  pullRequest?: string;
  commit?: string;
  /** URI with the details: the commit Flux applied, else the pull request, else the repository. */
  details?: string;
}

/**
 * The `target` of a record on an architecture version: the version by name (Backstage, and this connector's own
 * lookups) and, when the numeric id is known, by id (CALM Hub's UI).
 */
export function versionTargets(namespace: string, architecture: string, version: string, numericId?: number): string[] {
  return [
    architectureVersionPath(namespace, architecture, version),
    ...(numericId !== undefined ? [architectureVersionUiTarget(namespace, numericId, version)] : []),
  ];
}

/**
 * The standard (Kubernetes) deployment decorator for a record: targets the architecture version by name (Backstage)
 * and by id (Hub UI); the GitOps details go in `data.gitops`.
 */
export function decoratorOf(r: DeploymentRecord): Record<string, unknown> {
  return {
    $schema: KUBERNETES_DEPLOYMENT_STANDARD,
    'unique-id': r.uniqueId,
    type: 'deployment',
    target: versionTargets(r.namespace, r.architecture, r.version, r.numericId),
    'target-type': ['architecture'],
    'applies-to': r.appliesTo,
    data: {
      'start-time': r.startTime,
      ...(r.endTime ? { 'end-time': r.endTime } : {}),
      status: r.status,
      ...(r.details ? { 'deployment-details': r.details } : {}),
      notes: r.notes,
      kubernetes: { cluster: r.kubernetes.cluster, namespace: r.kubernetes.namespace },
      gitops: {
        connector: CONNECTOR,
        environment: r.environment,
        ...(r.repository ? { repository: r.repository } : {}),
        ...(r.pullRequest ? { 'pull-request': r.pullRequest } : {}),
        ...(r.commit ? { commit: r.commit } : {}),
        'requested-by': r.requestedBy,
        'hub-audit-id': r.hubAuditId,
        'architecture-version': r.version,
      },
    },
  };
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The connector's fields of a deployment decorator's `data`. */
export interface GitopsFields {
  connector?: string;
  environment?: string;
  repository?: string;
  pullRequest?: string;
  commit?: string;
  requestedBy?: string;
  hubAuditId?: string;
  architectureVersion?: string;
}

/**
 * Reads the connector's fields from `data.gitops`, or from the top of `data` where records written before the
 * standard layout keep them (`deployed-by` for the connector).
 */
export function gitopsFields(data: Record<string, unknown>): GitopsFields {
  const g = isObject(data.gitops) ? data.gitops : {};
  const read = (key: string, legacyKey = key) => text(g[key]) ?? text(data[legacyKey]);
  const fields: GitopsFields = {
    connector: read('connector', 'deployed-by'),
    environment: read('environment'),
    repository: read('repository'),
    pullRequest: read('pull-request'),
    commit: read('commit'),
    requestedBy: read('requested-by'),
    hubAuditId: read('hub-audit-id'),
    architectureVersion: read('architecture-version'),
  };
  for (const k of Object.keys(fields) as (keyof GitopsFields)[]) if (fields[k] === undefined) delete fields[k];
  return fields;
}

/**
 * True for a deployment this connector recorded and has not finished (pending or in-progress): `data.gitops.connector`
 * is `platform-connector`, or, in the old layout, `data.deployed-by` is `gitops-deploy`.
 */
export function isOwnUnfinished(data: Record<string, unknown>): boolean {
  const own = isObject(data.gitops) ? data.gitops.connector === CONNECTOR : data['deployed-by'] === LEGACY_CONNECTOR;
  return own && (data.status === 'pending' || data.status === 'in-progress');
}

/**
 * A deployment attempt as the status and history routes give it: a deployment decorator, a refusal at the controls
 * gate (a control-evaluation decorator), or a job CALM Hub holds no record of yet (from memory).
 */
export interface HistoryEntry {
  /** The CALM Hub decorator's id; absent for a job CALM Hub holds no record of. */
  id?: number;
  /** The id the deploy request answered with, for a job read from memory. */
  deploymentId?: string;
  /** The control-evaluation decorator that records a refusal at the controls gate. */
  evaluationId?: number;
  version?: string;
  status: string;
  startTime?: string;
  endTime?: string;
  environment?: string;
  requestedBy?: string;
  pullRequest?: string;
  details?: string;
  notes?: string;
  deployedBy?: string;
  /** The nodes a deployment decorator applies to (read side only: the history route leaves it out). */
  appliesTo?: string[];
}

/** Reads any deployment decorator (this connector's, in either layout, or Backstage's) into a history entry. */
export function historyEntry(d: CalmHubDecorator, fallbackVersion?: string): HistoryEntry {
  const data = d.data ?? {};
  const fromTarget = (d.target ?? [])
    .map(t => /\/architectures\/[^/]+\/versions\/([^/]+)$/.exec(t)?.[1])
    .find(v => v && v.includes('.'));
  const g = gitopsFields(data);
  const entry: HistoryEntry = { id: d.id ?? 0, status: text(data.status) ?? 'unknown' };
  const fields: [keyof HistoryEntry, unknown][] = [
    ['version', g.architectureVersion ?? fromTarget ?? fallbackVersion],
    ['startTime', data['start-time']],
    ['endTime', data['end-time']],
    ['environment', g.environment],
    ['requestedBy', g.requestedBy],
    ['pullRequest', g.pullRequest],
    ['details', data['deployment-details']],
    ['notes', data.notes],
    ['deployedBy', g.connector],
  ];
  for (const [k, v] of fields) if (text(v)) (entry as any)[k] = v;
  return entry;
}

/** Newest first by start time, then by id. */
export function newestFirst(list: HistoryEntry[]): HistoryEntry[] {
  const t = (e: HistoryEntry) => (e.startTime ? Date.parse(e.startTime) || 0 : 0);
  return [...list].sort((a, b) => t(b) - t(a) || (b.id ?? 0) - (a.id ?? 0));
}
