import type { Decision, Note } from './decide';
import { formatReport } from './report';

/** What every reader returns: the architecture, the report and the guesses. */
export interface ConvertResult {
  /** The CALM architecture: nodes, relationships and `$schema` (release 1.3); draw.io adds `metadata._layout`. */
  architecture: Record<string, unknown>;
  /** The report: the guesses, what was changed and what was skipped. */
  report: string;
  /** One readable line per decision resolved by its guess. */
  guesses: string[];
  /** One readable line per thing left out of the architecture or changed on the way (a legend, a two-headed arrow). */
  leftOut: string[];
  nodes: number;
  relationships: number;
}

/** Assembles a reader's result: the report starts with the counts, then formatReport's sections. */
export function toResult(r: {
  architecture: Record<string, unknown>;
  nodeCount: number;
  relationshipCount: number;
  decisions: Decision[];
  notes: Note[];
}): ConvertResult {
  // formatReport's first line names an output file and a validation result, which belong to the caller here.
  const [, ...sections] = formatReport({
    ...r,
    outPath: '',
    valid: true,
  }).split('\n');
  const report = [
    `Converted ${r.nodeCount} nodes, ${r.relationshipCount} relationships`,
    ...sections,
  ].join('\n');
  return {
    architecture: r.architecture,
    report,
    guesses: r.decisions.filter(d => d.source === 'guess').map(guessLine),
    leftOut: r.notes.map(
      n => `${n.subject} — ${n.kind === 'skipped' ? 'left out' : 'changed'}: ${n.message}`,
    ),
    nodes: r.nodeCount,
    relationships: r.relationshipCount,
  };
}

/** The line formatReport writes under "Guesses:". */
function guessLine(d: Decision): string {
  return `${d.subject} — ${d.kind.replace('-', ' ')}: ${d.value} (${d.reason})`;
}
