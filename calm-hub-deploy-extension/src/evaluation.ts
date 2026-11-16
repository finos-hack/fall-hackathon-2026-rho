import { architectureVersionPath, type CalmHubDecorator } from '@internal/backstage-plugin-calm-common';
import type { ValidationMessage } from '@internal/backstage-plugin-calm-node';
import { CONNECTOR, versionTargets, type HistoryEntry } from './record';
import type { ReadDeps } from './status';
import { oneLine } from './deploy/kube';

/**
 * The control-evaluation decorator standard CALM Hub bundles: one evaluated control, its status and, when `not-met`,
 * at least one finding. CALM Hub's Control evaluations view draws `not-met` in red on the elements in `applies-to`.
 */
export const CONTROL_EVALUATION_STANDARD =
  'https://calm.finos.org/standards/control-evaluation/1.0/control-evaluation.decorator.standard.json';

const ENGINE = 'calm validate';
const MAX_FINDINGS = 5;

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** One `calm validate` error as a line: `<path>: <message>`, never empty. */
export function errorLine(e: ValidationMessage): string {
  const message = text(e.message?.trim()) ?? 'error with no message';
  return e.path ? `${e.path}: ${message}` : message;
}

/** The notes of an attempt refused at the controls gate (in memory and read back from CALM Hub alike). */
export const refusalNotes = (first: string) => `Refused at the controls gate: ${first}`;

/** The first error of a refusal, as its notes and first finding give it. */
export const firstError = (errors: ValidationMessage[]) => (errors.length ? errorLine(errors[0]) : 'calm validate reported errors');

/** A version `calm validate` refused, and what is needed to say where. */
export interface GateRefusal {
  namespace: string;
  architecture: string;
  version: string;
  numericId?: number;
  /** 8 characters of the request's audit id, as at the end of the deployment record's unique-id. */
  shortId: string;
  /** The refused version's architecture document. */
  refused: any;
  /** The deployed version's architecture document; undefined when not known. */
  deployed?: any;
  errors: ValidationMessage[];
  /** CALM Hub base URL: the architecture version's URL is the last resort for `requirement-url`. */
  hubUrl: string;
  requestedBy: string;
  hubAuditId: string;
  evaluatedAt: string;
  /** The version of the `calm` CLI that ran `calm validate`, when known (`data.engine.version`). */
  engineVersion?: string;
}

/** Relationships (by unique-id) of the refused version that the deployed one does not have; none when it is unknown. */
export function addedRelationships(refused: any, deployed: any | undefined): any[] {
  if (!deployed) return [];
  const known = new Set(list(deployed.relationships).map(r => r?.['unique-id']));
  return list(refused?.relationships).filter(r => text(r?.['unique-id']) && !known.has(r['unique-id']));
}

const connects = (r: any) => r?.['relationship-type']?.connects;
const securityRequirementUrl = (r: any) => text(r?.controls?.security?.requirements?.[0]?.['requirement-url']);

/**
 * The requirement the refusal is about: the offending relationship's security control, else the first relationship
 * that has one (the offending one usually carries none), else the architecture version in CALM Hub.
 */
export function requirementUrlOf(offending: any | undefined, refused: any, versionUrl: string): string {
  return (
    (offending ? securityRequirementUrl(offending) : undefined) ??
    list(refused?.relationships).map(securityRequirementUrl).find(Boolean) ??
    versionUrl
  );
}

/** `permitted-connection` from `.../controls/permitted-connection/requirement/...`; undefined for other URLs. */
export function controlIdOf(url: string): string | undefined {
  return /\/controls\/([^/]+)\/requirement\//.exec(url)?.[1];
}

/**
 * The control-evaluation decorator (`not-met`) for a version refused at the controls gate. It blames the first
 * `connects` relationship the version adds over the deployed one (and its two nodes); when there is none, the error
 * is elsewhere and it applies to every node of the version.
 */
