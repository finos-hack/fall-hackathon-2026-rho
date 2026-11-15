import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Entity } from '@backstage/catalog-model';
import { createCalmPublishLocalAction } from './publishLocal';
import { createCalmRegisterLocalAction, isConflict } from './registerLocal';

const component = (name: string, location: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name,
    annotations: { 'backstage.io/managed-by-location': location },
  },
  spec: {},
});

const SERVICE = { principal: { type: 'service', subject: 'scaffolder' } };
const USER = {
  principal: { type: 'user', userEntityRef: 'user:default/guest' },
};

/** The backend's own credentials, which can read every entity. */
const auth = { getOwnServiceCredentials: jest.fn(async () => SERVICE) } as any;

/** `hidden` entities are readable only with the backend's credentials, as under a permission policy. */
function fakeCatalog(entities: Entity[] = [], hidden: Entity[] = []) {
  return {
    getEntityByRef: jest.fn(
      async (ref: string, opts: { credentials: unknown }) =>
        [...entities, ...(opts.credentials === SERVICE ? hidden : [])].find(
          e => `component:default/${e.metadata.name}` === ref.toLowerCase(),
        ),
    ),
    addLocation: jest.fn(
      async (location: { dryRun?: boolean }, _options?: unknown) => ({
        location: {},
        entities: location.dryRun ? [component('orders-service', '')] : [],
      }),
    ),
  };
}

function context(input: Record<string, unknown>, workspacePath: string) {
  return {
    input,
    workspacePath,
    logger: { info: jest.fn(), warn: jest.fn() },
    output: jest.fn(),
    getInitiatorCredentials: jest.fn(async () => USER),
  } as any;
}

let tmp: string;
let localDir: string;
let workspace: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-name-clash-'));
  localDir = path.join(tmp, 'output');
  workspace = path.join(tmp, 'workspace');
  await fs.mkdir(path.join(workspace, 'rendered'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'rendered', 'README.md'), '# hi');
  await fs.writeFile(path.join(workspace, 'architecture.json'), '{}');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const publishInput = {
  name: 'orders-service',
  patternId: 'web-service',
  patternVersion: '1.0.0',
  bundle: 'web-service@1.0.0',
  hubNamespace: 'hackathon',
  hubArchitecture: 'orders',
  hubArchitectureVersion: '1.0.0',
};

describe('calm:publish:local', () => {
  it('refuses a name the catalog holds from elsewhere, before writing anything', async () => {
    const catalog = fakeCatalog([
      component('orders-service', 'calm-hub:http://localhost:8090'),
    ]);
    const action = createCalmPublishLocalAction({
      catalog: catalog as any,
      auth,
      localDir,
      namespacePrefix: 'calm-',
    });

    await expect(
      action.handler(context(publishInput, workspace)),
    ).rejects.toThrow(
      'The catalog already has component:default/orders-service (from calm-hub:http://localhost:8090)',
    );
    await expect(
      fs.stat(path.join(localDir, 'orders-service')),
    ).rejects.toThrow();
  });

  it('refuses a name held by an entity the task user cannot read', async () => {
    const catalog = fakeCatalog(
      [],
      [component('orders-service', 'calm-hub:http://localhost:8090')],
    );
    const action = createCalmPublishLocalAction({
      catalog: catalog as any,
      auth,
      localDir,
      namespacePrefix: 'calm-',
    });

    await expect(
      action.handler(context(publishInput, workspace)),
    ).rejects.toThrow(
      'The catalog already has component:default/orders-service',
    );
    await expect(
      fs.stat(path.join(localDir, 'orders-service')),
    ).rejects.toThrow();
  });

  it('names an unknown location when the entity has no location annotation', async () => {
    const entity = component('orders-service', '');
    delete entity.metadata.annotations;
    const action = createCalmPublishLocalAction({
      catalog: fakeCatalog([entity]) as any,
      auth,
      localDir,
      namespacePrefix: 'calm-',
    });

    await expect(
      action.handler(context(publishInput, workspace)),
    ).rejects.toThrow('(from an unknown location)');
  });

  it('publishes a free name', async () => {
    const action = createCalmPublishLocalAction({
      catalog: fakeCatalog() as any,
      auth,
      localDir,
      namespacePrefix: 'calm-',
    });
    const ctx = context(publishInput, workspace);

    await action.handler(ctx);

    const files = await fs.readdir(path.join(localDir, 'orders-service'));
    // No architecture.json: CALM Hub holds the architecture.
    expect(files.sort()).toEqual(['README.md', 'catalog-info.yaml']);
    expect(ctx.output).toHaveBeenCalledWith(
      'entityRef',
      'component:default/orders-service',
    );
  });

  it('allows overwriting its own earlier publish', async () => {
    const own = `file:${path.join(
      localDir,
      'orders-service',
      'catalog-info.yaml',
    )}`;
    const action = createCalmPublishLocalAction({
      catalog: fakeCatalog([component('orders-service', own)]) as any,
      auth,
      localDir,
      namespacePrefix: 'calm-',
    });
    await fs.mkdir(path.join(localDir, 'orders-service'), { recursive: true });

    await action.handler(
      context({ ...publishInput, overwrite: true }, workspace),
    );

    expect(await fs.readdir(path.join(localDir, 'orders-service'))).toContain(
      'catalog-info.yaml',
    );
  });
});

