import { toResult } from './result';
import type { Decision, Note } from './decide';

const guess: Decision = {
  kind: 'node-type',
  targetId: 'q',
  subject: '"Trade Events"',
  value: 'system',
  options: ['system'],
  certain: false,
  reason: 'queue shape; CALM has no queue type',
  source: 'guess',
};
const rule: Decision = {
  ...guess,
  targetId: 'db',
  certain: true,
  source: 'rule',
};
const skipped: Note = {
  subject: '"Legend"',
  message: 'legend',
  kind: 'skipped',
};

describe('toResult', () => {
  it('counts, lists only the guesses, and starts the report with the counts', () => {
    const r = toResult({
      architecture: { nodes: [] },
      nodeCount: 2,
      relationshipCount: 1,
      decisions: [guess, rule],
      notes: [skipped],
    });
    expect(r.nodes).toBe(2);
    expect(r.relationships).toBe(1);
    expect(r.architecture).toEqual({ nodes: [] });
    expect(r.guesses).toEqual([
      '"Trade Events" — node type: system (queue shape; CALM has no queue type)',
    ]);
    expect(r.report.split('\n')[0]).toBe(
      'Converted 2 nodes, 1 relationships',
    );
    expect(r.report).toContain('"Legend"');
  });
});
