// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import type { Decision } from './decide';
import { formatReport } from './report';

function decision(
  subject: string,
  kind: Decision['kind'],
  value: string,
  source: Decision['source'],
  certain = false,
): Decision {
  return {
    kind,
    targetId: subject,
    subject,
    value,
    options: [value],
    certain,
    reason: 'a reason',
    source,
  };
}

describe('formatReport', () => {
  it('lists guesses, choices, changes and skips by subject', () => {
    const report = formatReport({
      nodeCount: 7,
      relationshipCount: 9,
      outPath: 'trading.calm.json',
      valid: true,
      decisions: [
        decision('Order Service', 'node-type', 'service', 'rule', true),
        decision('Trade Events', 'node-type', 'system', 'guess'),
        decision('Order Service → Trade Events', 'protocol', 'AMQP', 'user'),
      ],
      notes: [
        {
          subject: 'Order Service ↔ Risk Service',
          message: 'two-headed arrow, kept the drawn direction',
          kind: 'adjusted',
        },
        {
          subject: 'TODO: add DR site',
          message: 'sticky note',
          kind: 'skipped',
        },
      ],
    });
    expect(report).toBe(
      [
        'Converted 7 nodes, 9 relationships → trading.calm.json (valid)',
        'Guesses:',
        '  Trade Events — node type: system (a reason)',
        'Your choices:',
        '  Order Service → Trade Events — protocol: AMQP',
        'Changed:',
        '  Order Service ↔ Risk Service — two-headed arrow, kept the drawn direction',
        'Skipped:',
        '  TODO: add DR site — sticky note',
        '',
      ].join('\n'),
    );
  });

  it('omits empty sections and says when the result is not valid', () => {
    const report = formatReport({
      nodeCount: 1,
      relationshipCount: 0,
      outPath: 'a.json',
      valid: false,
      decisions: [],
      notes: [],
    });
    expect(report).toBe(
      'Converted 1 nodes, 0 relationships → a.json (NOT valid)\n',
    );
  });
});
