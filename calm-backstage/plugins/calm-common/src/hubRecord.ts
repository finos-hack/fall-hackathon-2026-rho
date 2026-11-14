/*
 * What the CALM plugins record in CALM Hub for a service created from a pattern: its architecture, as a version of
 * an architecture named after the service, and one deployment decorator per deployment. Shared by the scaffolder
 * actions (which write), the catalog provider (which skips these architectures) and calm-backend (which reads).
 */
import type { CalmHubDecorator } from './hubClient';

/** Names the Hub accepts for a document (its `CUSTOM_ID_REGEX`): a letter first, then letters, digits and hyphens. */
export const HUB_NAME = /^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*$/;
/** Versions the name-based write API accepts: three numbers. */
export const HUB_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** What the Hub's decorator `target` filter accepts. A URL (with `:`) does not pass. */
export const DECORATOR_TARGET = /^[A-Za-z0-9_/.-]+$/;

const enc = encodeURIComponent;

/**
 * Path of an architecture version in the name-based API. The Hub URL of the version is the base URL plus this, and
 * a decorator names the version by this path, because the Hub's `target` filter matches whole entries and refuses `:`.
 */
export function architectureVersionPath(
  namespace: string,
  name: string,
  version: string,
): string {
  return `/calm/namespaces/${enc(namespace)}/architectures/${enc(
    name,
  )}/versions/${enc(version)}`;
}

/** `1.2.3` to `1.2.4`. */
export function nextPatchVersion(version: string): string {
  const m = HUB_VERSION.exec(version);
  if (!m) {
    throw new Error(`Not a <major>.<minor>.<patch> version: ${version}`);
  }
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Deep equality of two JSON values; the order of object keys does not count (the Hub moves `$id` to the end). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameJson(x, b[i]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return (
      ak.length === bk.length &&
      ak.every(
        k =>
          Object.prototype.hasOwnProperty.call(b, k) &&
          sameJson((a as any)[k], (b as any)[k]),
      )
    );
  }
  return false;
}

/** The key in an architecture's `metadata` under which a service's catalog entity is named. */
export const SERVICE_METADATA_KEY = 'calm-backstage';

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The catalog entity a Hub architecture was registered for (`metadata["calm-backstage"].entity`), or undefined for
 * an architecture that was put in the Hub some other way. The catalog provider emits no Component for the former:
 * the service's own `catalog-info.yaml` is its entity.
 */
export function serviceEntityOf(architecture: unknown): string | undefined {
  const metadata = (architecture as any)?.metadata;
  const entries = Array.isArray(metadata) ? metadata : [metadata];
  for (const entry of entries) {
    const entity = isObject(entry)
      ? entry[SERVICE_METADATA_KEY]?.entity
      : undefined;
    if (typeof entity === 'string' && entity) {
      return entity;
    }
  }
  return undefined;
}

/** A copy of the architecture whose `metadata` names the service's catalog entity (CALM metadata: object or list). */
export function markServiceArchitecture<T extends Record<string, any>>(
  architecture: T,
  entityRef: string,
): T {
  const mark = { [SERVICE_METADATA_KEY]: { entity: entityRef } };
  const metadata = architecture.metadata;
  if (Array.isArray(metadata)) {
    return {
      ...architecture,
      metadata: [
        ...metadata.filter(m => !(isObject(m) && SERVICE_METADATA_KEY in m)),
        mark,
      ],
    };
  }
  return {
    ...architecture,
    metadata: { ...(isObject(metadata) ? metadata : {}), ...mark },
  };
}

/** The draft deployment decorator standard: its `$schema` and the `data.status` values it allows. */
export const DEPLOYMENT_DECORATOR_SCHEMA =
  'https://calm.finos.org/draft/2026-03/standards/deployment/deployment.decorator.standard.json';
