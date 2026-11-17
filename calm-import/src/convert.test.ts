import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { convertDrawio } from './index';

const SAMPLE = readFileSync(
  join(__dirname, '../examples/trading.drawio'),
  'utf-8',
);

/** What draw.io desktop saves: the page XML URI-encoded, raw-deflated and base64-encoded inside `<diagram>`. */
function compressed(text: string): string {
  return text.replace(
    /(<diagram\b[^>]*>)([\s\S]*?)(<\/diagram>)/g,
    (_, open: string, page: string, close: string) =>
      `${open}${deflateRawSync(
        Buffer.from(encodeURIComponent(page.trim())),
      ).toString('base64')}${close}`,
  );
}

describe('convertDrawio', () => {
  it('converts the trading sample with its guesses', async () => {
    const result = await convertDrawio(SAMPLE);

    expect(result.nodes).toBe(7);
    expect(result.relationships).toBe(7);
    expect(result.architecture.$schema).toBe(
      'https://calm.finos.org/release/1.3/meta/calm.json',
    );
    expect(result.architecture.nodes).toHaveLength(7);
    expect(result.architecture.relationships).toHaveLength(7);
    expect(result.architecture.metadata).toHaveProperty('_layout');

    expect(result.guesses).toHaveLength(2);
    expect(result.guesses[0]).toMatch(/^Trade Events — node type: system \(/);
    expect(result.guesses[1]).toMatch(
      /^Order Service → Trade Events — protocol: none \(/,
    );
    for (const guess of result.guesses) {
      expect(result.report).toContain(guess);
    }
    expect(result.report).toContain('Converted 7 nodes, 7 relationships');
    expect(result.report).toContain('TODO: add DR site — sticky note');
    expect(result.report).toContain('Legend — legend');
    expect(result.report).toContain(
      'Order Service ↔ Risk Service — two-headed arrow, kept the drawn direction',
    );
  });

  it('gives the trading sample the node types and containment of calm-import demo', async () => {
    const { architecture } = await convertDrawio(SAMPLE);
    const nodes = architecture.nodes as Array<Record<string, string>>;
    expect(nodes.map(n => [n.name, n['node-type']])).toEqual([
      ['Trader', 'actor'],
      ['Trading UI', 'webclient'],
      ['Kubernetes Cluster', 'network'],
      ['Order Service', 'service'],
      ['Trade Events', 'system'],
      ['Risk Service', 'service'],
      ['Trades DB', 'database'],
    ]);
    const layout = (architecture.metadata as { _layout: object })._layout;
    expect(Object.keys(layout)).toEqual(nodes.map(n => n['unique-id']));
    expect(architecture.relationships).toContainEqual({
      'unique-id': 'kubernetes-cluster-deployed-in',
      'relationship-type': {
        'deployed-in': {
          container: 'kubernetes-cluster',
          nodes: ['order-service', 'trade-events', 'risk-service'],
        },
      },
    });
  });

  it('converts a compressed diagram to the same architecture', async () => {
    const packed = compressed(SAMPLE);
    expect(packed).not.toContain('<mxGraphModel');

    const plain = await convertDrawio(SAMPLE);
    const result = await convertDrawio(packed);

    expect(result.architecture).toEqual(plain.architecture);
    expect(result.guesses).toEqual(plain.guesses);
    expect(result.report).toBe(plain.report);
  });

  it('rejects a diagram with no boxes', async () => {
    const empty =
      '<mxfile><diagram name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    await expect(convertDrawio(empty)).rejects.toThrow(
      'The diagram has no boxes to convert',
    );
  });
});
