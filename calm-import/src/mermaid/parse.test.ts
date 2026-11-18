import { flowchartExtras, parseFlowchart } from './parse';

const shapeOf = (text: string, id = 'A') =>
  parseFlowchart(`flowchart LR\n${text}`).boxes.find(b => b.id === id)?.shape;

describe('parseFlowchart shapes', () => {
  it.each([
    ['A[Name]', 'rectangle'],
    ['A[(Name)]', 'cylinder'],
    ['A((Name))', 'ellipse'],
    ['A{Name}', 'diamond'],
    ['A{{Name}}', 'hexagon'],
    ['A([Name])', 'rounded-rectangle'],
    ['A(Name)', 'rounded-rectangle'],
    ['A[[Name]]', 'rectangle'],
    ['A[/Name/]', 'parallelogram'],
    ['A[\\Name\\]', 'parallelogram'],
    ['A>Name]', 'rectangle'],
    ['A@{ shape: h-cyl }', 'queue'],
    ['A@{ shape: cyl }', 'cylinder'],
    ['A@{ shape: doc }', 'document'],
    ['A@{ shape: cloud }', 'cloud'],
    ['A@{ shape: something-new }', 'unknown'],
  ])('%s is %s', (text, shape) => {
    expect(shapeOf(text)).toBe(shape);
  });

  it('reads the label from a quoted label, with <br/> as a new line', () => {
    const { boxes } = parseFlowchart('flowchart LR\nA["Orders<br/>(main)"]');
    expect(boxes[0]).toMatchObject({
      id: 'A',
      label: 'Orders\n(main)',
      geometry: { x: 0, y: 0, width: 0, height: 0 },
      isContainer: false,
    });
  });

  it('reads brackets and semicolons inside a quoted label', () => {
    const { boxes } = parseFlowchart('flowchart LR\nA["a]; b"]; B');
    expect(boxes.map(b => b.label)).toEqual(['a]; b', 'B']);
  });

  it('reads the label and shape of a @{ } node', () => {
    const { boxes } = parseFlowchart(
      'flowchart LR\nQ@{ shape: h-cyl, label: "Trade, Events" }',
    );
    expect(boxes[0]).toMatchObject({ label: 'Trade, Events', shape: 'queue' });
  });

  it('uses the id as the label of a node that is only named', () => {
    const { boxes } = parseFlowchart('flowchart LR\nA --> B');
    expect(boxes.map(b => b.label)).toEqual(['A', 'B']);
  });

  it('lets a later definition give a named node its label', () => {
    const { boxes } = parseFlowchart('flowchart LR\nA --> B\nB[(Orders DB)]');
    expect(boxes[1]).toMatchObject({ label: 'Orders DB', shape: 'cylinder' });
  });

  it('decodes Mermaid entity codes and strips other tags', () => {
    const { boxes } = parseFlowchart(
      'flowchart LR\nA["a #124; b #35;1 #quot;q#quot; <b>bold</b> #lt;x#gt;"]',
    );
    expect(boxes[0]!.label).toBe('a | b #1 "q" bold <x>');
  });

  it('removes the emoji prefixes of the block-architecture widget', () => {
    const labels = parseFlowchart(
      [
        'flowchart TB',
        'a([👤 Trader])',
        'b[(🗄️ Trades DB)]',
        'c[[💻 UI]]',
        'd[/"⚙️ Order"/]',
        'e[🏢 Core]',
        'f@{shape: h-cyl, label: "📨 Events"}',
      ].join('\n'),
    ).boxes.map(b => b.label);
    expect(labels).toEqual([
      'Trader',
      'Trades DB',
      'UI',
      'Order',
      'Core',
      'Events',
    ]);
  });
});

