import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CalmHubError } from '@internal/backstage-plugin-calm-common';
import { createCalmImportDrawioAction, diagramText } from './importDrawio';
import { importNameClash } from './importName';

const SAMPLE = path.resolve(
  __dirname,
  '../../../../../calm-import/examples/trading.drawio',
);
/** The sample, read now: the table tests below are built when the file loads. */
const sample = readFileSync(SAMPLE);
const KINDS = '.drawio, .xml or a draw.io .svg export';

const dataUrl = (bytes: Buffer, name?: string, mime = 'text/xml') =>
  `data:${mime};${
    name !== undefined ? `name=${encodeURIComponent(name)};` : ''
  }base64,${bytes.toString('base64')}`;

/** A Hub holding `hub` architecture names, and a catalog holding `catalog` component names. */
function deps(opts: {
  hub?: string[];
  catalog?: string[];
  hubError?: Error;
  namespaces?: string[];
}) {
  const credentials = { principal: { type: 'service' } } as any;
  const inCatalog = (o: any) =>
    o?.credentials === credentials ? opts.catalog ?? [] : [];
  return {
    hub: {
      architectures: jest.fn(async (namespace: string) => {
        if (opts.hubError) {
          throw opts.hubError;
        }
        return (opts.hub ?? []).map(customId => ({ customId, namespace }));
      }),
      namespaces: jest.fn(async () => opts.namespaces ?? ['hackathon']),
    },
    namespace: 'hackathon',
    catalog: {
      getEntityByRef: jest.fn(async (ref: string, o: any) =>
        inCatalog(o).some(n => ref === `component:default/${n}`)
          ? ({ metadata: { name: ref.split('/')[1] } } as any)
          : undefined,
      ),
      getEntities: jest.fn(async (req: any, o: any) => ({
        items: inCatalog(o)
          .filter(n => req.filter['metadata.name'].includes(n))
          .map(name => ({ metadata: { name } } as any)),
      })),
    },
    auth: { getOwnServiceCredentials: jest.fn(async () => credentials) },
  };
}

describe('importNameClash', () => {
  it('is undefined for a free name', async () => {
    expect(await importNameClash('trading', deps({}))).toBeUndefined();
  });

  it('names CALM Hub and suggests <name>-2', async () => {
    expect(await importNameClash('trading', deps({ hub: ['trading'] }))).toBe(
      'The name trading is already used (in CALM Hub); choose another, for example trading-2',
    );
  });

  it('refuses a name only the catalog holds (an existing service)', async () => {
    const d = deps({ catalog: ['orders'] });
    expect(await importNameClash('orders', d)).toBe(
      'The name orders is already used (in the catalog); choose another, for example orders-2',
    );
    expect(d.catalog.getEntityByRef).toHaveBeenCalledWith(
      'component:default/orders',
      expect.anything(),
    );
  });

  it('names both when CALM Hub and the catalog hold the name', async () => {
    expect(
      await importNameClash(
        'orders',
        deps({ hub: ['orders'], catalog: ['orders'] }),
      ),
    ).toBe(
      'The name orders is already used (in CALM Hub and in the catalog); choose another, for example orders-2',
    );
  });

  it('suggests the first free <name>-N', async () => {
    expect(
      await importNameClash(
        'trading',
        deps({ hub: ['trading', 'trading-2'], catalog: ['trading-3'] }),
      ),
    ).toBe(
      'The name trading is already used (in CALM Hub); choose another, for example trading-4',
    );
  });

  it('omits the example when <name>-2 … <name>-50 are all taken', async () => {
    const taken = ['x', ...Array.from({ length: 49 }, (_, i) => `x-${i + 2}`)];
    expect(await importNameClash('x', deps({ hub: taken }))).toBe(
      'The name x is already used (in CALM Hub); choose another',
    );
  });

  it('suggests a free name with one catalog query, not one lookup per candidate (#71)', async () => {
    const d = deps({ hub: ['trading'], catalog: ['trading-2', 'trading-3'] });
    expect(await importNameClash('trading', d)).toBe(
      'The name trading is already used (in CALM Hub); choose another, for example trading-4',
    );
    expect(d.catalog.getEntityByRef).toHaveBeenCalledTimes(1);
    expect(d.catalog.getEntities).toHaveBeenCalledTimes(1);
    const [request] = d.catalog.getEntities.mock.calls[0];
    expect(request.filter).toMatchObject({
      kind: 'Component',
      'metadata.namespace': 'default',
    });
    expect(request.filter['metadata.name']).toHaveLength(49);
  });

  it('refuses a missing CALM Hub namespace before anything is converted (#71)', async () => {
    const d = deps({
      hubError: new CalmHubError(404, 'u', 'not found'),
      namespaces: ['finos'],
    });
    await expect(importNameClash('trading', d)).rejects.toThrow(
      'CALM Hub has no namespace hackathon (calm.publish.hubNamespace); create it in CALM Hub first',
    );
  });

  it('treats a 404 for a namespace that exists as holding no architectures', async () => {
    const d = deps({ hubError: new CalmHubError(404, 'u', 'not found') });
    expect(await importNameClash('trading', d)).toBeUndefined();
  });

  it('fails when the Hub cannot be read', async () => {
    const d = deps({ hubError: new CalmHubError(500, 'u', 'boom') });
    await expect(importNameClash('trading', d)).rejects.toThrow('boom');
  });
});

