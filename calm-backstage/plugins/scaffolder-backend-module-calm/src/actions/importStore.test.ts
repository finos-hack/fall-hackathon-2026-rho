import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CalmHubWriteClient,
  FetchLike,
  serviceEntityOf,
} from '@internal/backstage-plugin-calm-common';
import { createCalmImportStoreAction } from './importStore';

const base = 'http://hub:8090';
const versionUrl = (name: string, version: string) =>
  `${base}/calm/namespaces/hackathon/architectures/${name}/versions/${version}`;

/**
 * A small CALM Hub on the routes the action uses, with the real Hub's checks on a posted architecture (a `title`, the
 * `$id` of the version, 1.0.0 first, no second write of a version) and a 404 for a namespace it does not have.
 */
function fakeHub(opts: { namespaces?: string[]; architectures?: string[] }) {
  const namespaces = opts.namespaces ?? ['hackathon'];
  const stored = new Map<string, Map<string, any>>(
    (opts.architectures ?? []).map(a => [
      a,
      new Map([['1.0.0', { title: a }]]),
    ]),
  );
  const posts: { url: string; body: any }[] = [];
  const answer = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    if (u.pathname === '/api/calm/namespaces') {
      return answer(200, { values: namespaces.map(name => ({ name })) });
    }
    const list = /^\/calm\/namespaces\/([^/]+)\/architectures$/.exec(
      u.pathname,
    );
    if (list) {
      return namespaces.includes(list[1])
        ? answer(200, {
            values: [...stored.keys()].map(customId => ({
              customId,
              namespace: list[1],
            })),
          })
        : answer(404, `Namespace not found: ${list[1]}`);
    }
    const arch =
      /^\/calm\/namespaces\/([^/]+)\/architectures\/([^/]+)\/versions\/([^/]+)$/.exec(
        u.pathname,
      );
    if (arch && !namespaces.includes(arch[1])) {
      return answer(404, `Namespace not found: ${arch[1]}`);
    }
    if (arch && method === 'POST') {
      const body = JSON.parse(init!.body!);
      posts.push({ url, body });
      const versions = stored.get(arch[2]);
      if (typeof body?.title !== 'string' || !body.title.trim()) {
        return answer(400, "'title' is required in the document body");
      }
      if (body.$id !== `${base}${u.pathname}`) {
        return answer(400, '$id does not match the version URL');
      }
      if (!versions && arch[3] !== '1.0.0') {
        return answer(400, 'The first version of a resource must be 1.0.0');
      }
      if (versions?.has(arch[3])) {
        return answer(409, `Version ${arch[3]} already exists`);
      }
      stored.set(arch[2], (versions ?? new Map()).set(arch[3], body));
      return answer(201, '');
    }
    if (arch) {
      const doc = stored.get(arch[2])?.get(arch[3]);
      return doc ? answer(200, doc) : answer(404, 'Version not found');
    }
    return answer(404, 'not found');
  };
  return { client: new CalmHubWriteClient(base, fetch), stored, posts };
}

const credentials = { principal: { type: 'service' } } as any;
const auth = { getOwnServiceCredentials: jest.fn(async () => credentials) };
const catalogWith = (names: string[] = []) => ({
  getEntityByRef: jest.fn(async (ref: string) =>
    names.some(n => ref === `component:default/${n}`)
      ? ({ metadata: { name: ref.split('/')[1] } } as any)
      : undefined,
  ),
  getEntities: jest.fn(async (req: any) => ({
    items: names
      .filter(n => req.filter['metadata.name'].includes(n))
      .map(name => ({ metadata: { name } }) as any),
  })),
});

/** What calm:import:drawio writes: no title or description, the layout in metadata. */
const imported = {
  $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
  nodes: [{ 'unique-id': 'web', 'node-type': 'service', name: 'Web' }],
  relationships: [],
  metadata: { _layout: { web: { x: 10, y: 20, width: 120, height: 60 } } },
};

