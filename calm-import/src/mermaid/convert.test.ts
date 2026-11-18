import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMermaid } from './index';

interface Calm {
  nodes: Array<Record<string, any>>;
  relationships: Array<Record<string, any>>;
  metadata?: unknown;
}

const nodeTypes = (calm: Calm) =>
  Object.fromEntries(calm.nodes.map(n => [n['unique-id'], n['node-type']]));

const connects = (calm: Calm) =>
  calm.relationships
    .filter(r => r['relationship-type'].connects)
    .map(r => {
      const c = r['relationship-type'].connects;
      return [c.source.node, c.destination.node, r.protocol, r.description];
    });

async function convert(text: string) {
  const result = await convertMermaid(text);
  return { result, calm: result.architecture as unknown as Calm };
}

describe('convertMermaid with the draw.io rules', () => {
  it('turns shapes, labels and edge labels into node types and protocols', async () => {
    const { calm, result } = await convert(
      [
        'flowchart LR',
        'U((Customer)) --> UI[Trading UI]',
        'UI -->|HTTPS| Orders[Order Service]',
        'Orders -->|JDBC| DB[(Orders DB)]',
        'Orders -->|Kafka| Bus@{ shape: h-cyl, label: "Trade Events" }',
      ].join('\n'),
    );
    expect(nodeTypes(calm)).toEqual({
      customer: 'actor',
      'trading-ui': 'webclient',
      'order-service': 'service',
      'orders-db': 'database',
      'trade-events': 'system',
    });
    expect(connects(calm)).toEqual([
      ['customer', 'trading-ui', undefined, undefined],
      ['trading-ui', 'order-service', 'HTTPS', 'HTTPS'],
      ['order-service', 'orders-db', 'JDBC', 'JDBC'],
      ['order-service', 'trade-events', undefined, 'Kafka'],
    ]);
    expect(result.nodes).toBe(5);
    expect(result.relationships).toBe(4);
    expect(result.guesses.join('\n')).toMatch(/Trade Events — node type/);
    expect(result.guesses.join('\n')).toMatch(/"Kafka" is not a CALM protocol/);
  });

  it('makes a subgraph named like a cluster a deployed-in container', async () => {
    const { calm } = await convert(
      [
        'flowchart LR',
        'subgraph cluster [K8s cluster]',
        '  S[Order Service]',
        'end',
      ].join('\n'),
    );
    expect(nodeTypes(calm)).toMatchObject({ 'k8s-cluster': 'network' });
    expect(calm.relationships).toEqual([
      expect.objectContaining({
        'relationship-type': {
          'deployed-in': {
            container: 'k8s-cluster',
            nodes: ['order-service'],
          },
        },
      }),
    ]);
  });

  it('keeps an edge to a subgraph', async () => {
    const { calm } = await convert(
      'flowchart LR\nA[Caller] --> sg\nsubgraph sg [Backend]\nB[Worker]\nend',
    );
    expect(connects(calm)).toEqual([
      ['caller', 'backend', undefined, undefined],
    ]);
  });

  it('keeps one direction for a two-headed arrow and says so', async () => {
    const { calm, result } = await convert('flowchart LR\nA[One] <--> B[Two]');
    expect(connects(calm)).toHaveLength(1);
    expect(result.report).toMatch(
      /One ↔ Two — two-headed arrow, kept the drawn direction/,
    );
  });

  it('writes no metadata, so no _layout', async () => {
    const { calm } = await convert('flowchart LR\nA --> B');
    expect(calm).not.toHaveProperty('metadata');
    expect(calm).toHaveProperty(
      '$schema',
      'https://calm.finos.org/release/1.3/meta/calm.json',
    );
  });

  it('names an empty label with Mermaid wording, not draw.io cells', async () => {
    const { calm, result } = await convert('flowchart LR\na[""] --> b[Two]');
    expect(calm.nodes[0]!.name).toBe('System 1');
    expect(result.report).toMatch(/node a — no label, named "System 1"/);
    expect(result.report).not.toMatch(/cell/);
  });

  it('refuses a flowchart with no nodes', async () => {
    await expect(convertMermaid('flowchart LR\n')).rejects.toThrow(/no nodes/);
  });
});

