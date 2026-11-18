import { performance } from 'node:perf_hooks';
import { deflateRawSync } from 'node:zlib';
import { convertDrawio } from './index';
import { decodeDrawio } from './decode';
import { readDrawio } from './read';

// Uploads reach the converter from the scaffolder, so hostile input must fail fast and clearly, never block the event
// loop. A linear scan of these takes well under a second even while vitest runs other files in parallel; a
// quadratic one takes minutes. The bound sits between the two, so a loaded machine does not flake it.
const FAST_MS = 2000;
const NO_DIAGRAM = /no draw.io diagram found/i;

async function timed(run: () => Promise<unknown>): Promise<{
  ms: number;
  error?: Error;
}> {
  const start = performance.now();
  let error: Error | undefined;
  try {
    await run();
  } catch (e) {
    error = e as Error;
  }
  return { ms: performance.now() - start, error };
}

function packed(text: string): string {
  return deflateRawSync(Buffer.from(text)).toString('base64');
}

describe('hostile draw.io uploads', () => {
  it('looks past many blank pages to the page with a diagram, quickly (#71)', async () => {
    const blank =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell '.repeat(10_000) +
      '</root></mxGraphModel>';
    const drawn =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="2" value="Order Service" vertex="1" parent="1">' +
      '<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
    const pages = Array.from({ length: 20 }, (_, i) => `<diagram name="Blank ${i}">${blank}</diagram>`).join('');
    const { ms, error } = await timed(async () => {
      const result = await convertDrawio(`<mxfile>${pages}<diagram name="Arch">${drawn}</diagram></mxfile>`);
      expect(result.nodes).toBe(1);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('rejects many <mxGraphModel openers with no closer quickly', async () => {
    const { ms, error } = await timed(() =>
      convertDrawio('<mxGraphModel'.repeat(20_000)),
    );
    expect(error?.message).toMatch(NO_DIAGRAM);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('rejects a small compressed page that inflates to many openers quickly', async () => {
    const upload = `<mxfile><diagram>${packed(
      '<mxGraphModel'.repeat(20_000),
    )}</diagram></mxfile>`;
    expect(upload.length).toBeLessThan(2_000);

    const { ms, error } = await timed(() => convertDrawio(upload));
    expect(error?.message).toMatch(NO_DIAGRAM);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('rejects many <diagram openers with no closer quickly', async () => {
    const { ms, error } = await timed(() =>
      convertDrawio('<diagram>'.repeat(30_000)),
    );
    expect(error?.message).toMatch(NO_DIAGRAM);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('rejects many <svg openers with no content attribute quickly', async () => {
    const { ms, error } = await timed(() =>
      convertDrawio('<svg '.repeat(40_000)),
    );
    expect(error?.message).toMatch(NO_DIAGRAM);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('rejects a page that decompresses to over 10 MB', async () => {
    const big = `<mxGraphModel>${' '.repeat(11 * 1024 * 1024)}</mxGraphModel>`;
    await expect(
      decodeDrawio(`<mxfile><diagram>${packed(big)}</diagram></mxfile>`),
    ).rejects.toThrow('The diagram is too large (more than 10 MB');
  });

  it('still finds the content attribute after other attributes and other <svg tags', async () => {
    const model =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
    const escaped = model
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const result = await decodeDrawio(
      `<svgx content="no"><svg width="1"><g/><svg xcontent="no" data-a="&gt;"\ncontent="${escaped}"></svg></svg>`,
    );
    expect(result.graphModelXml).toBe(model);
  });

  it('fails with a message about the file on an out-of-range character reference', async () => {
    await expect(
      decodeDrawio('<svg content="&#99999999;"></svg>'),
    ).rejects.toThrow(
      'The file has an invalid character reference: &#99999999;',
    );
    await expect(
      decodeDrawio('<svg content="&#x110000;"></svg>'),
    ).rejects.toThrow(
      'The file has an invalid character reference: &#x110000;',
    );
  });

  it('converts a diagram whose non-box cells are each other’s parent, ignoring the cycle', async () => {
    const xml =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="a" parent="b"/><mxCell id="b" parent="a"/>' +
      '<mxCell id="c" value="Orders" style="rounded=1;" vertex="1" parent="a"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="d" value="Payments" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="120" height="60" as="geometry"/></mxCell>' +
      '</root></mxGraphModel>';

    const { ms, error } = await timed(async () => {
      const result = await convertDrawio(xml);
      expect(result.nodes).toBe(2);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  describe('an HTML label', () => {
    // The label is XML-escaped in the value attribute; the reader sees the raw `<` characters.
    const htmlCell = (label: string) =>
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      `<mxCell id="c" value="${label
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(
          /"/g,
          '&quot;',
        )}" style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>` +
      '</root></mxGraphModel>';

    async function readLabel(label: string): Promise<{
      ms: number;
      text: string;
    }> {
      const xml = htmlCell(label);
      const start = performance.now();
      const diagram = await readDrawio(xml);
      return { ms: performance.now() - start, text: diagram.boxes[0]!.label };
    }

    it('keeps 1 MB of < with no > as text, quickly', async () => {
      const { ms, text } = await readLabel('<'.repeat(1024 * 1024));
      expect(text).toBe('<'.repeat(1024 * 1024));
      expect(ms).toBeLessThan(FAST_MS);
    });

    it('keeps 1 MB of <div with no > as text, quickly', async () => {
      const { ms, text } = await readLabel('<div'.repeat(256 * 1024));
      expect(text).toBe('<div'.repeat(256 * 1024));
      expect(ms).toBeLessThan(FAST_MS);
    });

    it('still drops tags and keeps the text after an unclosed <', async () => {
      const { text } = await readLabel(
        '<div class="x"><b>Order</b> <i>Service</i></div><DIV>Takes<br/>orders &lt; 5 a < b',
      );
      expect(text).toBe('Order Service\nTakes\norders < 5 a < b');
    });
  });
});
