import {
  EVIDENCE_DECORATOR_SCHEMA,
  CONTROL_EVALUATION_STANDARD,
  evidenceDecorator,
  isStale,
  mirrorEvaluation,
  type EvidenceInput,
} from './evidence';

const control = {
  'unique-id': 'security',
  'control-id': 'permitted-connection',
  'requirement-url':
    'http://hub/controls/permitted-connection/requirement/1.0.0',
  'config-url': 'http://hub/controls/permitted-connection/configuration/https',
};

const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  uniqueId: 'orders-local-api-to-db-network-policy',
  target: ['/calm/namespaces/demo/architectures/orders/versions/1.2.0'],
  appliesTo: ['api-to-db'],
  control,
  check: 'network-policy',
  result: 'pass',
  expected: 'ingress from api on 5432',
  observed: 'ingress from api on 5432',
  evidencePaths: ['k8s://calm-orders/networkpolicy/api-to-db-ingress'],
  observedAt: '2026-11-18T10:00:00.000Z',
  validForMs: 90_000,
  sensor: { name: 'platform-connector-sensors', version: '0.1.0' },
  ...over,
});

describe('evidenceDecorator', () => {
  it('applies to the element it names, links the control config, and holds only base decorator fields', () => {
    const d = evidenceDecorator(input());
    expect(Object.keys(d).sort()).toEqual(
      [
        '$schema',
        'applies-to',
        'data',
        'target',
        'target-type',
        'type',
        'unique-id',
      ].sort(),
    );
    expect(d.$schema).toBe(EVIDENCE_DECORATOR_SCHEMA);
    expect(d.type).toBe('evidence');
    expect(d['applies-to']).toEqual(['api-to-db']);
    expect(d.data.evidence).toEqual({
      'unique-id': 'orders-local-api-to-db-network-policy',
      'evidence-paths': ['k8s://calm-orders/networkpolicy/api-to-db-ingress'],
      'control-config-url': control['config-url'],
    });
    expect(d.data['valid-until']).toBe('2026-11-18T10:01:30.000Z');
    expect(d.data.control).toEqual({
      'unique-id': 'security',
      'control-id': 'permitted-connection',
      'requirement-url': control['requirement-url'],
    });
  });

  it('falls back to the requirement URL when the control has no config URL', () => {
    const { 'config-url': _, ...noConfig } = control;
    const d = evidenceDecorator(input({ control: noConfig }));
    expect(d.data.evidence['control-config-url']).toBe(
      control['requirement-url'],
    );
  });
});

describe('mirrorEvaluation', () => {
  const opts = {
    uniqueId: 'orders-local-api-to-db-security',
    evaluatedAt: '2026-11-18T10:00:05.000Z',
    engine: { name: 'platform-connector-sensors' },
  };

  it('is not-met with one finding per failing or stale check, even when another check passes', () => {
    const failing = evidenceDecorator(
      input({
        check: 'tls',
        result: 'fail',
        observed: 'Certificate api-tls not Ready',
        uniqueId: 'tls',
      }),
    );
    const stale = evidenceDecorator(input({ result: 'stale', uniqueId: 'np' }));
    const passing = evidenceDecorator(
      input({ check: 'egress', uniqueId: 'eg' }),
    );
    const e = mirrorEvaluation([passing, failing, stale], opts);
    expect(e.$schema).toBe(CONTROL_EVALUATION_STANDARD);
    expect(e['applies-to']).toEqual(['api-to-db']);
    expect(e.data.status).toBe('not-met');
    expect(e.data.findings).toEqual([
      expect.objectContaining({
        subject: 'api-to-db',
        check: 'tls',
        description: 'Certificate api-tls not Ready',
      }),
      expect.objectContaining({
        subject: 'api-to-db',
        check: 'network-policy',
        cause: 'stale',
      }),
    ]);
    expect(e.data['report-uri']).toBeUndefined();
  });

  it('treats evidence past its valid-until as stale, so it never shows met', () => {
    const old = evidenceDecorator(
      input({ observedAt: '2026-11-18T09:58:00.000Z' }),
    );
    const e = mirrorEvaluation([old], opts);
    expect(e.data.status).toBe('not-met');
    expect(e.data.findings?.[0].cause).toBe('stale');
  });

  it('is met with no findings key when every check passes', () => {
    const e = mirrorEvaluation([evidenceDecorator(input())], {
      ...opts,
      reportUri: 'http://hub/decorators/7',
    });
    expect(e.data.status).toBe('met');
    expect('findings' in e.data).toBe(false);
    expect(e.data['report-uri']).toBe('http://hub/decorators/7');
    expect(e.data.control).toEqual({
      'unique-id': 'security',
      'control-id': 'permitted-connection',
      'requirement-url': control['requirement-url'],
      'attached-to': 'api-to-db',
    });
  });

  it('is not-applicable when every check is not-applicable', () => {
    const e = mirrorEvaluation(
      [evidenceDecorator(input({ result: 'not-applicable' }))],
      opts,
    );
    expect(e.data.status).toBe('not-applicable');
    expect('findings' in e.data).toBe(false);
  });

  it('dates the evaluation after the previous one on the same key', () => {
    const e = mirrorEvaluation([evidenceDecorator(input())], {
      ...opts,
      previousEvaluatedAt: '2026-11-18T10:00:10.000Z',
    });
    expect(e.data['evaluated-at']).toBe('2026-11-18T10:00:10.001Z');
  });
});

describe('isStale', () => {
  const data = evidenceDecorator(input()).data;
  const until = Date.parse(data['valid-until']);

  it('is false up to valid-until and true after it', () => {
    expect(isStale(data, until - 1)).toBe(false);
    expect(isStale(data, until)).toBe(false);
    expect(isStale(data, until + 1)).toBe(true);
  });

  it('is true for a stale result or an unreadable valid-until', () => {
    expect(isStale({ ...data, result: 'stale' }, until - 1)).toBe(true);
    expect(isStale({ ...data, 'valid-until': 'soon' }, until - 1)).toBe(true);
  });
});
