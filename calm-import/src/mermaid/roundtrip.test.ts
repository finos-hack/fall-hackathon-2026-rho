import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertMermaid } from './index';

interface Calm {
  nodes: Array<Record<string, any>>;
  relationships: Array<Record<string, any>>;
}

const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

async function convert(name: string) {
  const result = await convertMermaid(fixture(name));
  return { result, calm: result.architecture as unknown as Calm };
}

const types = (calm: Calm) =>
  Object.fromEntries(calm.nodes.map(n => [n['unique-id'], n['node-type']]));

const edges = (calm: Calm) =>
  calm.relationships
    .filter(r => r['relationship-type'].connects)
    .map(r => {
      const c = r['relationship-type'].connects;
      return `${c.source.node} -> ${c.destination.node}${
        r.protocol ? ` (${r.protocol})` : ''
      }`;
    });

const interactions = (calm: Calm) =>
  calm.relationships
    .filter(r => r['relationship-type'].interacts)
    .map(r => ({ ...r['relationship-type'].interacts, description: r.description }));

const containment = (calm: Calm) =>
  calm.relationships
    .map(r => r['relationship-type'])
    .filter(t => t['composed-of'] || t['deployed-in'])
    .map(t => t['composed-of'] ?? t['deployed-in']);

describe('round trip: the block-architecture widget (calm-widgets, b6d71d52)', () => {
  it('gives back the node ids and types', async () => {
    const { calm } = await convert('block-architecture.mmd');
    // The widget's ids are the CALM unique-ids with `_` for `-`; the import slugs the names, so they come back as
    // the hyphenated ids.
    expect(types(calm)).toEqual({
      'trading-core': 'system',
      'order-service': 'service',
      'trades-db': 'database',
      'trade-events': 'system',
      trader: 'actor',
      'trading-ui': 'webclient',
      'risk-engine': 'system',
      'legacy-box': 'system',
    });
  });

  it('gives back the connections and the containment, and skips the interface', async () => {
    const { calm, result } = await convert('block-architecture.mmd');
    expect(edges(calm)).toEqual([
      'trader -> trading-ui',
      'trading-ui -> order-service (HTTPS)',
      'order-service -> trades-db (JDBC)',
      'order-service -> trade-events',
      'trade-events -> risk-engine',
    ]);
    expect(containment(calm)).toEqual([
      {
        container: 'trading-core',
        nodes: ['order-service', 'trades-db', 'trade-events'],
      },
    ]);
    expect(result.report).toMatch(/orders-api — interface/);
  });

  it('lists as guesses only what the widget does not say', async () => {
    const { result } = await convert('block-architecture.mmd');
    expect(result.guesses.map(g => g.replace(/ \(.*$/, ''))).toEqual([
      'Trading Core — node type: system',
      'Trading Core — containment: composed-of',
      'Trade Events — node type: system',
      'Legacy Box — node type: system',
      'Order Service → Trade Events — protocol: none',
    ]);
  });
});

describe('round trip: this repo’s entity card (calm-common/src/mermaid.ts)', () => {
  it('gives back the node types and names', async () => {
    const { calm } = await convert('calm-backstage-card.mmd');
    expect(types(calm)).toEqual({
      'k8s-cluster': 'network',
      'order-service': 'service',
      'risk-service': 'service',
      trader: 'actor',
      'trading-ui': 'webclient',
      'trades-db': 'database',
    });
    expect(calm.nodes.map(n => n.name)).toEqual([
      'K8s cluster',
      'Order Service',
      'Risk Service',
      'Trader',
      'Trading UI',
      'Trades DB',
    ]);
  });

  it('gives back the relationships, with protocols and the cluster', async () => {
    const { calm } = await convert('calm-backstage-card.mmd');
    expect(edges(calm)).toEqual([
      'trading-ui -> order-service (HTTPS)',
      'order-service -> trades-db (JDBC)',
      'order-service -> risk-service',
    ]);
    // The card draws `interacts` as a dotted edge from the actor, with the description as its label.
    expect(interactions(calm)).toEqual([
      { actor: 'trader', nodes: ['trading-ui'], description: 'Trades' },
    ]);
    expect(containment(calm)).toEqual([
      {
        container: 'k8s-cluster',
        nodes: ['order-service', 'risk-service'],
      },
    ]);
  });

  it('has no guess about a node type', async () => {
    const { result } = await convert('calm-backstage-card.mmd');
    expect(result.guesses.filter(g => /node type/.test(g))).toEqual([]);
  });
});

/*
 * The architecture calm-backstage-card-nested.mmd was drawn from with toMermaid. Its containers nest and one node has
 * two containers, so the card draws containment as dotted `-.-o|"composed of"|` / `-.-o|"deployed in"|` edges.
 */
const NESTED = {
  nodes: [
    { 'unique-id': 'trader', 'node-type': 'actor', name: 'Trader' },
    { 'unique-id': 'trading-ui', 'node-type': 'webclient', name: 'Trading UI' },
    { 'unique-id': 'k8s-cluster', 'node-type': 'network', name: 'K8s cluster' },
    { 'unique-id': 'trading-core', 'node-type': 'system', name: 'Trading Core' },
    { 'unique-id': 'order-service', 'node-type': 'service', name: 'Order Service' },
    { 'unique-id': 'trades-db', 'node-type': 'database', name: 'Trades DB' },
  ],
  relationships: [
    { description: 'Places trades', 'relationship-type': { interacts: { actor: 'trader', nodes: ['trading-ui'] } } },
    { protocol: 'HTTPS', 'relationship-type': { connects: { source: { node: 'trading-ui' }, destination: { node: 'order-service' } } } },
    { protocol: 'JDBC', 'relationship-type': { connects: { source: { node: 'order-service' }, destination: { node: 'trades-db' } } } },
    { 'relationship-type': { connects: { source: { node: 'trader' }, destination: { node: 'trades-db' } } } },
    { 'relationship-type': { 'composed-of': { container: 'trading-core', nodes: ['order-service', 'trades-db'] } } },
    { 'relationship-type': { 'deployed-in': { container: 'k8s-cluster', nodes: ['trading-core', 'order-service'] } } },
  ],
};

describe('round trip: this repo’s entity card with nested containment (dotted edges)', () => {
  it('gives back the node types', async () => {
    const { calm } = await convert('calm-backstage-card-nested.mmd');
    expect(types(calm)).toEqual(
      Object.fromEntries(NESTED.nodes.map(n => [n['unique-id'], n['node-type']])),
    );
  });

  it('gives back every relationship with its type, and no containment edge as connects', async () => {
    const { calm } = await convert('calm-backstage-card-nested.mmd');
    expect(edges(calm)).toEqual([
      'trading-ui -> order-service (HTTPS)',
      'order-service -> trades-db (JDBC)',
      'trader -> trades-db',
    ]);
    expect(interactions(calm)).toEqual([
      { actor: 'trader', nodes: ['trading-ui'], description: 'Places trades' },
    ]);
    expect(containment(calm)).toEqual([
      { container: 'trading-core', nodes: ['order-service', 'trades-db'] },
      { container: 'k8s-cluster', nodes: ['trading-core', 'order-service'] },
    ]);
    expect(
      calm.relationships
        .map(r => Object.keys(r['relationship-type'])[0])
        .filter(kind => kind === 'composed-of' || kind === 'deployed-in'),
    ).toEqual(['composed-of', 'deployed-in']);
  });

  it('decides the containment and the interaction by rule, with no guess', async () => {
    const { result } = await convert('calm-backstage-card-nested.mmd');
    expect(result.guesses).toEqual([]);
  });
});
