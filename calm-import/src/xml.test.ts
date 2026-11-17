import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertDrawio } from './index';
import { readDrawio } from './read';

// The XML reader runs on fast-xml-parser instead of calm-import's xml2js; these pin where the two could differ.

function model(cells: string): string {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
}

function vertex(id: string, value: string, extra = ''): string {
  return `<mxCell id="${id}" value="${value}" style="rounded=1;" vertex="1" parent="1"${extra}><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>`;
}

describe('the XML reader', () => {
  it('decodes &#xa; in a plain label into the name and the description', async () => {
    const { architecture } = await convertDrawio(
      model(vertex('a', 'Order Service&#xa;Takes orders')),
    );
    expect(architecture.nodes).toEqual([
      expect.objectContaining({
        name: 'Order Service',
        description: 'Takes orders',
      }),
    ]);
  });

  it('keeps leading and trailing spaces in attribute values, as xml2js did', async () => {
    const diagram = await readDrawio(
      model(
        `${vertex(' a ', 'A')}${vertex('b', 'B')}` +
          '<mxCell id="e" edge="1" parent="1" source=" a " target="b"><mxGeometry relative="1" as="geometry"/></mxCell>',
      ),
    );
    expect(diagram.boxes.map(box => box.id)).toEqual([' a ', 'b']);
    expect(diagram.arrows).toEqual([
      expect.objectContaining({ sourceId: ' a ', targetId: 'b' }),
    ]);
  });

  it('rejects an unclosed <mxCell>', async () => {
    const xml = model(
      `<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/>${vertex(
        'b',
        'B',
      )}`,
    );
    await expect(readDrawio(xml)).rejects.toThrow(
      /^The diagram is not well-formed XML \(line \d+\): ./,
    );
  });

  it('rejects a mismatched closing tag', async () => {
    const xml = model(
      '<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"></mxCell>',
    );
    await expect(readDrawio(xml)).rejects.toThrow(
      /^The diagram is not well-formed XML \(line \d+\): ./,
    );
  });

  it('accepts a raw &nbsp; and a raw < inside an attribute', async () => {
    const diagram = await readDrawio(
      model(vertex('a', 'A&nbsp;B') + vertex('b', 'x < y')),
    );
    expect(diagram.boxes.map(box => box.label)).toEqual(['A B', 'x < y']);
  });

  it('accepts the SVG fixture and the trading sample', async () => {
    const svg = await readDrawio(
      readFileSync(join(__dirname, '__fixtures__/drawio-simple.svg'), 'utf-8'),
    );
    expect(svg.boxes.length).toBeGreaterThan(0);
    const trading = await readDrawio(
      readFileSync(
        join(__dirname, '../examples/trading.drawio'),
        'utf-8',
      ),
    );
    expect(trading.boxes).toHaveLength(7);
  });

  it('names an attribute that cannot be read', async () => {
    const xml = model(
      '<object label="A" id="a" constructor="x"><mxCell style="" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell></object>',
    );
    await expect(readDrawio(xml)).rejects.toThrow(
      'The diagram has an attribute name that cannot be read: constructor',
    );
  });
});
