import { build } from './build';
import { decide } from './decide';
import { readDrawio } from './read';
import { resolve } from './resolve';
import { toResult, type ConvertResult } from './result';

export { convertC4 } from './c4';
export { convertMermaid } from './mermaid';
export { looksLike } from './markdown';
export type { ConvertResult } from './result';
/** The draw.io name of {@link ConvertResult}, kept for existing callers. */
export type ConvertDrawioResult = ConvertResult;

/**
 * Converts a draw.io diagram (`.drawio`, `.xml` or draw.io `.svg`, plain or compressed) into a CALM architecture,
 * the way calm-import does with `--yes`: every unsure decision keeps its guess. Only the first page is converted.
 */
export async function convertDrawio(text: string): Promise<ConvertResult> {
  const diagram = await readDrawio(text);
  if (diagram.boxes.length === 0) {
    throw new Error('The diagram has no boxes to convert');
  }
  const { decisions, notes } = decide(diagram);
  const resolved = await resolve(decisions);
  const result = build(diagram, resolved);
  return toResult({
    architecture: result.architecture,
    nodeCount: result.nodeCount,
    relationshipCount: result.relationshipCount,
    decisions: resolved,
    notes: [...notes, ...result.notes],
  });
}
