import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  CALM_ANNOTATIONS as ANN,
  CalmHubError,
  CalmHubWriteClient,
  FetchLike,
} from '@internal/backstage-plugin-calm-common';
import {
  createCalmDecorateDeploymentAction,
  deployedNodes,
} from './decorateDeployment';
import { serviceEntity } from './publishLocal';
import {
  chooseVersion,
  createCalmRegisterHubAction,
  withTitle,
} from './registerHub';

interface Call {
  method: string;
  url: string;
  body?: any;
}

/**
 * A small CALM Hub: architecture versions and decorators in memory, on the routes the actions use, with the checks
 * the real Hub makes on a posted architecture (a `title`, the `$id` of the version, 1.0.0 first, no second write of
 * a version). `calls` lists every request, so a test can show what was (not) written.
 */
function fakeHub(base: string) {
  const architectures = new Map<string, Map<string, any>>();
  const decorators: any[] = [];
  const calls: Call[] = [];
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
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    const u = new URL(url);
    // The name-based list, with the numeric id the Hub's UI uses. billing-api is always listed as 16.
    if (
      method === 'GET' &&
      u.pathname === '/calm/namespaces/hackathon/architectures'
    ) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            values: [
              {
                customId: 'billing-api',
                namespace: 'hackathon',
                numericId: 16,
              },
            ],
          }),
        json: async () => ({
          values: [
            { customId: 'billing-api', namespace: 'hackathon', numericId: 16 },
          ],
        }),
      } as any;
    }
    const arch =
      /^\/calm\/namespaces\/hackathon\/architectures\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(
        u.pathname,
      );
    if (arch) {
      const versions = architectures.get(arch[1]);
      if (method === 'POST') {
        if (typeof body?.title !== 'string' || !body.title.trim()) {
          return answer(400, "'title' is required in the document body");
        }
        if (body.$id !== `${base}${u.pathname}`) {
          return answer(400, '$id does not match the version URL');
        }
        if (!versions && arch[2] !== '1.0.0') {
          return answer(400, 'The first version of a resource must be 1.0.0');
        }
        if (versions?.has(arch[2])) {
          return answer(409, `Version ${arch[2]} already exists`);
        }
        architectures.set(arch[1], (versions ?? new Map()).set(arch[2], body));
        return answer(201, '');
      }
      if (!versions) {
        return answer(404, `Resource not found: ${arch[1]}`);
      }
      if (!arch[2]) {
        return answer(200, { values: [...versions.keys()] });
      }
      return versions.has(arch[2])
        ? answer(200, versions.get(arch[2]))
        : answer(404, 'Version not found');
    }
    const dec =
      /^\/api\/calm\/namespaces\/hackathon\/decorators(?:\/(\d+))?$/.exec(
        u.pathname,
      );
    if (dec && method === 'POST') {
      decorators.push(body);
      return answer(201, { id: decorators.length });
    }
    if (dec && dec[1]) {
      const d = decorators[Number(dec[1]) - 1];
      // The Hub answers in camel case.
      return d
        ? answer(200, {
            uniqueId: d['unique-id'],
            type: d.type,
            target: d.target,
            targetType: d['target-type'],
            appliesTo: d['applies-to'],
            data: d.data,
          })
        : answer(404, 'no such decorator');
    }
    if (dec) {
      const target = u.searchParams.get('target');
      const type = u.searchParams.get('type');
      return answer(200, {
        values: decorators
          .map((d, i) => ({ d, id: i + 1 }))
          .filter(
            ({ d }) =>
              (!target || d.target.includes(target)) &&
              (!type || d.type === type),
          )
          .map(({ id }) => id),
      });
    }
    return answer(404, 'not found');
  };
  return {
    client: new CalmHubWriteClient(base, fetch),
    architectures,
    decorators,
    calls,
    posts: () => calls.filter(c => c.method === 'POST'),
  };
}

const base = 'http://hub:8090';
const versionUrl = (name: string, version: string) =>
  `${base}/calm/namespaces/hackathon/architectures/${name}/versions/${version}`;
const architecture = {
  $schema: `${base}/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0`,
  nodes: [
    { 'unique-id': 'web-client', 'node-type': 'webclient' },
    { 'unique-id': 'web-service', 'node-type': 'service' },
    { 'unique-id': 'mongo-database', 'node-type': 'database' },
  ],
  relationships: [],
};

