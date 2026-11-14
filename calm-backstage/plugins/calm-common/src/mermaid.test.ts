import { readFileSync } from 'fs';
import { resolve } from 'path';
import { escapeMermaidLabel, toMermaid } from './mermaid';

// The step-5 fixture: unmodified `calm generate` output (see placeholders.test.ts for the command).
const generated = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '__fixtures__/generated-web-service-postgresql-cache.json',
    ),
    'utf-8',
  ),
);

describe('toMermaid', () => {
  it('draws every node and connection of a generated architecture', () => {
    const result = toMermaid(generated);
    const lines = result.source.trim().split('\n');
    expect(lines[0]).toBe('flowchart LR');
    expect(result.nodeCount).toBe(5);
    expect(result.drawnRelationships).toBe(4);
    // The two `options` relationships (decision records) are not drawn.
    expect(result.skippedRelationships).toBe(2);

    expect(lines).toEqual(
      expect.arrayContaining([
        '  n0("Web Client<br/><i>webclient</i>")',
        '  n1[["API Gateway<br/><i>system</i>"]]',
        '  n2["Web Service<br/><i>service</i>"]',
        '  n3[("PostgreSQL<br/><i>database</i>")]',
        '  n4["Redis Cache<br/><i>service</i>"]',
        '  n0 -->|"HTTPS"| n1',
        '  n1 -->|"HTTPS"| n2',
        '  n2 -->|"JDBC"| n3',
        '  n2 -->|"TCP"| n4',
      ]),
    );
    expect(lines).toHaveLength(1 + 5 + 4);
  });

  it('draws interacts as dotted edges and skips edges to unknown nodes', () => {
    const { source, skippedRelationships } = toMermaid(
      {
        nodes: [
          { 'unique-id': 'end', 'node-type': 'actor', name: 'User' },
          { 'unique-id': 'app', 'node-type': 'service', name: 'App' },
        ],
        relationships: [
          {
            'unique-id': 'r1',
            description: 'Uses',
            'relationship-type': {
              interacts: { actor: 'end', nodes: ['app'] },
            },
          },
          {
            'unique-id': 'r2',
            'relationship-type': {
              connects: {
                source: { node: 'app' },
                destination: { node: 'missing' },
              },
            },
          },
        ],
      },
      { direction: 'TB' },
    );
    expect(source).toContain('flowchart TB');
    expect(source).toContain('  n0 -.->|"Uses"| n1');
    expect(source).not.toContain('missing');
    expect(skippedRelationships).toBe(1);
  });

  it('draws flat composed-of as a subgraph, nested containment as edges', () => {
    const nodes = [
      { 'unique-id': 'sys', 'node-type': 'system', name: 'System' },
      { 'unique-id': 'a', 'node-type': 'service', name: 'A' },
      { 'unique-id': 'b', 'node-type': 'service', name: 'B' },
    ];
    const flat = toMermaid({
      nodes,
      relationships: [
        {
          'unique-id': 'c',
          'relationship-type': {
            'composed-of': { container: 'sys', nodes: ['a', 'b'] },
          },
        },
      ],
    }).source;
    expect(flat).toContain('  subgraph n0["System"]');
    expect(flat).toContain('    n1["A<br/><i>service</i>"]');
    expect(flat).toContain('  end');

    const nested = toMermaid({
      nodes,
      relationships: [
        {
          'unique-id': 'c1',
          'relationship-type': {
            'composed-of': { container: 'sys', nodes: ['a'] },
          },
        },
        {
          'unique-id': 'c2',
          'relationship-type': {
            'deployed-in': { container: 'a', nodes: ['b'] },
          },
        },
      ],
    }).source;
    expect(nested).not.toContain('subgraph');
    expect(nested).toContain('  n0 -.-o|"composed of"| n1');
    expect(nested).toContain('  n1 -.-o|"deployed in"| n2');
  });

  it('escapes labels', () => {
    expect(escapeMermaidLabel('a "b" <c> | #d & `e`')).toBe(
      'a #quot;b#quot; #lt;c#gt; #124; #35;d #amp; #96;e#96;',
    );
    const { source } = toMermaid({
      nodes: [
        { 'unique-id': 'x"]; click', 'node-type': 'service', name: '<b>x</b>' },
      ],
    });
    expect(source).toContain('  n0["#lt;b#gt;x#lt;/b#gt;<br/><i>service</i>"]');
  });

  it('returns an empty flowchart for a document without nodes', () => {
    expect(toMermaid(undefined).source).toBe('flowchart LR\n');
  });
});
