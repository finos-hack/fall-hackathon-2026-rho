// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decodeDrawio } from './decode';

const MODEL =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

function compress(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString(
    'base64',
  );
}

describe('decodeDrawio', () => {
  it('reads a plain .drawio page', async () => {
    const result = await decodeDrawio(
      `<mxfile><diagram id="a">${MODEL}</diagram></mxfile>`,
    );
    expect(result.graphModelXml).toBe(MODEL);
    expect(result.pageNames).toEqual(['Page-1']);
  });

  it('reads a compressed page', async () => {
    const result = await decodeDrawio(
      `<mxfile><diagram name="Arch">${compress(MODEL)}</diagram></mxfile>`,
    );
    expect(result.graphModelXml).toBe(MODEL);
    expect(result.pageNames).toEqual(['Arch']);
  });

  it('uses the first of several pages and lists all names', async () => {
    const second = MODEL.replace('id="1"', 'id="second"');
    const result = await decodeDrawio(
      `<mxfile><diagram name="Arch">${compress(
        MODEL,
      )}</diagram><diagram name="Deployment">${second}</diagram></mxfile>`,
    );
    expect(result.graphModelXml).toBe(MODEL);
    expect(result.pageNames).toEqual(['Arch', 'Deployment']);
  });

  it('reads a bare mxGraphModel', async () => {
    const result = await decodeDrawio(MODEL);
    expect(result.graphModelXml).toBe(MODEL);
  });

  it('reads a draw.io SVG export', async () => {
    const svg = readFileSync(
      join(__dirname, '__fixtures__/drawio-simple.svg'),
      'utf-8',
    );
    const result = await decodeDrawio(svg);
    expect(result.graphModelXml).toMatch(
      /^<mxGraphModel>[\s\S]*Web App[\s\S]*<\/mxGraphModel>$/,
    );
  });

  it('reads an SVG export with an HTML-escaped mxfile', async () => {
    const escaped = `<mxfile><diagram name="P">${MODEL}</diagram></mxfile>`
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const result = await decodeDrawio(
      `<svg xmlns="http://www.w3.org/2000/svg" content="${escaped}"></svg>`,
    );
    expect(result.graphModelXml).toBe(MODEL);
    expect(result.pageNames).toEqual(['P']);
  });

  it('keeps %XX text in an uncompressed SVG export', async () => {
    const model =
      '<mxGraphModel><root><mxCell id="2" value="Uptime 100%25" link="https://x.example/?q=a%26b"/></root></mxGraphModel>';
    const escaped = `<mxfile><diagram name="P">${model}</diagram></mxfile>`
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const result = await decodeDrawio(
      `<svg xmlns="http://www.w3.org/2000/svg" content="${escaped}"></svg>`,
    );
    expect(result.graphModelXml).toBe(model);
  });

  it('rejects a file with no draw.io data', async () => {
    await expect(
      decodeDrawio('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
    ).rejects.toThrow(/no draw.io diagram/i);
  });

  it('rejects input over 5 MB', async () => {
    await expect(decodeDrawio('x'.repeat(5 * 1024 * 1024 + 1))).rejects.toThrow(
      /too large/i,
    );
  });

  it('rejects a page that decompresses to over 20 MB', async () => {
    const huge = `<mxGraphModel>${' '.repeat(21 * 1024 * 1024)}</mxGraphModel>`;
    const packed = deflateRawSync(Buffer.from(huge)).toString('base64');
    await expect(
      decodeDrawio(`<mxfile><diagram>${packed}</diagram></mxfile>`),
    ).rejects.toThrow(/too large/i);
  });
});