describe('parseFlowchart edges', () => {
  const heads = (edge: string) =>
    parseFlowchart(`flowchart LR\nA ${edge} B`).arrows.map(a => a.heads);

  it.each([
    ['-->', 'end'],
    ['---', 'none'],
    ['-.->', 'end'],
    ['-.-', 'none'],
    ['==>', 'end'],
    ['===', 'none'],
    ['<-->', 'both'],
    ['--o', 'end'],
    ['--x', 'end'],
    ['---->', 'end'],
    ['-- text -->', 'end'],
    ['-- text ---', 'none'],
    ['-. text .->', 'end'],
    ['== text ==>', 'end'],
    ['-->|text|', 'end'],
  ])('%s gives heads %s', (edge, expected) => {
    expect(heads(edge)).toEqual([expected]);
  });

  it('draws no arrow for ~~~', () => {
    const d = parseFlowchart('flowchart LR\nA ~~~ B');
    expect(d.arrows).toEqual([]);
    expect(d.boxes).toHaveLength(2);
  });

  it('reads edge labels in both forms', () => {
    const d = parseFlowchart(
      'flowchart LR\nA -->|HTTPS| B\nB -- JDBC --> C\nC -->|"a | b"| D',
    );
    expect(d.arrows.map(a => a.label)).toEqual(['HTTPS', 'JDBC', 'a | b']);
  });

  it('reads the label of a dotted and of a thick edge written with text', () => {
    const d = parseFlowchart(
      'flowchart LR\nA -. via VPN .-> B\nB == bulk load ==> C',
    );
    expect(d.arrows.map(a => [a.label, a.heads])).toEqual([
      ['via VPN', 'end'],
      ['bulk load', 'end'],
    ]);
  });

  it('points an edge with a head only at its start the other way', () => {
    const d = parseFlowchart('flowchart LR\nA o--- B');
    expect(d.arrows[0]).toMatchObject({ sourceId: 'B', targetId: 'A' });
  });

  it('keeps the source and target of an edge', () => {
    const d = parseFlowchart('flowchart LR\nA --> B');
    expect(d.arrows[0]).toMatchObject({ sourceId: 'A', targetId: 'B' });
  });

  it('reads a chain as one arrow per link', () => {
    const d = parseFlowchart('flowchart LR\nA --> B --> C');
    expect(d.arrows.map(a => [a.sourceId, a.targetId])).toEqual([
      ['A', 'B'],
      ['B', 'C'],
    ]);
  });

  it('reads A & B --> C as two arrows', () => {
    const d = parseFlowchart('flowchart LR\nA & B --> C');
    expect(d.arrows.map(a => [a.sourceId, a.targetId])).toEqual([
      ['A', 'C'],
      ['B', 'C'],
    ]);
  });

  it('reads ids that contain a hyphen or a dot', () => {
    const d = parseFlowchart('flowchart LR\norder-svc --> db.main');
    expect(d.boxes.map(b => b.id)).toEqual(['order-svc', 'db.main']);
  });

  it('reads edges written without spaces', () => {
    const d = parseFlowchart('flowchart LR\nA-->B\nB-.->C');
    expect(d.arrows).toHaveLength(2);
  });
});

describe('parseFlowchart subgraphs', () => {
  it('makes a subgraph a container of what it holds, and nests', () => {
    const d = parseFlowchart(
      [
        'flowchart LR',
        'subgraph outer [Outer]',
        '  A',
        '  subgraph inner ["Inner"]',
        '    B',
        '  end',
        'end',
        'C',
      ].join('\n'),
    );
    const box = (id: string) => d.boxes.find(b => b.id === id)!;
    expect(box('outer')).toMatchObject({ label: 'Outer', isContainer: true });
    expect(box('inner')).toMatchObject({
      label: 'Inner',
      isContainer: true,
      containerId: 'outer',
    });
    expect(box('A').containerId).toBe('outer');
    expect(box('B').containerId).toBe('inner');
    expect(box('C').containerId).toBeUndefined();
  });

  it('uses the title as id and label of a subgraph with no id', () => {
    const d = parseFlowchart('flowchart LR\nsubgraph Cluster\nA\nend');
    expect(d.boxes[0]).toMatchObject({ id: 'Cluster', label: 'Cluster' });
  });

  it('keeps an edge to a subgraph', () => {
    const d = parseFlowchart(
      'flowchart LR\nA --> sg\nsubgraph sg [Group]\nB\nend',
    );
    expect(d.arrows[0]).toMatchObject({ sourceId: 'A', targetId: 'sg' });
    expect(d.boxes.find(b => b.id === 'sg')).toMatchObject({
      label: 'Group',
      isContainer: true,
    });
  });

  it('puts a node named inside a subgraph into it', () => {
    const d = parseFlowchart(
      'flowchart LR\nA[Alpha]\nsubgraph s\nA --> B\nend',
    );
    expect(d.boxes.find(b => b.id === 'A')!.containerId).toBe('s');
    expect(d.boxes.find(b => b.id === 'B')!.containerId).toBe('s');
  });

  it('does not put a subgraph inside itself', () => {
    const d = parseFlowchart('flowchart LR\nsubgraph s\ns --> A\nend');
    expect(d.boxes.find(b => b.id === 's')!.containerId).toBeUndefined();
  });

  it('does not make containers contain each other', () => {
    const d = parseFlowchart(
      'flowchart LR\nsubgraph x\ny\nend\nsubgraph y\nx\nend',
    );
    const [x, y] = ['x', 'y'].map(id => d.boxes.find(b => b.id === id)!);
    expect(x!.containerId === 'y' && y!.containerId === 'x').toBe(false);
  });
});