describe('with a workspace', () => {
  let workspace: string;
  const file = () => path.join(workspace, 'architecture.json');
  const readFile = async () => JSON.parse(await fs.readFile(file(), 'utf-8'));
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
      task: { id: 'task-1' },
      ...extra,
    } as any;
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-hub-test-'));
    await fs.writeFile(file(), JSON.stringify(architecture));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  describe('calm:register:hub', () => {
    const noEntities = { getEntityByRef: jest.fn(async () => undefined) };
    const auth = { getOwnServiceCredentials: jest.fn(async () => ({})) } as any;
    const register = (
      hub: ReturnType<typeof fakeHub>,
      c: any,
      catalog: any = noEntities,
    ) =>
      createCalmRegisterHubAction({
        hub: hub.client,
        namespace: 'hackathon',
        catalog,
        auth,
        localDir: path.join(workspace, 'output'),
      }).handler(c);

    it('refuses a name the catalog holds from elsewhere, before any Hub request', async () => {
      const hub = fakeHub(base);
      const catalog = {
        getEntityByRef: jest.fn(async () => ({
          metadata: {
            name: 'billing-api',
            annotations: {
              'backstage.io/managed-by-location': 'url:https://example.com/x',
            },
          },
        })),
      };
      await expect(
        register(hub, ctx({ name: 'billing-api' }), catalog),
      ).rejects.toThrow(
        'The catalog already has component:default/billing-api (from url:https://example.com/x)',
      );
      expect(hub.calls).toEqual([]);
    });

    it('refuses a service whose folder exists, before any Hub request', async () => {
      const hub = fakeHub(base);
      await fs.mkdir(path.join(workspace, 'output', 'billing-api'), {
        recursive: true,
      });
      await expect(register(hub, ctx({ name: 'billing-api' }))).rejects.toThrow(
        /billing-api already exists, so the service billing-api has already been created/,
      );
      expect(hub.calls).toEqual([]);
    });

    it('stores a new architecture as 1.0.0 with its $id and the service mark, and writes both to the file', async () => {
      const hub = fakeHub(base);
      const c = ctx({ name: 'billing-api' });
      await register(hub, c);

      const url = versionUrl('billing-api', '1.0.0');
      const stored = {
        $schema: architecture.$schema,
        $id: url,
        title: 'billing-api',
        description:
          'Created from the CALM pattern hackathon/web-service 1.0.0 by Backstage.',
        nodes: architecture.nodes,
        relationships: [],
        metadata: {
          'calm-backstage': { entity: 'component:default/billing-api' },
        },
      };
      expect(hub.posts()).toEqual([{ method: 'POST', url, body: stored }]);
      expect(await readFile()).toEqual(stored);
      expect(Object.keys(await readFile()).slice(0, 4)).toEqual([
        '$schema',
        '$id',
        'title',
        'description',
      ]);
      expect(c.outputs).toEqual({
        namespace: 'hackathon',
        architecture: 'billing-api',
        version: '1.0.0',
        url,
        created: true,
      });
    });

    it('keeps a title, a description and metadata the architecture already has', async () => {
      const hub = fakeHub(base);
      await fs.writeFile(
        file(),
        JSON.stringify({
          ...architecture,
          title: 'Billing',
          description: 'Bills customers.',
          metadata: [{ team: 'billing' }],
        }),
      );
      await register(hub, ctx({ name: 'billing-api' }));
      expect(hub.posts()[0].body).toMatchObject({
        title: 'Billing',
        description: 'Bills customers.',
        metadata: [
          { team: 'billing' },
          { 'calm-backstage': { entity: 'component:default/billing-api' } },
        ],
      });
      expect(await readFile()).toEqual(hub.posts()[0].body);
    });

    it('reuses the latest version when it holds the same document, and posts nothing', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api' }));
      // The second run starts from a fresh, unmarked file again.
      await fs.writeFile(file(), JSON.stringify(architecture));
      const c = ctx({ name: 'billing-api' });
      await register(hub, c);
      expect(hub.posts()).toHaveLength(1);
      expect(c.outputs).toMatchObject({ version: '1.0.0', created: false });
      expect((await readFile()).$id).toBe(versionUrl('billing-api', '1.0.0'));
    });

    it('stores a changed architecture as the next patch version', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api' }));
      await fs.writeFile(
        file(),
        JSON.stringify({ ...architecture, nodes: architecture.nodes.slice(1) }),
      );
      const c = ctx({ name: 'billing-api' });
      await register(hub, c);
      const url = versionUrl('billing-api', '1.0.1');
      expect(hub.posts().map(p => p.url)).toEqual([
        versionUrl('billing-api', '1.0.0'),
        url,
      ]);
      expect(c.outputs).toMatchObject({ version: '1.0.1', url, created: true });
      expect((await readFile()).$id).toBe(url);
    });

    it("refuses to add a version to an architecture that is not this service's", async () => {
      const hub = fakeHub(base);
      hub.architectures.set(
        'orders-service',
        new Map([['1.0.0', { title: 'Orders Service', nodes: [] }]]),
      );
      await expect(
        register(hub, ctx({ name: 'orders-service' })),
      ).rejects.toThrow(
        /already holds an architecture hackathon\/orders-service \(version 1.0.0\) that was not registered for a service/,
      );
      hub.architectures.set(
        'stock-api',
        new Map([
          [
            '1.0.0',
            {
              metadata: {
                'calm-backstage': { entity: 'component:default/other' },
              },
            },
          ],
        ]),
      );
      await expect(register(hub, ctx({ name: 'stock-api' }))).rejects.toThrow(
        /was registered for component:default\/other/,
      );
      expect(hub.posts()).toEqual([]);
      expect(await readFile()).toEqual(architecture);
    });

    it('refuses a name or version the Hub would reject, before any request', async () => {
      const hub = fakeHub(base);
      await expect(register(hub, ctx({ name: '2fast' }))).rejects.toThrow(
        /does not accept the architecture name "2fast"/,
      );
      await expect(
        register(hub, ctx({ name: 'billing-api', version: '1.0' })),
      ).rejects.toThrow(/Version must be <major>.<minor>.<patch>/);
      expect(hub.calls).toEqual([]);
    });

    it('writes nothing to the Hub in a dry run', async () => {
      const hub = fakeHub(base);
      const c = ctx({ name: 'billing-api' }, { isDryRun: true });
      await register(hub, c);
      expect(hub.posts()).toEqual([]);
      expect(c.outputs).toMatchObject({ version: '1.0.0', created: false });
      expect((await readFile()).$id).toBe(versionUrl('billing-api', '1.0.0'));
    });
  });

  describe('calm:register:hub, prepare and store', () => {
    const noEntities = { getEntityByRef: jest.fn(async () => undefined) };
    const auth = { getOwnServiceCredentials: jest.fn(async () => ({})) } as any;
    const register = (
      hub: ReturnType<typeof fakeHub>,
      c: any,
      catalog: any = noEntities,
    ) =>
      createCalmRegisterHubAction({
        hub: hub.client,
        namespace: 'hackathon',
        catalog,
        auth,
        localDir: path.join(workspace, 'output'),
      }).handler(c);

    it('prepare writes the file with its $id and makes no Hub write', async () => {
      const hub = fakeHub(base);
      const c = ctx({ name: 'billing-api', mode: 'prepare' });
      await register(hub, c);
      const url = versionUrl('billing-api', '1.0.0');
      expect(hub.posts()).toEqual([]);
      expect(await readFile()).toMatchObject({
        $id: url,
        title: 'billing-api',
        metadata: {
          'calm-backstage': { entity: 'component:default/billing-api' },
        },
      });
      expect(c.outputs).toEqual({
        namespace: 'hackathon',
        architecture: 'billing-api',
        version: '1.0.0',
        url,
        created: false,
      });
    });

    it('prepare still refuses a service whose folder exists', async () => {
      const hub = fakeHub(base);
      await fs.mkdir(path.join(workspace, 'output', 'billing-api'), {
        recursive: true,
      });
      await expect(
        register(hub, ctx({ name: 'billing-api', mode: 'prepare' })),
      ).rejects.toThrow(/billing-api already exists/);
      expect(hub.calls).toEqual([]);
    });

    it('store after prepare posts the same document', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      const prepared = await readFile();
      const c = ctx({ name: 'billing-api', mode: 'store' });
      await register(hub, c);
      const url = versionUrl('billing-api', '1.0.0');
      expect(hub.posts()).toEqual([{ method: 'POST', url, body: prepared }]);
      expect(await readFile()).toEqual(prepared);
      expect(c.outputs).toMatchObject({ version: '1.0.0', url, created: true });
    });

    it('store does not refuse because the output folder exists', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      await fs.mkdir(path.join(workspace, 'output', 'billing-api'), {
        recursive: true,
      });
      await register(hub, ctx({ name: 'billing-api', mode: 'store' }));
      expect(hub.posts()).toHaveLength(1);
    });

    // The other runs' documents carry this service's mark, so the ownership check passes.
    const ours = (doc: object) => ({
      ...doc,
      metadata: {
        'calm-backstage': { entity: 'component:default/billing-api' },
      },
    });

    it('store reuses the prepared version although the Hub gained a newer one in between', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api' }));
      await fs.writeFile(file(), JSON.stringify(architecture));
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      expect((await readFile()).$id).toBe(versionUrl('billing-api', '1.0.0'));
      // Another run stores a different document as 1.0.1.
      hub.architectures
        .get('billing-api')!
        .set('1.0.1', ours({ title: 'Other', nodes: [] }));
      const c = ctx({ name: 'billing-api', mode: 'store' });
      await register(hub, c);
      expect(hub.posts()).toHaveLength(1);
      expect(c.outputs).toMatchObject({
        version: '1.0.0',
        url: versionUrl('billing-api', '1.0.0'),
        created: false,
      });
    });

    it('store stores the prepared version although the Hub would choose another now', async () => {
      const hub = fakeHub(base);
      hub.architectures.set(
        'billing-api',
        new Map([['1.0.0', ours({ title: 'Old', nodes: [] })]]),
      );
      await register(
        hub,
        ctx({ name: 'billing-api', version: '2.0.0', mode: 'prepare' }),
      );
      const prepared = await readFile();
      expect(prepared.$id).toBe(versionUrl('billing-api', '2.0.0'));
      // Another run stores the same document as 1.0.1: a new choice would now reuse it.
      hub.architectures.get('billing-api')!.set('1.0.1', prepared);
      const c = ctx({ name: 'billing-api', mode: 'store' });
      await register(hub, c);
      expect(hub.posts()).toEqual([
        {
          method: 'POST',
          url: versionUrl('billing-api', '2.0.0'),
          body: prepared,
        },
      ]);
      expect(c.outputs).toMatchObject({ version: '2.0.0', created: true });
    });

    it('store refuses, posting nothing, when the Hub holds another document as the prepared version', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      hub.architectures.set(
        'billing-api',
        new Map([['1.0.0', ours({ title: 'Other', nodes: [] })]]),
      );
      await expect(
        register(hub, ctx({ name: 'billing-api', mode: 'store' })),
      ).rejects.toThrow(
        /already holds another document as hackathon\/billing-api 1\.0\.0/,
      );
      expect(hub.posts()).toEqual([]);
    });

    it('store reuses the version when the Hub answers 409 and holds the same document', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      // Another run stores the same document between the version list and the POST.
      jest
        .spyOn(hub.client, 'createArchitectureVersion')
        .mockImplementationOnce(async (_ns, name, version, doc) => {
          hub.architectures.set(name, new Map([[version, doc]]));
          throw new CalmHubError(409, versionUrl(name, version), '409');
        });
      const c = ctx({ name: 'billing-api', mode: 'store' });
      await register(hub, c);
      expect(c.outputs).toMatchObject({ version: '1.0.0', created: false });
    });

    it('store fails when the Hub answers 409 and holds another document', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      jest
        .spyOn(hub.client, 'createArchitectureVersion')
        .mockImplementationOnce(async (_ns, name, version) => {
          hub.architectures.set(
            name,
            new Map([[version, ours({ title: 'Other', nodes: [] })]]),
          );
          throw new CalmHubError(409, versionUrl(name, version), '409');
        });
      await expect(
        register(hub, ctx({ name: 'billing-api', mode: 'store' })),
      ).rejects.toThrow(
        /already holds another document as hackathon\/billing-api 1\.0\.0/,
      );
    });

    it('store refuses a file that was not prepared, before any Hub request', async () => {
      const hub = fakeHub(base);
      await expect(
        register(hub, ctx({ name: 'billing-api', mode: 'store' })),
      ).rejects.toThrow(
        /has no \$id .*run calm:register:hub with mode prepare/,
      );
      await fs.writeFile(
        file(),
        JSON.stringify({
          ...architecture,
          $id: versionUrl('orders-service', '1.0.0'),
        }),
      );
      await expect(
        register(hub, ctx({ name: 'billing-api', mode: 'store' })),
      ).rejects.toThrow(
        /is not a version of hackathon\/billing-api.*run calm:register:hub with mode prepare/,
      );
      expect(hub.calls).toEqual([]);
    });

    describe('when the store fails', () => {
      const published = () => path.join(workspace, 'output', 'billing-api');
      // Prepare, publish (a copy of the prepared file), and another document in the Hub as the prepared version.
      // With conflict false, the Hub is left empty.
      // What calm:publish:local writes: the catalog-info.yaml naming the architecture version.
      const publishedInfo = (version = '1.0.0', arch = 'billing-api') =>
        YAML.stringify({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Component',
          metadata: {
            name: 'billing-api',
            annotations: {
              'calm.finos.org/architecture': arch,
              'calm.finos.org/architecture-version': version,
            },
          },
        });
      const prepareAndPublish = async (
        hub: ReturnType<typeof fakeHub>,
        conflict = true,
      ) => {
        await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
        await fs.mkdir(published(), { recursive: true });
        await fs.writeFile(
          path.join(published(), 'catalog-info.yaml'),
          publishedInfo(),
        );
        if (conflict) {
          hub.architectures.set(
            'billing-api',
            new Map([['1.0.0', ours({ title: 'Other', nodes: [] })]]),
          );
        }
      };
      const store = (extra: object = {}) =>
        ctx({
          name: 'billing-api',
          mode: 'store',
          publishedDir: published(),
          ...extra,
        });
      const removedMessage =
        /Nothing was stored in CALM Hub, and the folder .*billing-api this run published was removed, so the Template can be run again/;

      it('removes the folder when the Hub fails at the start (500), and rethrows the 500', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        jest
          .spyOn(hub.client, 'architectureVersions')
          .mockRejectedValueOnce(
            new CalmHubError(500, base, 'GET versions -> 500: down'),
          );
        const error = await register(hub, store()).catch(e => e);
        expect(error.message).toMatch(/GET versions -> 500: down/);
        expect(error.message).toMatch(removedMessage);
        expect(await exists(published())).toBe(false);
        expect(hub.posts()).toEqual([]);
      });

      it("removes the folder when the Hub's architecture is another service's", async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        hub.architectures.set(
          'billing-api',
          new Map([
            [
              '1.0.0',
              {
                title: 'X',
                metadata: {
                  'calm-backstage': { entity: 'component:default/other' },
                },
              },
            ],
          ]),
        );
        await expect(register(hub, store())).rejects.toThrow(
          /was registered for component:default\/other[\s\S]*Nothing was stored in CALM Hub, and the folder/,
        );
        expect(await exists(published())).toBe(false);
        expect(hub.posts()).toEqual([]);
      });

      it('removes the folder when the catalog holds the name from elsewhere', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        const catalog = {
          getEntityByRef: jest.fn(async () => ({
            metadata: {
              name: 'billing-api',
              annotations: {
                'backstage.io/managed-by-location': 'url:https://example.com/x',
              },
            },
          })),
        };
        await expect(register(hub, store(), catalog)).rejects.toThrow(
          removedMessage,
        );
        expect(await exists(published())).toBe(false);
      });

      it("fails, storing nothing, when the published folder's catalog-info.yaml names another version", async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        await fs.writeFile(
          path.join(published(), 'catalog-info.yaml'),
          publishedInfo('0.0.1'),
        );
        await expect(register(hub, store())).rejects.toThrow(
          /published folder's catalog-info.yaml names "billing-api" version "0.0.1", not the billing-api version 1.0.0 being stored/,
        );
        // It names another version, so this run did not publish it: kept.
        expect(hub.posts()).toEqual([]);
        expect(await exists(published())).toBe(true);
      });

      it('removes the folder when the Hub answers 409 and holds another document', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        jest
          .spyOn(hub.client, 'createArchitectureVersion')
          .mockImplementationOnce(async (_ns, name, version) => {
            hub.architectures.set(
              name,
              new Map([[version, ours({ title: 'Other', nodes: [] })]]),
            );
            throw new CalmHubError(409, versionUrl(name, version), '409');
          });
        await expect(register(hub, store())).rejects.toThrow(
          /already holds another document[\s\S]*Nothing was stored in CALM Hub/,
        );
        expect(await exists(published())).toBe(false);
      });

      it('does not claim nothing was stored when the POST itself failed', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        jest
          .spyOn(hub.client, 'createArchitectureVersion')
          .mockRejectedValueOnce(new Error('socket hang up.'));
        const error = await register(hub, store()).catch(e => e);
        expect(error.message).toMatch(/socket hang up/);
        expect(error.message).not.toMatch(/Nothing was stored/);
        expect(error.message).toMatch(
          /may or may not hold hackathon\/billing-api 1\.0\.0[\s\S]*the same document reuses it/,
        );
        expect(error.message).not.toContain('..');
        expect(await exists(published())).toBe(false);
      });

      it('refuses a publishedDir other than the service folder up front: no Hub request, no read, nothing removed', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub);
        const callsBefore = hub.calls.length;
        const output = path.join(workspace, 'output');
        const sub = path.join(published(), 'sub');
        const readFile = jest.spyOn(fs, 'readFile');
        try {
          for (const dir of [output, sub, path.join(workspace, 'elsewhere')]) {
            // Each holds the published catalog-info.yaml.
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(
              path.join(dir, 'catalog-info.yaml'),
              publishedInfo(),
            );
            readFile.mockClear();
            await expect(
              register(hub, store({ publishedDir: dir })),
            ).rejects.toThrow(
              /publishedDir must be the folder calm:publish:local wrote for billing-api .*Nothing was stored/,
            );
            expect(readFile).not.toHaveBeenCalledWith(
              path.join(dir, 'catalog-info.yaml'),
              expect.anything(),
            );
            expect(await exists(dir)).toBe(true);
          }
        } finally {
          readFile.mockRestore();
        }
        expect(hub.calls.length).toBe(callsBefore);
        expect(await exists(published())).toBe(true);
      });

      it('fails clearly, storing nothing, when the published catalog-info.yaml is missing or not YAML', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub, false);
        const publishedFile = path.join(published(), 'catalog-info.yaml');
        await fs.rm(publishedFile);
        const missing = await register(hub, store()).catch(e => e);
        expect(missing.message).toMatch(
          /Could not check the published catalog-info.yaml in .*billing-api: it is missing/,
        );
        expect(missing.message).not.toMatch(/ENOENT/);
        await fs.writeFile(publishedFile, 'secret-content: [');
        const broken = await register(hub, store()).catch(e => e);
        expect(broken.message).toMatch(
          /Could not check the published catalog-info.yaml in .*billing-api: it is not valid YAML/,
        );
        expect(broken.message).not.toContain('secret');
        expect(hub.posts()).toEqual([]);
      });

      const exists = (p: string) =>
        fs.stat(p).then(
          () => true,
          () => false,
        );

      it('removes the folder this run published, and says so', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub);
        const c = ctx({
          name: 'billing-api',
          mode: 'store',
          publishedDir: published(),
        });
        await expect(register(hub, c)).rejects.toThrow(
          /already holds another document[\s\S]*Nothing was stored in CALM Hub, and the folder .*billing-api this run published was removed, so the Template can be run again/,
        );
        expect(await exists(published())).toBe(false);
        expect(await exists(path.join(workspace, 'output'))).toBe(true);
        expect(c.logger.info).toHaveBeenCalledWith(
          expect.stringContaining(`Removed ${published()}`),
        );
      });

      it('keeps a folder whose catalog-info.yaml names another version', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub);
        await fs.writeFile(
          path.join(published(), 'catalog-info.yaml'),
          publishedInfo('0.0.1'),
        );
        await expect(
          register(
            hub,
            ctx({
              name: 'billing-api',
              mode: 'store',
              publishedDir: published(),
            }),
          ),
        ).rejects.toThrow(/names "billing-api" version "0.0.1"/);
        expect(await exists(published())).toBe(true);
      });

      it('a cleanup error does not hide the store error', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub);
        const rm = jest
          .spyOn(fs, 'rm')
          .mockRejectedValueOnce(new Error('EBUSY: resource busy'));
        try {
          const c = store();
          const error = await register(hub, c).catch(e => e);
          expect(error.message).toMatch(/already holds another document/);
          expect(error.message).not.toMatch(/removed/);
          expect(c.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('EBUSY'),
          );
        } finally {
          rm.mockRestore();
        }
        expect(await exists(published())).toBe(true);
      });

      it('in a dry run accepts the dry-run publishedDir, stores nothing and removes nothing', async () => {
        const hub = fakeHub(base);
        await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
        const dryDir = path.join(workspace, 'dry-run-output', 'billing-api');
        await fs.mkdir(dryDir, { recursive: true });
        await fs.writeFile(path.join(dryDir, 'keep.txt'), 'kept');
        const c = ctx(
          { name: 'billing-api', mode: 'store', publishedDir: dryDir },
          { isDryRun: true },
        );
        await register(hub, c);
        expect(hub.posts()).toEqual([]);
        expect(await fs.readFile(path.join(dryDir, 'keep.txt'), 'utf-8')).toBe(
          'kept',
        );
        expect(c.outputs).toMatchObject({ version: '1.0.0', created: false });
      });

      it('refuses the dry-run publishedDir without a dry run', async () => {
        const hub = fakeHub(base);
        await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
        const dryDir = path.join(workspace, 'dry-run-output', 'billing-api');
        await expect(
          register(
            hub,
            ctx({ name: 'billing-api', mode: 'store', publishedDir: dryDir }),
          ),
        ).rejects.toThrow(/publishedDir must be the folder calm:publish:local/);
        expect(hub.posts()).toEqual([]);
      });

      it('removes nothing in a dry run', async () => {
        const hub = fakeHub(base);
        await prepareAndPublish(hub);
        await expect(
          register(
            hub,
            ctx(
              { name: 'billing-api', mode: 'store', publishedDir: published() },
              { isDryRun: true },
            ),
          ),
        ).rejects.toThrow(/already holds another document/);
        expect(await exists(published())).toBe(true);
      });
    });

    it('store reuses an identical latest version and posts nothing', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api' }));
      await fs.writeFile(file(), JSON.stringify(architecture));
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      const postsBefore = hub.posts().length;
      const c = ctx({ name: 'billing-api', mode: 'store' });
      await register(hub, c);
      expect(hub.posts()).toHaveLength(postsBefore);
      expect(c.outputs).toMatchObject({ version: '1.0.0', created: false });
    });

    it('store writes nothing in a dry run', async () => {
      const hub = fakeHub(base);
      await register(hub, ctx({ name: 'billing-api', mode: 'prepare' }));
      await register(
        hub,
        ctx({ name: 'billing-api', mode: 'store' }, { isDryRun: true }),
      );
      expect(hub.posts()).toEqual([]);
    });
  });

  describe('calm:decorate:deployment', () => {
    const input = {
      hubNamespace: 'hackathon',
      architecture: 'billing-api',
      version: '1.0.0',
      name: 'billing-api',
      cluster: 'calm-backstage',
      namespace: 'calm-billing-api',
      workloads: ['api-gateway', 'mongo-database', 'web-service'],
      startTime: '2026-11-14T12:00:00.000Z',
      endTime: '2026-11-14T12:00:32.000Z',
    };
    const decorate = (hub: ReturnType<typeof fakeHub>, c: any) =>
      createCalmDecorateDeploymentAction({
        hub: hub.client,
        appBaseUrl: 'http://localhost:3100/',
      }).handler(c);

    it('posts one deployment decorator on the architecture version and reads it back', async () => {
      const hub = fakeHub(base);
      const c = ctx(input);
      await decorate(hub, c);
      const target =
        '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0';
      expect(hub.posts()).toEqual([
        {
          method: 'POST',
          url: `${base}/api/calm/namespaces/hackathon/decorators`,
          body: {
            $schema:
              'https://calm.finos.org/draft/2026-03/standards/deployment/deployment.decorator.standard.json',
            'unique-id': 'billing-api-task-1',
            type: 'deployment',
            // The second entry is the form CALM Hub's own UI filters by.
            target: [
              target,
              '/api/calm/namespaces/hackathon/architectures/16/versions/1-0-0',
            ],
            'target-type': ['architecture'],
            // api-gateway is not a node of this architecture.
            'applies-to': ['mongo-database', 'web-service'],
            data: {
              'start-time': '2026-11-14T12:00:00.000Z',
              'end-time': '2026-11-14T12:00:32.000Z',
              status: 'completed',
              'deployment-details':
                'http://localhost:3100/catalog/default/component/billing-api',
              notes:
                'Deployed by Backstage to the cluster calm-backstage, namespace calm-billing-api.',
            },
          },
        },
      ]);
      expect(c.outputs).toEqual({
        id: 1,
        uniqueId: 'billing-api-task-1',
        target,
        url: `${base}/api/calm/namespaces/hackathon/decorators/1`,
      });
      expect(c.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('api-gateway'),
      );
    });

    it('posts nothing for a status outside the standard, or when no workload is a node', async () => {
      const hub = fakeHub(base);
      await expect(
        decorate(hub, ctx({ ...input, status: 'done' })),
      ).rejects.toThrow(/must be one of/);
      await expect(
        decorate(hub, ctx({ ...input, workloads: ['gateway'] })),
      ).rejects.toThrow(/nothing for the decorator to apply to/);
      expect(hub.posts()).toEqual([]);
    });

    it('in a dry run posts nothing, logs the decorator and outputs the target, url and a placeholder id', async () => {
      const hub = fakeHub(base);
      const c = ctx(input, { isDryRun: true });
      await decorate(hub, c);
      expect(hub.posts()).toEqual([]);
      const target =
        '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0';
      expect(c.outputs).toEqual({
        id: 'dry-run',
        uniqueId: 'billing-api-task-1',
        target,
        url: `${base}/api/calm/namespaces/hackathon/decorators/dry-run`,
      });
      const logged = c.logger.info.mock.calls.map((x: any[]) => x[0]);
      expect(logged.every((l: string) => l.startsWith('Dry run: would '))).toBe(
        true,
      );
      expect(logged[0]).toBe(
        'Dry run: would store the decorator billing-api-task-1',
      );
      expect(logged.join('\n')).toContain('"unique-id": "billing-api-task-1"');
      expect(logged.join('\n')).toContain('"applies-to"');
    });

    it('in a dry run still fails when no workload is a node, and carries on when the Hub lookup fails', async () => {
      const hub = fakeHub(base);
      await expect(
        decorate(
          hub,
          ctx({ ...input, workloads: ['gateway'] }, { isDryRun: true }),
        ),
      ).rejects.toThrow(/nothing for the decorator to apply to/);
      const failing = {
        baseUrl: base,
        architectures: jest.fn(async () => {
          throw new Error('hub is down');
        }),
      } as any;
      const c = ctx(input, { isDryRun: true });
      await createCalmDecorateDeploymentAction({
        hub: failing,
        appBaseUrl: 'http://localhost:3100/',
      }).handler(c);
      expect(c.outputs.id).toBe('dry-run');
      expect(c.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('hub is down'),
      );
    });
  });
});

