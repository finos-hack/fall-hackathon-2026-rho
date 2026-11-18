// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import type { Decision, Note } from './decide';

export interface ReportInput {
  nodeCount: number;
  relationshipCount: number;
  outPath: string;
  valid: boolean;
  decisions: Decision[];
  notes: Note[];
}

export function formatReport(r: ReportInput): string {
  const decision = (d: Decision) =>
    `${d.subject} — ${d.kind.replace('-', ' ')}: ${d.value}`;
  const sections: Array<[string, string[]]> = [
    [
      'Guesses:',
      r.decisions
        .filter(d => d.source === 'guess')
        .map(d => `${decision(d)} (${d.reason})`),
    ],
    [
      'Your choices:',
      r.decisions.filter(d => d.source === 'user').map(decision),
    ],
    [
      'Changed:',
      r.notes
        .filter(n => n.kind === 'adjusted')
        .map(n => `${n.subject} — ${n.message}`),
    ],
    [
      'Skipped:',
      r.notes
        .filter(n => n.kind === 'skipped')
        .map(n => `${n.subject} — ${n.message}`),
    ],
  ];
  const lines = [
    `Converted ${r.nodeCount} nodes, ${r.relationshipCount} relationships → ${
      r.outPath
    } (${r.valid ? 'valid' : 'NOT valid'})`,
  ];
  for (const [title, items] of sections) {
    if (items.length > 0) lines.push(title, ...items.map(item => `  ${item}`));
  }
  return `${lines.join('\n')}\n`;
}