export function controlEvaluationOf(r: GateRefusal): Record<string, unknown> {
  const offending = addedRelationships(r.refused, r.deployed).find(connects);
  const relationship: string | undefined = offending?.['unique-id'];
  const ends = offending ? connects(offending) : undefined;
  const appliesTo = offending
    ? [relationship, text(ends?.source?.node), text(ends?.destination?.node)].filter((x): x is string => !!x)
    : list(r.refused?.nodes)
        .map(n => text(n?.['unique-id']))
        .filter((x): x is string => !!x);
  const requirementUrl = requirementUrlOf(
    offending,
    r.refused,
    `${r.hubUrl}${architectureVersionPath(r.namespace, r.architecture, r.version)}`,
  );
  const controlId = controlIdOf(requirementUrl);
  const subject = relationship ?? r.version;
  const descriptions = r.errors.length ? r.errors.slice(0, MAX_FINDINGS).map(errorLine) : [firstError(r.errors)];
  return {
    $schema: CONTROL_EVALUATION_STANDARD,
    'unique-id': `${r.architecture}-${r.version}-gate-${r.shortId}`,
    type: 'control-evaluation',
    target: versionTargets(r.namespace, r.architecture, r.version, r.numericId),
    'target-type': ['architecture'],
    'applies-to': appliesTo,
    data: {
      control: {
        'unique-id': 'security',
        ...(controlId ? { 'control-id': controlId } : {}),
        'requirement-url': requirementUrl,
        ...(relationship ? { 'attached-to': relationship } : {}),
      },
      status: 'not-met',
      'evaluated-at': r.evaluatedAt,
      findings: descriptions.map(description => ({ subject, description, check: ENGINE })),
      engine: { name: ENGINE, ...(r.engineVersion ? { version: r.engineVersion } : {}) },
      actors: { 'requested-by': r.requestedBy, 'hub-audit-id': r.hubAuditId, connector: CONNECTOR },
    },
  };
}

/**
 * Records a refusal in CALM Hub as one control-evaluation decorator; gives its id. Reads the deployed version to
 * find what the refused one adds (when it cannot, the evaluation applies to every node).
 */
export async function recordRefusal(
  deps: Pick<ReadDeps, 'hub' | 'settings' | 'logger'>,
  r: Omit<GateRefusal, 'deployed' | 'hubUrl'> & { deployedVersion?: string },
): Promise<number> {
  const { deployedVersion, ...refusal } = r;
  let deployed: unknown;
  if (deployedVersion) {
    try {
      deployed = await deps.hub.architecture(r.namespace, r.architecture, deployedVersion);
    } catch (e) {
      deps.logger.warn(`Could not read ${r.architecture} ${deployedVersion} to compare with ${r.version}: ${oneLine(e)}`);
    }
  }
  return deps.hub.createDecorator(r.namespace, controlEvaluationOf({ ...refusal, deployed, hubUrl: deps.settings.hubUrl }));
}

/** True for a control evaluation this connector wrote (`data.actors.connector`). */
export function isOwnEvaluation(d: Pick<CalmHubDecorator, 'data'>): boolean {
  return d.data?.actors?.connector === CONNECTOR;
}

/** A refusal at the controls gate, read back from its control-evaluation decorator, as a history entry. */
export function evaluationEntry(d: CalmHubDecorator, version?: string): HistoryEntry {
  const data = d.data ?? {};
  const id = d.id ?? 0;
  const entry: HistoryEntry = { id, evaluationId: id, status: 'refused' };
  const fields: [keyof HistoryEntry, unknown][] = [
    ['version', version],
    ['startTime', data['evaluated-at']],
    ['requestedBy', data.actors?.['requested-by']],
    ['notes', refusalNotes(text(data.findings?.[0]?.description) ?? 'not met')],
    ['deployedBy', data.actors?.connector],
  ];
  for (const [k, v] of fields) if (text(v)) (entry as any)[k] = v;
  return entry;
}
