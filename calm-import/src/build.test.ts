// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import { build } from './build';
import type { Decision } from './decide';
import type { Arrow, Box, Diagram } from './diagram';

function box(
  id: string,
  label: string,
  geometry = { x: 0, y: 0, width: 100, height: 50 },
  extra: Partial<Box> = {},
): Box {
  return {
    id,
    label,
    shape: 'rectangle',
    geometry,
    isContainer: false,
    ...extra,
  };
}

function nodeType(targetId: string, value: string): Decision {
  return {
    kind: 'node-type',
    targetId,
    subject: targetId,
    value,
    options: [value],
    certain: true,
    reason: '',
  };
}

function diagram(boxes: Box[], arrows: Arrow[] = []): Diagram {
  return { boxes, arrows, annotations: [], pageNames: ['Page-1'] };
}

type Calm = {
  nodes: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  metadata: { _layout: Record<string, unknown> };
};

function run(d: Diagram, decisions: Decision[]) {
  const result = build(d, decisions);
  return { ...result, calm: result.architecture as unknown as Calm };
}

describe('build', () => {
  it('builds nodes with names, descriptions and node types', () => {
    const { calm, nodeCount } = run(
      diagram([box('a', 'Order Service\nTakes orders\nand fills them')]),
      [nodeType('a', 'service')],
    );
    expect(calm.nodes).toEqual([
      {
        'unique-id': 'order-service',
        'node-type': 'service',
        name: 'Order Service',
        description: 'Takes orders and fills them',
      },
    ]);
    expect(nodeCount).toBe(1);
    expect(calm).toHaveProperty(
      '$schema',
      expect.stringMatching(
        /^https:\/\/calm\.finos\.org\/release\/\d+\.\d+\/meta\/calm\.json$/,
      ),
    );
  });

  it('uses the name as the description for one-line labels', () => {
    const { calm } = run(diagram([box('a', 'Trades DB')]), [
      nodeType('a', 'database'),
    ]);
    expect(calm.nodes[0]).toMatchObject({
      name: 'Trades DB',
      description: 'Trades DB',
    });
  });

  it('keeps a custom node type', () => {
    const { calm } = run(diagram([box('a', 'Trade Events')]), [
      nodeType('a', 'message-queue'),
    ]);
    expect(calm.nodes[0]).toMatchObject({ 'node-type': 'message-queue' });
  });

  it('names unlabelled boxes by node type and notes it', () => {
    const { calm, notes } = run(diagram([box('a', ''), box('b', '')]), [
      nodeType('a', 'service'),
      nodeType('b', 'service'),
    ]);
    expect(calm.nodes.map(n => [n['unique-id'], n.name])).toEqual([
      ['service-1', 'Service 1'],
      ['service-2', 'Service 2'],
    ]);
    expect(notes).toContainEqual({
      subject: 'cell a',
      message: 'no label, named "Service 1"',
      kind: 'adjusted',
    });
  });

  it('builds connects with protocol only when not none', () => {
    const arrows: Arrow[] = [
      { id: 'e1', label: 'HTTPS', sourceId: 'a', targetId: 'b', heads: 'end' },
      { id: 'e2', label: 'Kafka', sourceId: 'b', targetId: 'a', heads: 'end' },
      { id: 'e3', label: '', sourceId: 'a', targetId: 'b', heads: 'end' },
    ];
    const decisions: Decision[] = [
      nodeType('a', 'service'),
      nodeType('b', 'service'),
      {
        kind: 'protocol',
        targetId: 'e1',
        subject: '',
        value: 'HTTPS',
        options: [],
        certain: true,
        reason: '',
      },
      {
        kind: 'protocol',
        targetId: 'e2',
        subject: '',
        value: 'none',
        options: [],
        certain: false,
        reason: '',
      },
    ];
    const { calm, relationshipCount } = run(
      diagram([box('a', 'A'), box('b', 'B')], arrows),
      decisions,
    );
    expect(calm.relationships).toEqual([
      {
        'unique-id': 'a-to-b',
        description: 'HTTPS',
        protocol: 'HTTPS',
        'relationship-type': {
          connects: { source: { node: 'a' }, destination: { node: 'b' } },
        },
      },
      {
        'unique-id': 'b-to-a',
        description: 'Kafka',
        'relationship-type': {
          connects: { source: { node: 'b' }, destination: { node: 'a' } },
        },
      },
      {
        'unique-id': 'a-to-b-2',
        'relationship-type': {
          connects: { source: { node: 'a' }, destination: { node: 'b' } },
        },
      },
    ]);
    expect(relationshipCount).toBe(3);
  });

  it('does not output arrows with a missing end', () => {
    const { calm } = run(
      diagram(
        [box('a', 'A')],
        [{ id: 'e', label: '', sourceId: 'a', heads: 'end' }],
      ),
      [nodeType('a', 'service')],
    );
    expect(calm.relationships).toEqual([]);
  });

  it('builds one containment relationship per container with direct children only', () => {
    const boxes = [
      box(
        'r',
        'Region',
        { x: 0, y: 0, width: 800, height: 600 },
        { isContainer: true },
      ),
      box(
        'k',
        'Cluster',
        { x: 50, y: 50, width: 400, height: 300 },
        { isContainer: true, containerId: 'r' },
      ),
      box(
        's',
        'Svc',
        { x: 100, y: 100, width: 100, height: 50 },
        { containerId: 'k' },
      ),
      box(
        't',
        'Other',
        { x: 500, y: 400, width: 100, height: 50 },
        { containerId: 'r' },
      ),
    ];
    const decisions: Decision[] = [
      nodeType('r', 'network'),
      nodeType('k', 'network'),
      nodeType('s', 'service'),
      nodeType('t', 'service'),
      {
        kind: 'containment',
        targetId: 'r',
        subject: '',
        value: 'deployed-in',
        options: [],
        certain: true,
        reason: '',
      },
      {
        kind: 'containment',
        targetId: 'k',
        subject: '',
        value: 'composed-of',
        options: [],
        certain: true,
        reason: '',
      },
    ];
    const { calm } = run(diagram(boxes), decisions);
    expect(calm.relationships).toEqual([
      {
        'unique-id': 'region-deployed-in',
        'relationship-type': {
          'deployed-in': { container: 'region', nodes: ['cluster', 'other'] },
        },
      },
      {
        'unique-id': 'cluster-composed-of',
        'relationship-type': {
          'composed-of': { container: 'cluster', nodes: ['svc'] },
        },
      },
    ]);
  });

  it('makes ids unique and non-empty', () => {
    const boxes = [
      box('a', 'API'),
      box('b', 'API'),
      box('c', '!!!'),
      box('d', '数据库'),
    ];
    const { calm, notes } = run(
      diagram(boxes),
      boxes.map(b => nodeType(b.id, 'service')),
    );
    const ids = calm.nodes.map(n => n['unique-id'] as string);
    expect(ids.slice(0, 2)).toEqual(['api', 'api-2']);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every(id => id.length > 0)).toBe(true);
    expect(notes).toContainEqual({
      subject: 'API',
      message: 'id "api" was taken, used "api-2"',
      kind: 'adjusted',
    });
  });

  it('slugs a custom node type used as an id fallback', () => {
    const { calm } = run(diagram([box('a', '数据库')]), [
      nodeType('a', 'Message Queue'),
    ]);
    expect(calm.nodes[0]!['unique-id']).toBe('message-queue');
  });

  it('writes _layout relative to the container', () => {
    const boxes = [
      box(
        'k',
        'Cluster',
        { x: 100, y: 100, width: 400, height: 300 },
        { isContainer: true },
      ),
      box(
        's',
        'Svc',
        { x: 150.4, y: 180.6, width: 120, height: 60 },
        { containerId: 'k' },
      ),
    ];
    const decisions: Decision[] = [
      nodeType('k', 'network'),
      nodeType('s', 'service'),
      {
        kind: 'containment',
        targetId: 'k',
        subject: '',
        value: 'deployed-in',
        options: [],
        certain: true,
        reason: '',
      },
    ];
    const { calm } = run(diagram(boxes), decisions);
    expect(calm.metadata._layout).toEqual({
      cluster: { x: 100, y: 100, w: 400, h: 300 },
      svc: { x: 50, y: 81, w: 120, h: 60 },
    });
  });

  it('leaves out metadata when no box has a geometry', () => {
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    const { calm } = run(diagram([box('a', 'A', zero), box('b', 'B', zero)]), [
      nodeType('a', 'service'),
      nodeType('b', 'service'),
    ]);
    expect(calm).not.toHaveProperty('metadata');
  });

  it('keeps metadata when at least one box has a geometry', () => {
    const zero = { x: 0, y: 0, width: 0, height: 0 };
    const { calm } = run(diagram([box('a', 'A', zero), box('b', 'B')]), [
      nodeType('a', 'service'),
      nodeType('b', 'service'),
    ]);
    expect(calm.metadata._layout).toHaveProperty('b');
  });

  it('counts clashing ids up without reusing one that is taken', () => {
    const boxes = ['API', 'API', 'API', 'API 2', 'API'].map((label, n) =>
      box(`b${n}`, label),
    );
    const { calm } = run(
      diagram(boxes),
      boxes.map(b => nodeType(b.id, 'service')),
    );
    expect(calm.nodes.map(n => n['unique-id'])).toEqual([
      'api',
      'api-2',
      'api-3',
      'api-2-2',
      'api-4',
    ]);
  });
});