describe('calm:import:drawio', () => {
  let workspace: string;
  const file = () => path.join(workspace, 'architecture.json');
  const exists = (p: string) =>
    fs
      .stat(p)
      .then(() => true)
      .catch(() => false);
  const ctx = (input: object, extra: object = {}) => {
    const outputs: Record<string, unknown> = {};
    return {
      input,
      logger: { info: jest.fn(), warn: jest.fn() },
      output: (k: string, v: unknown) => {
        outputs[k] = v;
      },
      outputs,
      workspacePath: workspace,
      ...extra,
    } as any;
  };
  const run = async (input: object, d = deps({}), extra: object = {}) => {
    const c = ctx(input, extra);
    await createCalmImportDrawioAction(d).handler(c);
    return c;
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-import-test-'));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('is calm:import:drawio and supports dry run', () => {
    const action = createCalmImportDrawioAction(deps({}));
    expect(action.id).toBe('calm:import:drawio');
    expect(action.supportsDryRun).toBe(true);
  });

  it('writes the converted architecture and logs the report', async () => {
    const c = await run({
      name: 'trading',
      diagram: dataUrl(sample, 'trading.drawio'),
    });
    const arch = JSON.parse(await fs.readFile(file(), 'utf-8'));
    expect(arch.nodes).toHaveLength(7);
    expect(arch.$schema).toBe(
      'https://calm.finos.org/release/1.3/meta/calm.json',
    );
    expect(c.outputs.nodes).toBe(7);
    expect(c.outputs.relationships).toBe(arch.relationships.length);
    expect(c.outputs.architecturePath).toBe('architecture.json');
    expect(Array.isArray(c.outputs.guesses)).toBe(true);
    expect((c.outputs.guesses as string[]).length).toBeGreaterThan(0);
    // What the import dropped or changed is an output too, not only a log line (#71).
    expect(c.outputs.leftOut).toEqual(
      expect.arrayContaining([
        'TODO: add DR site — left out: sticky note',
        'Legend — left out: legend',
        'Order Service ↔ Risk Service — changed: two-headed arrow, kept the drawn direction',
      ]),
    );
    const logged = c.logger.info.mock.calls.map((a: any[]) => a[0]).join('\n');
    expect(logged).toContain('Converted 7 nodes');
  });

  it('accepts a data-url without a name and with an empty or generic mime', async () => {
    await run({ name: 'trading', diagram: dataUrl(sample, undefined, '') });
    expect(await exists(file())).toBe(true);
    await run({
      name: 'trading',
      diagram: dataUrl(sample, 'trading.xml', 'application/octet-stream'),
      architecturePath: 'out/arch.json',
    });
    expect(await exists(path.join(workspace, 'out/arch.json'))).toBe(true);
  });

  it('writes the same file in a dry run', async () => {
    const c = await run(
      { name: 'trading', diagram: dataUrl(sample, 'trading.drawio') },
      deps({}),
      { isDryRun: true },
    );
    expect(JSON.parse(await fs.readFile(file(), 'utf-8')).nodes).toHaveLength(
      7,
    );
    expect(c.outputs.nodes).toBe(7);
  });

  it('refuses a name CALM Hub holds, before reading the file', async () => {
    await expect(
      run(
        { name: 'trading', diagram: 'not a data url' },
        deps({ hub: ['trading'] }),
      ),
    ).rejects.toThrow(
      'The name trading is already used (in CALM Hub); choose another, for example trading-2',
    );
    expect(await exists(file())).toBe(false);
  });

  it('refuses a name only the catalog holds', async () => {
    await expect(
      run(
        { name: 'orders', diagram: dataUrl(sample, 'trading.drawio') },
        deps({ catalog: ['orders'] }),
      ),
    ).rejects.toThrow('(in the catalog)');
    expect(await exists(file())).toBe(false);
  });

  it('refuses the same in a dry run', async () => {
    await expect(
      run(
        { name: 'orders', diagram: dataUrl(sample, 'trading.drawio') },
        deps({ catalog: ['orders'] }),
        { isDryRun: true },
      ),
    ).rejects.toThrow('(in the catalog)');
    expect(await exists(file())).toBe(false);
  });

  it.each([
    'Trading',
    '1trading',
    'trading--x',
    'trading-',
    'trading_x',
    `t${'a'.repeat(63)}`,
  ])('refuses the name %p', async name => {
    const d = deps({});
    await expect(
      run({ name, diagram: dataUrl(sample, 'trading.drawio') }, d),
    ).rejects.toThrow(/name/);
    expect(d.hub.architectures).not.toHaveBeenCalled();
    expect(await exists(file())).toBe(false);
  });

  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000',
    'hex',
  );
  it.each([
    ['a PNG', dataUrl(png, 'diagram.png', 'image/png'), KINDS],
    ['a PNG without a name', dataUrl(png, undefined, 'image/png'), KINDS],
    ['plain text', dataUrl(Buffer.from('hello'), 'notes.xml'), KINDS],
    ['a .vsdx', dataUrl(sample, 'diagram.vsdx'), KINDS],
    ['an empty file', dataUrl(Buffer.alloc(0), 'trading.drawio'), KINDS],
    [
      'a 3 MB file',
      dataUrl(
        Buffer.concat([sample, Buffer.alloc(3 * 1024 * 1024, 32)]),
        'trading.drawio',
      ),
      '2 MB',
    ],
    ['not a data-url', 'trading.drawio', KINDS],
  ])('refuses %s before writing anything', async (_, diagram, message) => {
    for (const isDryRun of [false, true]) {
      await expect(
        run({ name: 'trading', diagram }, deps({}), { isDryRun }),
      ).rejects.toThrow(message);
      expect(await exists(file())).toBe(false);
    }
  });

  it('refuses a base64 upload over 2 MB from its length, before decoding it', async () => {
    // Every 4 base64 characters are 3 bytes: this is just over 2 MB.
    const big = 'A'.repeat(Math.ceil((2 * 1024 * 1024) / 3) * 4 + 4);
    const from = jest.spyOn(Buffer, 'from');
    try {
      await expect(
        run({
          name: 'trading',
          diagram: `data:text/xml;name=trading.drawio;base64,${big}`,
        }),
      ).rejects.toThrow('the limit is 2 MB');
      expect(from.mock.calls.some(c => (c as unknown[])[1] === 'base64')).toBe(
        false,
      );
    } finally {
      from.mockRestore();
    }
    expect(await exists(file())).toBe(false);
  });

  it('accepts a base64 upload of exactly 2 MB by its length, padding counted', async () => {
    // Exactly 2 MB decoded, ending in padding: refused only for its content, not its size.
    const exact = Buffer.alloc(2 * 1024 * 1024, 32).toString('base64');
    expect(() =>
      diagramText(`data:text/xml;name=a.drawio;base64,${exact}`),
    ).toThrow(
      'The file is not a draw.io diagram (.drawio, .xml or a draw.io .svg export)',
    );
  });

  it('names the expected kinds for a non draw.io file', async () => {
    await expect(
      run({
        name: 'trading',
        diagram: dataUrl(Buffer.from('hello'), 'notes.txt'),
      }),
    ).rejects.toThrow(
      'The file is not a draw.io diagram (.drawio, .xml or a draw.io .svg export)',
    );
  });

  it('hints at Mermaid when a Mermaid diagram is uploaded', async () => {
    await expect(
      run({
        name: 'trading',
        diagram: dataUrl(Buffer.from('flowchart LR\n  a --> b\n'), 'a.txt'),
      }),
    ).rejects.toThrow(
      'The file does not match the chosen format "draw.io"; it looks like Mermaid flowchart: choose "Mermaid flowchart" as the format',
    );
    expect(await exists(file())).toBe(false);
  });

  it('writes only inside the workspace', async () => {
    await expect(
      run({
        name: 'trading',
        diagram: dataUrl(sample, 'trading.drawio'),
        architecturePath: '../escape.json',
      }),
    ).rejects.toThrow();
    expect(await exists(path.join(workspace, '..', 'escape.json'))).toBe(false);
  });
});
