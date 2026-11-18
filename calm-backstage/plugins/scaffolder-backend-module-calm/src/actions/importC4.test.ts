import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCalmImportC4Action } from './importC4';

const SAMPLE = path.resolve(
  __dirname,
  '../../../../../calm-import/examples/trading.c4.md',
);
/** The sample, read now: the table tests below are built when the file loads. */
const sample = readFileSync(SAMPLE);
const KINDS = '.md, .mmd, .puml, .plantuml or .txt';

const dataUrl = (bytes: Buffer, name?: string, mime = 'text/plain') =>
  `data:${mime};${
    name !== undefined ? `name=${encodeURIComponent(name)};` : ''
  }base64,${bytes.toString('base64')}`;

/** A Hub holding `hub` architecture names, and a catalog holding `catalog` component names. */
function deps(opts: { hub?: string[]; catalog?: string[]; hubError?: Error }) {
  const credentials = { principal: { type: 'service' } } as any;
  return {
    hub: {
      architectures: jest.fn(async (namespace: string) => {
        if (opts.hubError) {
          throw opts.hubError;
        }
        return (opts.hub ?? []).map(customId => ({ customId, namespace }));
      }),
    },
    namespace: 'hackathon',
    catalog: {
      getEntityByRef: jest.fn(async (ref: string, o: any) =>
        o?.credentials === credentials &&
        (opts.catalog ?? []).some(n => ref === `component:default/${n}`)
          ? ({ metadata: { name: ref.split('/')[1] } } as any)
          : undefined,
      ),
    },
    auth: { getOwnServiceCredentials: jest.fn(async () => credentials) },
  };
}

describe('calm:import:c4', () => {
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
    await createCalmImportC4Action(d).handler(c);
    return c;
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-import-test-'));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('is calm:import:c4 and supports dry run', () => {
    const action = createCalmImportC4Action(deps({}));
    expect(action.id).toBe('calm:import:c4');
    expect(action.supportsDryRun).toBe(true);
  });

  it('writes the converted architecture and logs the report', async () => {
    const c = await run({
      name: 'trading',
      diagram: dataUrl(sample, 'trading.c4.md'),
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
    const logged = c.logger.info.mock.calls.map((a: any[]) => a[0]).join('\n');
    expect(logged).toContain('Converted 7 nodes');
  });

  it('accepts a data-url without a name and with an empty or generic mime', async () => {
    await run({ name: 'trading', diagram: dataUrl(sample, undefined, '') });
    expect(await exists(file())).toBe(true);
    await run({
      name: 'trading',
      diagram: dataUrl(sample, 'trading.txt', 'application/octet-stream'),
      architecturePath: 'out/arch.json',
    });
    expect(await exists(path.join(workspace, 'out/arch.json'))).toBe(true);
  });

  it('writes the same file in a dry run', async () => {
    const c = await run(
      { name: 'trading', diagram: dataUrl(sample, 'trading.c4.md') },
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
        { name: 'orders', diagram: dataUrl(sample, 'trading.c4.md') },
        deps({ catalog: ['orders'] }),
      ),
    ).rejects.toThrow('(in the catalog)');
    expect(await exists(file())).toBe(false);
  });

  it('refuses the same in a dry run', async () => {
    await expect(
      run(
        { name: 'orders', diagram: dataUrl(sample, 'trading.c4.md') },
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
      run({ name, diagram: dataUrl(sample, 'trading.c4.md') }, d),
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
    [
      'a PNG without a name',
      dataUrl(png, undefined, 'image/png'),
      'No C4 diagram found',
    ],
    ['plain text', dataUrl(Buffer.from('hello'), 'notes.xml'), KINDS],
    ['a .vsdx', dataUrl(sample, 'diagram.vsdx'), KINDS],
    ['an empty file', dataUrl(Buffer.alloc(0), 'trading.c4.md'), KINDS],
    [
      'a 3 MB file',
      dataUrl(
        Buffer.concat([sample, Buffer.alloc(3 * 1024 * 1024, 32)]),
        'trading.c4.md',
      ),
      '2 MB',
    ],
    ['not a data-url', 'trading.c4.md', KINDS],
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
          diagram: `data:text/xml;name=trading.c4.md;base64,${big}`,
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

  it('hints at the right format for another kind of diagram', async () => {
    await expect(
      run({
        name: 'trading',
        diagram: dataUrl(Buffer.from('flowchart LR\n  a --> b\n'), 'other.txt'),
      }),
    ).rejects.toThrow(
      'The file does not match the chosen format "C4 (Mermaid or PlantUML)"; it looks like Mermaid flowchart: choose "Mermaid flowchart" as the format',
    );
    expect(await exists(file())).toBe(false);
  });

  it('writes only inside the workspace', async () => {
    await expect(
      run({
        name: 'trading',
        diagram: dataUrl(sample, 'trading.c4.md'),
        architecturePath: '../escape.json',
      }),
    ).rejects.toThrow();
    expect(await exists(path.join(workspace, '..', 'escape.json'))).toBe(false);
  });
});