describe('parseFlowchart ignored and kept lines', () => {
  it('ignores comments, styling, click, direction and front matter', () => {
    const d = parseFlowchart(
      [
        '---',
        'title: t',
        '---',
        '%%{init: {"theme": "dark"}}%%',
        'flowchart TB',
        '%% a comment',
        'classDef big fill:#f9f',
        'A[One] --> B[Two]',
        'style A fill:#f9f',
        'linkStyle 0 stroke:red',
        'click A href "https://example.com"',
        'direction LR',
      ].join('\n'),
    );
    expect(d.boxes.map(b => b.label)).toEqual(['One', 'Two']);
    expect(d.arrows).toHaveLength(1);
  });

  it('keeps :::class and class statements for the converter', () => {
    const d = parseFlowchart(
      'flowchart LR\nA[One]:::database\nB\nC\nclass B,C service',
    );
    const { classes } = flowchartExtras(d);
    expect(classes.get('A')).toEqual(['database']);
    expect(classes.get('B')).toEqual(['service']);
    expect(classes.get('C')).toEqual(['service']);
  });

  it('keeps an italic type line apart from the name', () => {
    const d = parseFlowchart(
      'flowchart LR\nA["Orders<br/><i>service</i>"]\nB["Plain <i>word</i>"]',
    );
    expect(d.boxes[0]!.label).toBe('Orders');
    expect(flowchartExtras(d).typeLines.get('A')).toBe('service');
    expect(d.boxes[1]!.label).toBe('Plain word');
    expect(flowchartExtras(d).typeLines.has('B')).toBe(false);
  });

  it('reads CRLF, tabs, a BOM, trailing semicolons and statements on a line', () => {
    const d = parseFlowchart(
      '﻿graph TD;\r\n\tA[One]; B[Two];\r\n\tA --> B;\r\n',
    );
    expect(d.boxes.map(b => b.label)).toEqual(['One', 'Two']);
    expect(d.arrows).toHaveLength(1);
  });

  it('reads CRLF lines with bare ids', () => {
    const d = parseFlowchart('flowchart LR\r\nA --> B\r\nB --> C\r\n');
    expect(d.boxes.map(b => b.id)).toEqual(['A', 'B', 'C']);
    expect(d.arrows).toHaveLength(2);
  });

  it('reads graph, with or without a direction', () => {
    expect(parseFlowchart('graph\nA --> B').arrows).toHaveLength(1);
    expect(parseFlowchart('graph RL\nA --> B').arrows).toHaveLength(1);
  });
});

describe('parseFlowchart errors', () => {
  it('refuses another diagram type', () => {
    expect(() => parseFlowchart('sequenceDiagram\nA->>B: hi')).toThrow(
      'Only Mermaid flowcharts are supported here (flowchart or graph); got sequenceDiagram',
    );
  });

  it('points a C4 diagram to the C4 format', () => {
    expect(() => parseFlowchart('C4Context\nPerson(a, "A")')).toThrow(
      'Only Mermaid flowcharts are supported here (flowchart or graph); got C4Context; this looks like C4 (Mermaid or PlantUML): choose "C4 (Mermaid or PlantUML)" as the format',
    );
  });

  it('names the line of a subgraph with no end', () => {
    expect(() => parseFlowchart('flowchart LR\nA\nsubgraph s [S]\nB')).toThrow(
      /subgraph "S".*line 3.*no end/i,
    );
  });

  it('refuses an end with no subgraph', () => {
    expect(() => parseFlowchart('flowchart LR\nA\nend')).toThrow(/line 3/);
  });

  it('names the line of an unclosed bracket', () => {
    expect(() => parseFlowchart('flowchart LR\nA --> B\nC[oops')).toThrow(
      /line 3/,
    );
  });

  it('names the line of an edge with no target', () => {
    expect(() => parseFlowchart('flowchart LR\nA -->')).toThrow(/line 2/);
  });

  it('counts lines from the first line given', () => {
    expect(() => parseFlowchart('flowchart LR\nC[oops', 10)).toThrow(/line 11/);
  });

  it('allows 50 levels of subgraphs and refuses 51', () => {
    const nest = (depth: number) =>
      [
        'flowchart LR',
        ...Array.from({ length: depth }, (_, i) => `subgraph s${i}`),
        'A',
        ...Array.from({ length: depth }, () => 'end'),
      ].join('\n');
    expect(parseFlowchart(nest(50)).boxes).toHaveLength(51);
    expect(() => parseFlowchart(nest(51))).toThrow(
      'Nesting deeper than 50 levels at line 52',
    );
  });
});
