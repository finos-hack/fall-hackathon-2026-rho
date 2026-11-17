import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { convertC4 } from './index';
import type { ConvertResult } from '../result';
import { WIDGET_CASES, type CalmRel } from './__fixtures__/widget-cases';

interface Rel {
  'relationship-type': Record<string, any>;
  description?: string;
  protocol?: string;
}

/** The relationships of a result as CalmRel, sorted so two lists compare equal when they hold the same ones. */
function rels(result: ConvertResult): CalmRel[] {
  const out = (result.architecture.relationships as Rel[]).map(rel => {
    const [kind, body] = Object.entries(rel['relationship-type'])[0]!;
    const ids =
      kind === 'connects'
        ? [body.source.node, body.destination.node]
        : kind === 'interacts'
          ? [body.actor, ...body.nodes]
          : [body.container, ...body.nodes];
    return {
      kind: kind as CalmRel['kind'],
      ids,
      ...(rel.description ? { description: rel.description } : {}),
      ...(rel.protocol ? { protocol: rel.protocol } : {}),
    };
  });
  return sorted(out);
}

const sorted = (list: CalmRel[]) =>
  [...list].sort((a, b) => key(a).localeCompare(key(b)));
const key = (rel: CalmRel) => `${rel.kind} ${rel.ids.join(' ')}`;

describe('round trip: upstream c4-diagram widget cases', () => {
  it.each(WIDGET_CASES)('$name', async ({ lines, nodes, relationships }) => {
    const result = await convertC4(lines.join('\n'));

    const got = (
      result.architecture.nodes as Array<{
        'unique-id': string;
        'node-type': string;
        name: string;
      }>
    ).map(n => ({ id: n['unique-id'], type: n['node-type'], name: n.name }));
    expect(got).toHaveLength(nodes.length);
    expect(got).toEqual(expect.arrayContaining(nodes));
    expect(rels(result)).toEqual(sorted(relationships));
  });

  it('reads the widget’s own output inside a Markdown fence, as docify writes it', async () => {
    const { lines, nodes } = WIDGET_CASES[0]!;
    const result = await convertC4(
      `# Shop\n\n\`\`\`mermaid\n${lines.join('\n')}\n\`\`\`\n`,
    );

    expect(result.nodes).toBe(nodes.length);
  });
});

describe('round trip: upstream docify C4 fixtures (older generator, weak check)', () => {
  const dir = join(__dirname, '__fixtures__', 'docify');
  const names = readdirSync(dir)
    .filter(file => file.endsWith('.arch.json'))
    .map(file => file.replace('.arch.json', ''));

  it('has the 7 pairs', () => {
    expect(names).toHaveLength(7);
  });

  // The generator wraps everything in a Deployment_Node "deployment" that is not in the architecture.
  const WRAPPER = 'deployment';

  it.each(names)('%s: same element ids and names, parents and endpoints', async name => {
    const architecture = JSON.parse(
      readFileSync(join(dir, `${name}.arch.json`), 'utf-8'),
    ) as {
      nodes: Array<{ 'unique-id': string; name: string }>;
      relationships: Rel[];
    };
    const markdown = readFileSync(join(dir, `${name}.md`), 'utf-8');
    const result = await convertC4(markdown);
    const got = result.architecture.nodes as Array<{
      'unique-id': string;
      name: string;
    }>;

    const expected = architecture.nodes.map(n => [n['unique-id'], n.name]);
    expect(
      got.filter(n => n['unique-id'] !== WRAPPER).map(n => [n['unique-id'], n.name]),
    ).toEqual(expect.arrayContaining(expected));
    expect(got).toHaveLength(expected.length + 1);

    const edges = (list: CalmRel[], kinds: string[], ignoreWrapper = false) =>
      list
        .filter(rel => kinds.includes(rel.kind))
        .flatMap(rel =>
          rel.kind === 'connects'
            ? [`${rel.ids[0]}>${rel.ids[1]}`]
            : rel.kind === 'interacts'
              ? rel.ids.slice(1).map(id => `${rel.ids[0]}>${id}`)
              : rel.ids
                  .slice(1)
                  .filter(() => !ignoreWrapper || rel.ids[0] !== WRAPPER)
                  .map(id => `${id}<${rel.ids[0]}`),
        )
        .sort();
    const fromArchitecture = architecture.relationships.map(rel => {
      const [kind, body] = Object.entries(rel['relationship-type'])[0]!;
      const ids =
        kind === 'connects'
          ? [body.source.node, body.destination.node]
          : kind === 'interacts'
            ? [body.actor, ...body.nodes]
            : [body.container, ...body.nodes];
      return { kind: kind as CalmRel['kind'], ids };
    });
    const fromResult = rels(result);

    // Relationship endpoints: Rel lines say "Interacts With" for an actor, which the import reads as interacts.
    // three-tier-architecture joins deployment nodes, which the generator cannot draw: its picture has no Rel line.
    const drawn = markdown.includes('Rel(');
    expect(edges(fromResult, ['connects', 'interacts'])).toEqual(
      drawn ? edges(fromArchitecture, ['connects', 'interacts']) : [],
    );
    // Parents: composed-of in the architecture is a Deployment_Node in the picture, so the kind is not compared.
    expect(edges(fromResult, ['composed-of', 'deployed-in'], true)).toEqual(
      edges(fromArchitecture, ['composed-of', 'deployed-in']),
    );
  });
});