describe('calm:import:store', () => {
  let workspace: string;
  const file = () => path.join(workspace, 'architecture.json');
  const readFile = async () => JSON.parse(await fs.readFile(file(), 'utf-8'));
  const run = async (
    input: object,
    hub: ReturnType<typeof fakeHub>,
    opts: { catalog?: string[]; isDryRun?: boolean } = {},
  ) => {
    const outputs: Record<string, unknown> = {};
    const c = {
      input,
      logger: { info: jest.fn(), warn: jest.fn() },
      output: (k: string, v: unknown) => {
        outputs[k] = v;
      },
      outputs,
      workspacePath: workspace,
      isDryRun: opts.isDryRun,
    } as any;
    await createCalmImportStoreAction({
      hub: hub.client,
      namespace: 'hackathon',
      catalog: catalogWith(opts.catalog),
      auth,
    }).handler(c);
    return c;
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-import-store-'));
    await fs.writeFile(file(), JSON.stringify(imported));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('is calm:import:store and supports dry run', () => {
    const action = createCalmImportStoreAction({
      hub: fakeHub({}).client,
      namespace: 'hackathon',
      catalog: catalogWith(),
      auth,
    });
    expect(action.id).toBe('calm:import:store');
    expect(action.supportsDryRun).toBe(true);
  });

  it('stores version 1.0.0 once, with $id, title and description, and writes the file back', async () => {
    const hub = fakeHub({});
    const c = await run({ name: 'trading' }, hub);
    expect(hub.posts).toHaveLength(1);
    const url = versionUrl('trading', '1.0.0');
    expect(hub.posts[0].url).toBe(url);
    const doc = hub.posts[0].body;
    expect(doc.$id).toBe(url);
    expect(doc.title).toBe('trading');
    expect(typeof doc.description).toBe('string');
    expect(doc.description).not.toBe('');
    expect(doc.$schema).toBe(imported.$schema);
    expect(doc.nodes).toEqual(imported.nodes);
    expect(await readFile()).toEqual(doc);
    expect(c.outputs).toEqual({
      namespace: 'hackathon',
      architecture: 'trading',
      version: '1.0.0',
      url,
      entityRef: 'component:default/trading',
    });
  });

  it('sets no service mark and keeps the layout', async () => {
    const hub = fakeHub({});
    await run({ name: 'trading' }, hub);
    const doc = hub.posts[0].body;
    expect(serviceEntityOf(doc)).toBeUndefined();
    expect(serviceEntityOf(await readFile())).toBeUndefined();
    expect(doc.metadata).toEqual(imported.metadata);
  });

  it('uses the description input when the architecture has none, and keeps an existing title and description', async () => {
    const hub = fakeHub({});
    await run({ name: 'trading', description: 'The trading system' }, hub);
    expect(hub.posts[0].body.description).toBe('The trading system');

    await fs.writeFile(
      file(),
      JSON.stringify({ ...imported, title: 'Trading', description: 'Kept' }),
    );
    const other = fakeHub({});
    await run({ name: 'trading', description: 'Ignored' }, other);
    expect(other.posts[0].body.title).toBe('Trading');
    expect(other.posts[0].body.description).toBe('Kept');
  });

  it('stores the description input trimmed (#71)', async () => {
    const hub = fakeHub({});
    await run({ name: 'trading', description: '  The trading system \n' }, hub);
    expect(hub.posts[0].body.description).toBe('The trading system');
  });

  it('replaces an $id the file already has', async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({ ...imported, $id: 'http://elsewhere/x' }),
    );
    const hub = fakeHub({});
    await run({ name: 'trading' }, hub);
    expect(hub.posts[0].body.$id).toBe(versionUrl('trading', '1.0.0'));
  });

  it('refuses a name CALM Hub holds, before any write', async () => {
    const hub = fakeHub({ architectures: ['trading'] });
    await expect(run({ name: 'trading' }, hub)).rejects.toThrow(
      'The name trading is already used (in CALM Hub); choose another, for example trading-2',
    );
    expect(hub.posts).toHaveLength(0);
    expect(await readFile()).toEqual(imported);
  });

  it('refuses a name only the catalog holds, before any write', async () => {
    const hub = fakeHub({});
    await expect(
      run({ name: 'orders' }, hub, { catalog: ['orders'] }),
    ).rejects.toThrow('(in the catalog)');
    expect(hub.posts).toHaveLength(0);
    expect(await readFile()).toEqual(imported);
  });

  it('refuses a bad name before asking the Hub', async () => {
    const hub = fakeHub({});
    await expect(run({ name: 'Trading' }, hub)).rejects.toThrow(
      'is not allowed',
    );
    expect(hub.posts).toHaveLength(0);
  });

  it('refuses a file that is not a JSON object', async () => {
    await fs.writeFile(file(), '[]');
    const hub = fakeHub({});
    await expect(run({ name: 'trading' }, hub)).rejects.toThrow(
      'not a CALM architecture',
    );
    expect(hub.posts).toHaveLength(0);
  });

  it('fails clearly, storing nothing, when the Hub has no such namespace', async () => {
    const hub = fakeHub({ namespaces: ['finos'] });
    for (const isDryRun of [false, true]) {
      await expect(run({ name: 'trading' }, hub, { isDryRun })).rejects.toThrow(
        'CALM Hub has no namespace hackathon (calm.publish.hubNamespace); create it in CALM Hub first. Nothing was stored',
      );
    }
    expect(hub.posts).toHaveLength(0);
    expect(await readFile()).toEqual(imported);
  });

  it('refuses clearly when the Hub gets the version after the name check', async () => {
    const hub = fakeHub({ architectures: ['trading'] });
    // The name check sees an empty list, as when another run stores the name in between.
    hub.client.architectures = async () => [];
    await expect(run({ name: 'trading' }, hub)).rejects.toThrow(
      'CALM Hub already holds hackathon/trading 1.0.0 (stored since the name was checked); choose another name. Nothing was stored',
    );
    expect(await readFile()).toEqual(imported);
  });

  it('dry run: checks the name, stores nothing and outputs no url', async () => {
    const hub = fakeHub({});
    const c = await run({ name: 'trading' }, hub, { isDryRun: true });
    expect(hub.posts).toHaveLength(0);
    expect(c.outputs).toEqual({
      namespace: 'hackathon',
      architecture: 'trading',
      version: '1.0.0',
      entityRef: 'component:default/trading',
    });

    await expect(
      run({ name: 'orders' }, fakeHub({}), {
        catalog: ['orders'],
        isDryRun: true,
      }),
    ).rejects.toThrow('(in the catalog)');
  });
});