export const DEPLOYMENT_DECORATOR_TYPE = 'deployment';
export const DEPLOYMENT_STATUSES = [
  'pending',
  'in-progress',
  'completed',
  'failed',
  'rolled-back',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * The target CALM Hub's own UI filters decorators by on an architecture page: the numeric API path with the version's
 * dots as hyphens, e.g. `/api/calm/namespaces/hackathon/architectures/16/versions/1-0-0`. A decorator that should show
 * on the Hub's Deployments tab needs this entry in `target` as well as the name-based path.
 */
export function architectureVersionUiTarget(
  namespace: string,
  numericId: number,
  version: string,
): string {
  return `/api/calm/namespaces/${namespace}/architectures/${numericId}/versions/${version.replace(
    /\./g,
    '-',
  )}`;
}

/** A deployment decorator in the shape the Hub is sent (kebab case), targeting one architecture version. */
export function deploymentDecorator(opts: {
  uniqueId: string;
  /** `architectureVersionPath(...)` of the deployed architecture. */
  target: string;
  /** More entries for `target`, e.g. `architectureVersionUiTarget(...)`. */
  extraTargets?: string[];
  /** `unique-id`s of the deployed nodes. */
  appliesTo: string[];
  status: DeploymentStatus;
  startTime: string;
  endTime?: string;
  /** URI with the details of the deployment. */
  details?: string;
  notes?: string;
}): Record<string, unknown> {
  const bad = [opts.target, ...(opts.extraTargets ?? [])].find(
    t => !DECORATOR_TARGET.test(t),
  );
  if (bad !== undefined) {
    throw new Error(
      `Decorator target ${JSON.stringify(
        bad,
      )} would not be found again: the Hub's target filter accepts only ${
        DECORATOR_TARGET.source
      }`,
    );
  }
  if (!DEPLOYMENT_STATUSES.includes(opts.status)) {
    throw new Error(
      `Deployment status must be one of ${DEPLOYMENT_STATUSES.join(
        ', ',
      )}, got ${JSON.stringify(opts.status)}`,
    );
  }
  for (const [label, time] of [
    ['start', opts.startTime],
    ['end', opts.endTime],
  ] as const) {
    if (time !== undefined && Number.isNaN(Date.parse(time))) {
      throw new Error(
        `Deployment ${label} time is not a date-time: ${JSON.stringify(time)}`,
      );
    }
  }
  return {
    $schema: DEPLOYMENT_DECORATOR_SCHEMA,
    'unique-id': opts.uniqueId,
    type: DEPLOYMENT_DECORATOR_TYPE,
    target: [opts.target, ...(opts.extraTargets ?? [])],
    'target-type': ['architecture'],
    'applies-to': opts.appliesTo,
    data: {
      'start-time': opts.startTime,
      ...(opts.endTime ? { 'end-time': opts.endTime } : {}),
      status: opts.status,
      ...(opts.details ? { 'deployment-details': opts.details } : {}),
      ...(opts.notes ? { notes: opts.notes } : {}),
    },
  };
}

/** A deployment recorded in the Hub, as calm-backend gives it to the architecture card. */
export interface RecordedDeployment {
  /** The Hub's decorator id. */
  id: number;
  uniqueId: string;
  status: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
  /** `deployment-details`: a URI. */
  details?: string;
  appliesTo: string[];
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function recordedDeployment(d: CalmHubDecorator): RecordedDeployment {
  const startTime = text(d.data['start-time']);
  const endTime = text(d.data['end-time']);
  const notes = text(d.data.notes);
  const details = text(d.data['deployment-details']);
  return {
    id: d.id ?? 0,
    uniqueId: d.uniqueId,
    status: text(d.data.status) ?? 'unknown',
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    ...(notes ? { notes } : {}),
    ...(details ? { details } : {}),
    appliesTo: d.appliesTo,
  };
}

/** Newest first, by start time; a deployment without one sorts last, then by decorator id. */
export function newestFirst(list: RecordedDeployment[]): RecordedDeployment[] {
  const time = (d: RecordedDeployment) =>
    d.startTime ? Date.parse(d.startTime) || 0 : 0;
  return [...list].sort((a, b) => time(b) - time(a) || b.id - a.id);
}