describe('withTitle', () => {
  it('names the service and its pattern, and overwrites nothing', () => {
    expect(
      withTitle({ $schema: architecture.$schema, nodes: [] }, 'a'),
    ).toEqual({
      $schema: architecture.$schema,
      title: 'a',
      description:
        'Created from the CALM pattern hackathon/web-service 1.0.0 by Backstage.',
      nodes: [],
    });
    expect(withTitle({ title: ' ', description: 'Mine.' }, 'a')).toEqual({
      title: 'a',
      description: 'Mine.',
    });
    expect(withTitle({ title: 'T' }, 'a')).toEqual({
      title: 'T',
      description: 'Created by Backstage.',
    });
  });
});

describe('chooseVersion', () => {
  const doc = { nodes: [1] };
  it('uses the wanted version when it is new and above the latest', () => {
    expect(chooseVersion({ wanted: '1.0.0', versions: [], doc })).toEqual({
      version: '1.0.0',
      reuse: false,
    });
    expect(
      chooseVersion({
        wanted: '2.0.0',
        versions: ['1.0.0', '1.0.1'],
        latest: { nodes: [] },
        doc,
      }),
    ).toEqual({ version: '2.0.0', reuse: false });
  });

  it('takes the patch after the latest when the wanted version is not above it', () => {
    expect(
      chooseVersion({
        wanted: '1.0.0',
        versions: ['1.0.0', '1.0.9', '1.0.10'],
        latest: { nodes: [] },
        doc,
      }),
    ).toEqual({ version: '1.0.11', reuse: false });
  });

  it('reuses the latest version when only the $id differs', () => {
    expect(
      chooseVersion({
        wanted: '1.0.0',
        versions: ['1.0.0', '1.0.1'],
        latest: { nodes: [1], $id: 'http://hub/x/1.0.1' },
        doc,
      }),
    ).toEqual({ version: '1.0.1', reuse: true });
  });
});

