import {
  architectureVersionPath,
  architectureVersionUiTarget,
  deploymentDecorator,
  type CalmHubDecorator,
  type DeploymentStatus,
} from '@internal/backstage-plugin-calm-common';

/** Marks the deployments this extension records, so it can find its own (e.g. to close those a restart cut off). */
export const DEPLOYED_BY = 'gitops-deploy';

/**
 * One deployment as this extension tracks it. The decorator is rebuilt from it on every change (CALM Hub replaces the
 * whole document on PUT). Fields beyond the deployment standard's `data` are the deployment extension profile's
 * (PROFILE.md); the standard allows extra properties and the Hub's Decorators tab shows them all.
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
  environment: string;
  requestedBy: string;
  /** The `jti` of the call that asked for the deployment: its id in CALM Hub's audit log. */
  hubAuditId: string;
  pullRequest?: string;
  commit?: string;
  /** URI with the details: the commit Flux applied, else the pull request, else the repository. */
  details?: string;
}

/** The deployment decorator for a record: targets the architecture version by name (Backstage) and by id (Hub UI). */
export function decoratorOf(r: DeploymentRecord): Record<string, unknown> {
  const d = deploymentDecorator({
    uniqueId: r.uniqueId,
    target: architectureVersionPath(r.namespace, r.architecture, r.version),
    extraTargets: r.numericId !== undefined ? [architectureVersionUiTarget(r.namespace, r.numericId, r.version)] : [],
    appliesTo: r.appliesTo,
    status: r.status,
    startTime: r.startTime,
    ...(r.endTime ? { endTime: r.endTime } : {}),
    ...(r.details ? { details: r.details } : {}),
    notes: r.notes,
  }) as { data: Record<string, unknown> };
  d.data = {
    ...d.data,
    environment: r.environment,
    'architecture-version': r.version,
    'requested-by': r.requestedBy,
    'hub-audit-id': r.hubAuditId,
    'deployed-by': DEPLOYED_BY,
    ...(r.pullRequest ? { 'pull-request': r.pullRequest } : {}),
    ...(r.commit ? { commit: r.commit } : {}),
  };
  return d;
}

/** A recorded deployment as the status and history routes give it. */
export interface HistoryEntry {
  id: number;
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
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Reads any deployment decorator (this extension's or Backstage's) into a history entry. */
export function historyEntry(d: CalmHubDecorator, fallbackVersion?: string): HistoryEntry {
  const data = d.data ?? {};
  const fromTarget = (d.target ?? [])
    .map(t => /\/architectures\/[^/]+\/versions\/([^/]+)$/.exec(t)?.[1])
    .find(v => v && v.includes('.'));
  const entry: HistoryEntry = { id: d.id ?? 0, status: text(data.status) ?? 'unknown' };
  const fields: [keyof HistoryEntry, unknown][] = [
    ['version', text(data['architecture-version']) ?? fromTarget ?? fallbackVersion],
    ['startTime', data['start-time']],
    ['endTime', data['end-time']],
    ['environment', data.environment],
    ['requestedBy', data['requested-by']],
    ['pullRequest', data['pull-request']],
    ['details', data['deployment-details']],
    ['notes', data.notes],
    ['deployedBy', data['deployed-by']],
  ];
  for (const [k, v] of fields) if (text(v)) (entry as any)[k] = v;
  return entry;
}

/** Newest first by start time, then by id. */
export function newestFirst(list: HistoryEntry[]): HistoryEntry[] {
  const t = (e: HistoryEntry) => (e.startTime ? Date.parse(e.startTime) || 0 : 0);
  return [...list].sort((a, b) => t(b) - t(a) || b.id - a.id);
}
