import { build } from './build';
import { decide, type Decision } from './decide';
import { readDrawio } from './read';
import { formatReport } from './report';
import { resolve } from './resolve';

export interface ConvertDrawioResult {
  /** The CALM architecture: nodes, relationships, `metadata._layout` and `$schema` (release 1.3). */
  architecture: Record<string, unknown>;
  /** calm-import's report: the guesses, what it changed and what it skipped. */
  report: string;
  /** One readable line per decision resolved by its guess. */
  guesses: string[];
  nodes: number;
  relationships: number;
}

/**
 * Converts a draw.io diagram (`.drawio`, `.xml` or draw.io `.svg`, plain or compressed) into a CALM architecture,
 * the way calm-import does with `--yes`: every unsure decision keeps its guess. Only the first page is converted.
 */
export async function convertDrawio(
  text: string,
): Promise<ConvertDrawioResult> {
  const diagram = await readDrawio(text);
  if (diagram.boxes.length === 0) {
    throw new Error('The diagram has no boxes to convert');
  }
  const { decisions, notes } = decide(diagram);
  const resolved = await resolve(decisions);
  const result = build(diagram, resolved);
  // formatReport's first line names an output file and a validation result, which belong to the caller here.
  const [, ...sections] = formatReport({
    ...result,
    outPath: '',
    valid: true,
    decisions: resolved,
    notes: [...notes, ...result.notes],
  }).split('\n');
  const report = [
    `Converted ${result.nodeCount} nodes, ${result.relationshipCount} relationships`,
    ...sections,
  ].join('\n');
  return {
    architecture: result.architecture,
    report,
    guesses: resolved.filter(d => d.source === 'guess').map(guessLine),
    nodes: result.nodeCount,
    relationships: result.relationshipCount,
  };
}

/** The line formatReport writes under "Guesses:". */
function guessLine(d: Decision): string {
  return `${d.subject} — ${d.kind.replace('-', ' ')}: ${d.value} (${d.reason})`;
}