describe('convertMermaid in Markdown', () => {
  it('converts the first flowchart block, after a C4 block, and reports the rest', async () => {
    const { calm, result } = await convert(
      [
        '# Docs',
        '```mermaid',
        'C4Context',
        '  Person(a, "A")',
        '```',
        '',
        '```mermaid',
        'flowchart LR',
        '  X[One] --> Y[Two]',
        '```',
        '```mermaid',
        'flowchart LR',
        '  P --> Q',
        '```',
      ].join('\n'),
    );
    expect(calm.nodes.map(n => n.name)).toEqual(['One', 'Two']);
    expect(result.report).toMatch(/diagram block at line 3 — not converted/);
    expect(result.report).toMatch(/diagram block at line 12 — not converted/);
  });

  it('counts error lines in the whole file', async () => {
    await expect(
      convertMermaid('# Docs\n\n```mermaid\nflowchart LR\nA[oops\n```\n'),
    ).rejects.toThrow(/line 5/);
  });

  it('points a lone C4 block to the C4 format', async () => {
    await expect(
      convertMermaid('```mermaid\nC4Context\nPerson(a, "A")\n```'),
    ).rejects.toThrow(/choose "C4 \(Mermaid or PlantUML\)" as the format/);
  });

  it('says a Markdown file with no mermaid block has no flowchart', async () => {
    await expect(
      convertMermaid('# Design notes\n\nNo diagram here.'),
    ).rejects.toThrow(/^No Mermaid flowchart found \(flowchart or graph\)$/);
  });

  it('points a C4-PlantUML file to the C4 format', async () => {
    await expect(
      convertMermaid('@startuml\nPerson(a, "A")\n@enduml'),
    ).rejects.toThrow(
      'No Mermaid flowchart found (flowchart or graph); this looks like C4 (Mermaid or PlantUML): choose "C4 (Mermaid or PlantUML)" as the format',
    );
  });

  it('points a draw.io file to the draw.io format', async () => {
    await expect(
      convertMermaid('<mxfile><diagram/></mxfile>'),
    ).rejects.toThrow(
      'No Mermaid flowchart found (flowchart or graph); this looks like draw.io: choose "draw.io" as the format',
    );
  });

  it('refuses another diagram type', async () => {
    await expect(convertMermaid('sequenceDiagram\nA->>B: hi')).rejects.toThrow(
      'Only Mermaid flowcharts are supported here (flowchart or graph); got sequenceDiagram',
    );
  });
});