describe('calm:register:local', () => {
  it('refuses a clash without adding the location', async () => {
    const catalog = fakeCatalog([
      component('orders-service', 'calm-hub:http://localhost:8090'),
    ]);
    const action = createCalmRegisterLocalAction({
      catalog: catalog as any,
      auth,
      localDir,
    });
    const catalogInfoPath = path.join(
      localDir,
      'orders-service',
      'catalog-info.yaml',
    );

    await expect(
      action.handler(context({ catalogInfoPath }, workspace)),
    ).rejects.toThrow(
      'The catalog already has component:default/orders-service (from calm-hub:http://localhost:8090)',
    );
    // Only the dry run reached the catalog.
    expect(catalog.addLocation).toHaveBeenCalledTimes(1);
    expect(catalog.addLocation.mock.calls[0][0]).toMatchObject({
      dryRun: true,
    });
  });
});

describe('calm:register:local, hidden entity', () => {
  it('refuses a clash with an entity the task user cannot read, without adding the location', async () => {
    const catalog = fakeCatalog(
      [],
      [component('orders-service', 'calm-hub:http://localhost:8090')],
    );
    const action = createCalmRegisterLocalAction({
      catalog: catalog as any,
      auth,
      localDir,
    });
    const catalogInfoPath = path.join(
      localDir,
      'orders-service',
      'catalog-info.yaml',
    );

    await expect(
      action.handler(context({ catalogInfoPath }, workspace)),
    ).rejects.toThrow('The catalog already has');
    expect(catalog.addLocation).toHaveBeenCalledTimes(1);
    // The location calls still run as the task user.
    expect(catalog.addLocation.mock.calls[0][1]).toEqual({ credentials: USER });
  });
});

describe('isConflict', () => {
  it('recognises a ConflictError and the catalog client ResponseError', () => {
    const conflict = Object.assign(new Error('x'), { name: 'ConflictError' });
    expect(isConflict(conflict)).toBe(true);
    expect(
      isConflict(
        Object.assign(new Error('x'), {
          name: 'ResponseError',
          statusCode: 409,
        }),
      ),
    ).toBe(true);
    expect(
      isConflict(
        Object.assign(new Error('x'), {
          name: 'ResponseError',
          cause: conflict,
        }),
      ),
    ).toBe(true);
  });

  it('ignores other errors', () => {
    expect(
      isConflict(
        Object.assign(new Error('x'), {
          name: 'ResponseError',
          statusCode: 500,
        }),
      ),
    ).toBe(false);
    expect(isConflict(new Error('x'))).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });
});
