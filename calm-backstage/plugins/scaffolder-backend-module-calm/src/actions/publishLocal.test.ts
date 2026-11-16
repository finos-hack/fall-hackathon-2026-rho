import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createCalmPublishLocalAction } from './publishLocal';

let root: string;
const write = async (rel: string, text = 'x') => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
const ctx = (input: object) =>
  ({
    input,
    logger: { info: jest.fn(), warn: jest.fn() },
    output: jest.fn(),
    workspacePath: root,
  } as any);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-publish-'));
  await write('architecture.json', '{}');
  await write('rendered/src/server.js');
  await write('rendered/Dockerfile');
  await write('rendered-deploy/deploy/k8s/kustomization.yaml');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A catalog without the name, so the name check passes. */
const catalog = { getEntityByRef: jest.fn(async () => undefined) } as any;
const auth = {
  getOwnServiceCredentials: jest.fn(async () => ({
    principal: { type: 'service', subject: 'scaffolder' },
  })),
} as any;

const action = () =>
  createCalmPublishLocalAction({
    catalog,
    auth,
    localDir: path.join(root, 'output'),
    namespacePrefix: 'calm-',
  });
const input = {
  name: 'orders',
  namespace: 'hackathon',
  patternId: 'web-service',
  patternVersion: '1.0.0',
  bundle: 'node-service@1.0.0',
  deployable: true,
  hubNamespace: 'hackathon',
  hubArchitecture: 'orders',
  hubArchitectureVersion: '1.0.0',
};

describe('calm:publish:local and CALM Hub', () => {
  it('publishes no architecture copy: the annotations point at CALM Hub', async () => {
    await action().handler(ctx(input));
    const dir = path.join(root, 'output', 'orders');
    await expect(
      fs.stat(path.join(dir, 'architecture.json')),
    ).rejects.toThrow();
    const entity = YAML.parse(
      await fs.readFile(path.join(dir, 'catalog-info.yaml'), 'utf-8'),
    );
    expect(entity.metadata.annotations).toMatchObject({
      'calm.finos.org/architecture': 'orders',
      'calm.finos.org/architecture-version': '1.0.0',
    });
    expect(entity.metadata.annotations).not.toHaveProperty(
      'calm.finos.org/architecture-file',
    );
  });

  it('fails without the CALM Hub coordinates, writing nothing', async () => {
    await expect(
      action().handler(ctx({ ...input, hubArchitectureVersion: '' })),
    ).rejects.toThrow(/CALM Hub is the only store of the architecture/);
    await expect(
      fs.stat(path.join(root, 'output', 'orders')),
    ).rejects.toThrow();
  });
});

describe('calm:publish:local with deployment rules', () => {
  it('merges the deployment rules and records the deployment bundle', async () => {
    await action().handler(
      ctx({
        ...input,
        deployBundle: 'k8s-deploy@1.0.0',
        deploySourceDir: 'rendered-deploy',
      }),
    );
    const dir = path.join(root, 'output', 'orders');
    await expect(
      fs.stat(path.join(dir, 'deploy/k8s/kustomization.yaml')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(dir, 'src/server.js')),
    ).resolves.toBeTruthy();
    const entity = YAML.parse(
      await fs.readFile(path.join(dir, 'catalog-info.yaml'), 'utf-8'),
    );
    expect(entity.metadata.annotations).toMatchObject({
      'calm.finos.org/bundle': 'node-service',
      'calm.finos.org/bundle-version': '1.0.0',
      'calm.finos.org/deploy-bundle': 'k8s-deploy',
      'calm.finos.org/deploy-bundle-version': '1.0.0',
    });
    expect(entity.spec.dependsOn).toEqual([
      'resource:default/pattern-web-service',
      'resource:default/bundle-node-service-1.0.0',
      'resource:default/bundle-k8s-deploy-1.0.0',
    ]);
    expect(entity.metadata.description).toContain(
      'the starter node-service 1.0.0 and the deployment rules k8s-deploy 1.0.0',
    );
  });

  it('fails when the starter and the deployment rules render the same file', async () => {
    await write('rendered/deploy/k8s/kustomization.yaml');
    await expect(
      action().handler(
        ctx({
          ...input,
          deployBundle: 'k8s-deploy@1.0.0',
          deploySourceDir: 'rendered-deploy',
        }),
      ),
    ).rejects.toThrow(
      /Both the starter and the deployment rules rendered deploy\/k8s\/kustomization.yaml/,
    );
  });

  it('records no deployment bundle for a full bundle (empty inputs)', async () => {
    await action().handler(
      ctx({
        ...input,
        bundle: 'web-service@3.0.0',
        deployBundle: '',
        deploySourceDir: '',
      }),
    );
    const entity = YAML.parse(
      await fs.readFile(
        path.join(root, 'output', 'orders', 'catalog-info.yaml'),
        'utf-8',
      ),
    );
    expect(
      entity.metadata.annotations['calm.finos.org/deploy-bundle'],
    ).toBeUndefined();
  });
});

describe('calm:publish:local dry run', () => {
  const dryCtx = (i: object) => ({ ...ctx(i), isDryRun: true });
  const dryDir = () => path.join(root, 'dry-run-output', 'orders');

  it('supports dry run', () => {
    expect(action().supportsDryRun).toBe(true);
  });

  it('writes only under the workspace and leaves localDir absent', async () => {
    await action().handler(dryCtx(input));
    await expect(fs.stat(path.join(root, 'output'))).rejects.toThrow();
    await expect(
      fs.stat(path.join(dryDir(), 'catalog-info.yaml')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(dryDir(), 'src/server.js')),
    ).resolves.toBeTruthy();
  });

  it('leaves an existing localDir unchanged', async () => {
    await write('output/other/keep.txt');
    await action().handler(dryCtx(input));
    expect(await fs.readdir(path.join(root, 'output'))).toEqual(['other']);
  });

  it('points the outputs at the dry-run folder and logs the plan', async () => {
    const c = dryCtx(input);
    await action().handler(c);
    expect(c.output).toHaveBeenCalledWith('path', dryDir());
    expect(c.output).toHaveBeenCalledWith(
      'catalogInfoPath',
      path.join(dryDir(), 'catalog-info.yaml'),
    );
    expect(c.output).toHaveBeenCalledWith(
      'entityRef',
      'component:default/orders',
    );
    expect(c.output).toHaveBeenCalledWith(
      'files',
      expect.arrayContaining(['catalog-info.yaml', 'src/server.js']),
    );
    const n = (await fs.readdir(dryDir(), { recursive: true })).length;
    expect(n).toBeGreaterThan(0);
    expect(c.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^Dry run: would publish \\d+ files to ${path
            .join(root, 'output', 'orders')
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      ),
    );
  });

  it('still fails when <localDir>/<name> exists', async () => {
    await write('output/orders/catalog-info.yaml');
    await expect(action().handler(dryCtx(input))).rejects.toThrow(
      /already exists/,
    );
    await expect(fs.stat(dryDir())).rejects.toThrow();
  });

  it('with overwrite, an existing <localDir>/<name> is left untouched', async () => {
    await write('output/orders/old.txt');
    await action().handler(dryCtx({ ...input, overwrite: true }));
    await expect(
      fs.stat(path.join(root, 'output', 'orders', 'old.txt')),
    ).resolves.toBeTruthy();
  });
});