describe('deployedNodes', () => {
  it('keeps the workloads that are node ids', () => {
    expect(
      deployedNodes(['api-gateway', 'web-service', 'sidecar'], {
        nodes: [{ 'unique-id': 'web-service' }, { 'unique-id': 'api-gateway' }],
      }),
    ).toEqual(['api-gateway', 'web-service']);
    expect(deployedNodes(['web-service'], {})).toEqual([]);
  });

  it('lists a node once when two Deployments were rendered from it', () => {
    // E.g. a converted name gained a hash and the Deployment with the earlier name remains (calm:deploy:k8s does not
    // prune; Flux prunes on its next reconcile).
    expect(
      deployedNodes(['Orders_API', 'Orders_API', 'api-gateway'], {
        nodes: [{ 'unique-id': 'Orders_API' }, { 'unique-id': 'api-gateway' }],
      }),
    ).toEqual(['Orders_API', 'api-gateway']);
  });
});

describe('serviceEntity: Hub annotations', () => {
  const opts = {
    name: 'billing-api',
    owner: 'group:default/guests',
    namespace: 'hackathon',
    patternId: 'web-service',
    patternVersion: '1.0.0',
    bundleName: 'web-service',
    bundleVersion: '3.0.0',
  };
  const url = versionUrl('billing-api', '1.0.0');

  it('names the Hub architecture and version, and no architecture file', () => {
    const entity = serviceEntity({
      ...opts,
      hub: {
        namespace: 'hackathon',
        architecture: 'billing-api',
        version: '1.0.0',
        url,
      },
    });
    expect(entity.metadata.annotations).toMatchObject({
      [ANN.namespace]: 'hackathon',
      [ANN.architecture]: 'billing-api',
      [ANN.architectureVersion]: '1.0.0',
    });
    expect(
      entity.metadata.annotations?.[ANN.architectureNamespace],
    ).toBeUndefined();
    expect(entity.metadata.annotations).not.toHaveProperty(
      ANN.architectureFile,
    );
    expect(entity.metadata.links).toEqual([
      { url, title: 'Architecture in CALM Hub (JSON)' },
    ]);
  });

  it('names the architecture namespace when it is not the pattern namespace', () => {
    const entity = serviceEntity({
      ...opts,
      hub: {
        namespace: 'services',
        architecture: 'billing-api',
        version: '1.0.0',
      },
    });
    expect(entity.metadata.annotations).toMatchObject({
      [ANN.namespace]: 'hackathon',
      [ANN.architectureNamespace]: 'services',
    });
  });

  it('has no link without a Hub URL', () => {
    const entity = serviceEntity({
      ...opts,
      hub: {
        namespace: 'hackathon',
        architecture: 'billing-api',
        version: '1.0.0',
      },
    });
    expect(entity.metadata.links).toBeUndefined();
  });
});
