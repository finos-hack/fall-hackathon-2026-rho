import { describe, expect, it } from 'vitest';
import {
  addedRelationships,
  controlEvaluationOf,
  controlIdOf,
  errorLine,
  evaluationEntry,
  requirementUrlOf,
  type GateRefusal,
} from './evaluation';
import { architectureDoc, evaluationErrors } from './test/fakes';

const VERSION_URL = 'http://hub.test/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.2';
const url = (id: string) => `http://hub.test/calm/domains/security/controls/${id}/requirement/versions/1.0.0`;
const withControl = (r: any, u: string) => ({ ...r, controls: { security: { requirements: [{ 'requirement-url': u }] } } });

const deployed = architectureDoc('events-stream', '1.0.0', ['database']);
const refused = architectureDoc('events-stream', '1.0.2', ['database', 'stream']);

const refusal: GateRefusal = {
  namespace: 'hackathon',
  architecture: 'events-stream',
  version: '1.0.2',
  shortId: 'aaaa1111',
  refused,
  deployed,
  errors: [{ severity: 'error', message: 'not permitted', path: '/relationships/1' }],
  hubUrl: 'http://hub.test',
  requestedBy: 'alice',
  hubAuditId: 'aaaa1111-2222',
  evaluatedAt: '2026-11-16T10:00:00.000Z',
};

describe('addedRelationships', () => {
  it('gives the relationships the deployed version does not have, and none when it is unknown', () => {
    expect(addedRelationships(refused, deployed).map(r => r['unique-id'])).toEqual(['web-service-stream']);
    expect(addedRelationships(refused, undefined)).toEqual([]);
  });
});

describe('requirementUrlOf', () => {
  const [db, stream] = refused.relationships;
  it('takes the offending relationship’s security requirement first', () => {
    const doc = { relationships: [withControl(db, url('a')), withControl(stream, url('b'))] };
    expect(requirementUrlOf(doc.relationships[1], doc, VERSION_URL)).toBe(url('b'));
  });
  it('else the first relationship with a security control', () => {
    const doc = { relationships: [stream, withControl(db, url('a'))] };
    expect(requirementUrlOf(stream, doc, VERSION_URL)).toBe(url('a'));
  });
  it('else the architecture version in CALM Hub', () => {
    expect(requirementUrlOf(stream, refused, VERSION_URL)).toBe(VERSION_URL);
  });
});

describe('controlIdOf', () => {
  it('reads the control id from a control requirement URL only', () => {
    expect(controlIdOf(url('permitted-connection'))).toBe('permitted-connection');
    expect(controlIdOf(VERSION_URL)).toBeUndefined();
  });
});

describe('controlEvaluationOf', () => {
  it('meets the control-evaluation standard, blaming the added connects relationship and its two nodes', () => {
    const d: any = controlEvaluationOf(refusal);
    expect(evaluationErrors(d)).toEqual([]);
    expect(d.target).toEqual(['/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.2']);
    expect(d['applies-to']).toEqual(['web-service-stream', 'web-service', 'stream']);
    expect(d.data.control).toStrictEqual({ 'unique-id': 'security', 'requirement-url': VERSION_URL, 'attached-to': 'web-service-stream' });
    expect(d.data.findings).toEqual([
      { subject: 'web-service-stream', description: '/relationships/1: not permitted', check: 'calm validate' },
    ]);
  });

  it('still gives a finding when calm validate reported errors without any message', () => {
    const d: any = controlEvaluationOf({ ...refusal, errors: [] });
    expect(d.data.findings).toEqual([{ subject: 'web-service-stream', description: 'calm validate reported errors', check: 'calm validate' }]);
    expect(errorLine({ severity: 'error', message: '' })).toBe('error with no message');
  });

  it('is refused by CALM Hub’s rules without findings (the fake checks what CALM Hub checks)', () => {
    const d: any = controlEvaluationOf(refusal);
    expect(evaluationErrors({ ...d, data: { ...d.data, findings: [] } })).toContainEqual({
      location: '/data',
      error: 'required property findings missing',
    });
    expect(evaluationErrors({ ...d, data: { ...d.data, status: 'failed' } })).toContainEqual({ location: '/data/status', error: 'not in enum' });
  });
});

describe('evaluationEntry', () => {
  it('reads a refusal back as a history entry', () => {
    const d: any = controlEvaluationOf(refusal);
    expect(evaluationEntry({ id: 5, uniqueId: d['unique-id'], type: d.type, target: d.target, targetType: [], appliesTo: [], data: d.data }, '1.0.2')).toEqual({
      id: 5,
      evaluationId: 5,
      version: '1.0.2',
      status: 'refused',
      startTime: '2026-11-16T10:00:00.000Z',
      requestedBy: 'alice',
      notes: 'Refused at the controls gate: /relationships/1: not permitted',
      deployedBy: 'platform-connector',
    });
  });
});