describe('convertMermaid round-trip rules', () => {
  it('keeps a solid circle-headed "composed of" edge, and a dotted edge from a non-actor, as connects', async () => {
    const { calm } = await convert(
      'flowchart LR\nA["A<br/><i>system</i>"] --o|"composed of"| B["B<br/><i>service</i>"]\nB -.->|"calls"| C["C<br/><i>service</i>"]',
    );
    expect(
      calm.relationships.map(r => Object.keys(r['relationship-type'])[0]),
    ).toEqual(['connects', 'connects']);
  });

  it('keeps a dotted edge labelled "composed of" with an arrow head as connects', async () => {
    const { calm } = await convert(
      'flowchart LR\nA["A<br/><i>system</i>"] -.->|"composed of"| B["B<br/><i>service</i>"]',
    );
    expect(Object.keys(calm.relationships[0]!['relationship-type'])).toEqual([
      'connects',
    ]);
  });

  it('takes the node type from an italic type line, as a rule', async () => {
    const { calm, result } = await convert(
      'flowchart LR\nA["Billing<br/><i>service</i>"]\nB["Ledger<br/><i>datastore</i>"]',
    );
    expect(calm.nodes[0]).toMatchObject({
      name: 'Billing',
      'node-type': 'service',
    });
    expect(calm.nodes[1]).toMatchObject({
      name: 'Ledger',
      'node-type': 'datastore',
    });
    expect(result.guesses).toEqual([]);
  });

  it('prefers the type line to what the shape and name suggest', async () => {
    const { calm } = await convert(
      'flowchart LR\nA[("Orders DB<br/><i>service</i>")]',
    );
    expect(calm.nodes[0]!['node-type']).toBe('service');
  });

  it('does not take a phrase in italics for a node type', async () => {
    const { calm } = await convert(
      'flowchart LR\nA["Billing<br/><i>runs in the EU</i>"]',
    );
    expect(calm.nodes[0]).toMatchObject({
      'node-type': 'system',
      description: 'runs in the EU',
    });
  });

  it('takes a CALM node type from a class, as a rule', async () => {
    const { calm, result } = await convert(
      [
        'flowchart LR',
        'A[Alpha]:::database',
        'B[Beta]:::webclient',
        'C[Gamma]',
        'D[Delta]:::highlight',
        'class C actor',
      ].join('\n'),
    );
    expect(nodeTypes(calm)).toEqual({
      alpha: 'database',
      beta: 'webclient',
      gamma: 'actor',
      delta: 'system',
    });
    expect(result.guesses.join('\n')).not.toMatch(/Alpha|Beta|Gamma/);
  });

  it('removes the emoji prefixes from the names', async () => {
    const { calm } = await convert(
      'flowchart TB\na([👤 Trader]):::actor\nb[(🗄️ Trades DB)]:::database',
    );
    expect(calm.nodes.map(n => n.name)).toEqual(['Trader', 'Trades DB']);
  });

  it('skips interface nodes and the dotted edges to them, and says so', async () => {
    const { calm, result } = await convert(
      [
        'flowchart TB',
        'a["Orders"]:::node',
        'a_iface["orders-api"]:::iface',
        'b["Web"]:::node',
        'a -.- a_iface',
        'b --> a',
      ].join('\n'),
    );
    expect(calm.nodes.map(n => n.name)).toEqual(['Orders', 'Web']);
    expect(calm.relationships).toHaveLength(1);
    expect(result.report).toMatch(/orders-api — interface/);
  });
});

describe('the trading sample', () => {
  it('converts examples/trading.mmd into 7 nodes and 7 relationships', async () => {
    const text = readFileSync(
      join(__dirname, '../../examples/trading.mmd'),
      'utf-8',
    );
    const { calm, result } = await convert(text);
    expect(result.nodes).toBe(7);
    expect(result.relationships).toBe(7);
    expect(nodeTypes(calm)).toEqual({
      trader: 'actor',
      'trading-ui': 'webclient',
      'trades-db': 'database',
      'kubernetes-cluster': 'network',
      'order-service': 'service',
      'trade-events': 'system',
      'risk-service': 'service',
    });
    // The trader's dotted edge is an interacts, as in trading.c4.md.
    expect(
      calm.relationships
        .filter(r => r['relationship-type'].interacts)
        .map(r => [r['relationship-type'].interacts, r.description]),
    ).toEqual([[{ actor: 'trader', nodes: ['trading-ui'] }, 'Uses']]);
    expect(connects(calm).map(c => c.slice(0, 3))).toEqual([
      ['trading-ui', 'order-service', 'HTTPS'],
      ['order-service', 'trades-db', 'JDBC'],
      ['order-service', 'trade-events', undefined],
      ['trade-events', 'risk-service', 'AMQP'],
      ['order-service', 'risk-service', undefined],
    ]);
    expect(result.report).toMatch(/Trade Events — node type: system/);
    // Only the queue and Kafka are guesses, as in trading.drawio.
    expect(result.guesses.map(g => g.replace(/ \(.*$/, ''))).toEqual([
      'Trade Events — node type: system',
      'Order Service → Trade Events — protocol: none',
    ]);
  });
});
