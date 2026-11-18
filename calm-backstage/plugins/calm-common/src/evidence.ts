/**
 * Runtime evidence records: what a sensor observed about one control on one architecture element, as a decorator,
 * and the standard control evaluation mirrored from it so CALM Hub's built-in Control evaluations view draws it.
 */

/**
 * The base decorator definition. CALM Hub validates a decorator's structure against it; CALM bundles no evidence
 * standard, so `data` is checked only by whoever reads it.
 */
export const EVIDENCE_DECORATOR_SCHEMA =
  'https://calm.finos.org/release/1.3/meta/decorators.json#/defs/decorator';

/**
 * The control-evaluation decorator standard CALM Hub bundles: one evaluated control, its status and, when `not-met`,
 * at least one finding. CALM Hub's Control evaluations view draws `not-met` in red on the elements in `applies-to`.
 */
export const CONTROL_EVALUATION_STANDARD =
  'https://calm.finos.org/standards/control-evaluation/1.0/control-evaluation.decorator.standard.json';

/** `stale`: the last observation is older than its `valid-until`, so it no longer says anything. */
export type EvidenceResult = 'pass' | 'fail' | 'stale' | 'not-applicable';

export interface EvidenceControl {
  'unique-id': string;
  'control-id'?: string;
  'requirement-url': string;
  /** The control configuration the evidence is for (CALM `evidence.json` `control-config-url`). */
  'config-url'?: string;
}

export interface EvidenceInput {
  uniqueId: string;
  target: string[];
  /** The relationship for a connection check, the node(s) for a node check. */
  appliesTo: string[];
  control: EvidenceControl;
  check: string;
  result: EvidenceResult;
  expected: string;
  observed: string;
  /** Where the raw evidence is, e.g. `k8s://<namespace>/networkpolicy/<name>`. */
  evidencePaths: string[];
  observedAt: string;
  /** How long the observation holds; after it the evidence is stale. */
  validForMs: number;
  sensor: { name: string; version?: string };
  deployment?: { 'unique-id'?: string; commit?: string; environment?: string };
}

export interface EvidenceData {
  evidence: {
    'unique-id': string;
    'evidence-paths': string[];
    'control-config-url': string;
  };
  control: Omit<EvidenceControl, 'config-url'>;
  check: string;
  result: EvidenceResult;
  expected: string;
  observed: string;
  'observed-at': string;
  'valid-until': string;
  sensor: EvidenceInput['sensor'];
  deployment?: EvidenceInput['deployment'];
}

export interface EvidenceDecorator {
  $schema: string;
  'unique-id': string;
  type: 'evidence';
  target: string[];
  'target-type': ['architecture'];
  'applies-to': string[];
  data: EvidenceData;
}

export function evidenceDecorator(i: EvidenceInput): EvidenceDecorator {
  const { 'config-url': configUrl, ...control } = i.control;
  return {
    $schema: EVIDENCE_DECORATOR_SCHEMA,
    'unique-id': i.uniqueId,
    type: 'evidence',
    target: i.target,
    'target-type': ['architecture'],
    'applies-to': i.appliesTo,
    data: {
      evidence: {
        'unique-id': i.uniqueId,
        'evidence-paths': i.evidencePaths,
        'control-config-url': configUrl ?? control['requirement-url'],
      },
      control,
      check: i.check,
      result: i.result,
      expected: i.expected,
      observed: i.observed,
      'observed-at': i.observedAt,
      'valid-until': new Date(
        Date.parse(i.observedAt) + i.validForMs,
      ).toISOString(),
      sensor: i.sensor,
      ...(i.deployment ? { deployment: i.deployment } : {}),
    },
  };
}

/** True once the evidence no longer holds: past `valid-until` (or unreadable), or already marked stale. */
export function isStale(
  data: Pick<EvidenceData, 'result' | 'valid-until'>,
  now: number,
): boolean {
  const until = Date.parse(data['valid-until']);
  return data.result === 'stale' || !Number.isFinite(until) || now > until;
}

/**
 * The standard control evaluation for one control on one element, from the evidence of every check on it: `not-met`
 * when any check fails or is stale (one finding each), `not-applicable` when no check applies, else `met`.
 * One evaluation per element and control, because CALM Hub draws only the newest per element and control.
 */
export function mirrorEvaluation(
  evidence: EvidenceDecorator[],
  opts: {
    uniqueId: string;
    evaluatedAt: string;
    /** The `evaluated-at` of the evaluation this one replaces: CALM Hub keeps the newest. */
    previousEvaluatedAt?: string;
    engine: { name: string; version?: string };
    reportUri?: string;
  },
) {
  const first = evidence[0];
  const now = Date.parse(opts.evaluatedAt);
  const results = evidence.map(e =>
    isStale(e.data, now) ? 'stale' : e.data.result,
  );
  const findings = evidence
    .map((e, k) => ({ e, result: results[k] }))
    .filter(({ result }) => result === 'fail' || result === 'stale')
    .map(({ e, result }) => ({
      subject: e['applies-to'][0],
      check: e.data.check,
      description:
        result === 'stale'
          ? `No observation since ${e.data['observed-at']}: the evidence is stale`
          : e.data.observed,
      cause: result === 'stale' ? 'stale' : `expected ${e.data.expected}`,
    }));
  let status = 'met';
  if (findings.length) status = 'not-met';
  else if (results.every(r => r === 'not-applicable'))
    status = 'not-applicable';
  const previous = opts.previousEvaluatedAt
    ? Date.parse(opts.previousEvaluatedAt)
    : NaN;
  const evaluatedAt =
    previous >= now ? new Date(previous + 1).toISOString() : opts.evaluatedAt;
  return {
    $schema: CONTROL_EVALUATION_STANDARD,
    'unique-id': opts.uniqueId,
    type: 'control-evaluation',
    target: first.target,
    'target-type': ['architecture'],
    'applies-to': first['applies-to'],
    data: {
      control: { ...first.data.control, 'attached-to': first['applies-to'][0] },
      status,
      'evaluated-at': evaluatedAt,
      ...(findings.length ? { findings } : {}),
      engine: opts.engine,
      ...(opts.reportUri ? { 'report-uri': opts.reportUri } : {}),
    },
  };
}
