import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KUBERNETES_ANNOTATIONS as K8S } from '@internal/backstage-plugin-calm-common';
import {
  applyArgs,
  checkExistingNamespace,
  createCalmDeployK8sAction,
  namespaceManifest,
  overlayKustomization,
  parseImage,
  summariseObjects,
} from './deployK8s';
import { createCalmClusterCheckAction } from './clusterCheck';
import { createCalmImageBuildAction, imageReference } from './imageBuild';
import { serviceEntity } from './publishLocal';

describe('imageReference', () => {
  it('gives <name>:<tag>', () => {
    expect(imageReference('stock-api', '0b1c2d3e-4f')).toBe(
      'stock-api:0b1c2d3e-4f',
    );
  });

  it('refuses latest, a bad tag and a bad name', () => {
    expect(() => imageReference('stock-api', 'latest')).toThrow(
      /latest is refused/,
    );
    expect(() => imageReference('stock-api', '')).toThrow(/Image tag/);
    expect(() => imageReference('stock-api', 'a b')).toThrow(/Image tag/);
    expect(() => imageReference('Stock_API', 'dev')).toThrow(/Image name/);
  });
});

describe('overlay', () => {
  it('sets the namespace, the image and the Backstage label over the bundle base', () => {
    expect(
      overlayKustomization({
        name: 'stock-api',
        namespace: 'calm-stock-api',
        image: 'stock-api:run-1',
      }),
    ).toEqual({
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: 'calm-stock-api',
      resources: ['namespace.yaml', '../k8s'],
      images: [{ name: 'calm-service', newName: 'stock-api', newTag: 'run-1' }],
      labels: [
        {
          pairs: { 'backstage.io/kubernetes-id': 'stock-api' },
          includeTemplates: true,
        },
      ],
    });
  });

  it('labels the namespace as made for the service', () => {
    expect(namespaceManifest('stock-api', 'calm-stock-api')).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'calm-stock-api',
        labels: {
          'backstage.io/kubernetes-id': 'stock-api',
          'calm.finos.org/service': 'stock-api',
        },
      },
    });
  });

  it('needs an image with a tag other than latest', () => {
    expect(parseImage('localhost:5000/stock-api:run-1')).toEqual({
      newName: 'localhost:5000/stock-api',
      newTag: 'run-1',
    });
    for (const image of ['stock-api', 'stock-api:latest', 'stock-api:', '']) {
      expect(() => parseImage(image)).toThrow(/Image must be <name>:<tag>/);
    }
  });
});

describe('namespace guard', () => {
  const ns = (labels?: Record<string, string>) => ({
    kind: 'Namespace',
    metadata: { name: 'calm-stock-api', labels },
  });

  it('allows a new namespace and one made for the same service', () => {
    expect(() =>
      checkExistingNamespace('calm-stock-api', 'stock-api', undefined),
    ).not.toThrow();
    expect(() =>
      checkExistingNamespace(
        'calm-stock-api',
        'stock-api',
        ns({ 'calm.finos.org/service': 'stock-api' }),
      ),
    ).not.toThrow();
  });

  it('refuses a namespace calm:deploy:k8s did not create, or made for another service', () => {
    expect(() =>
      checkExistingNamespace('calm-backstage-system', 'backstage-system', ns()),
    ).toThrow(
      /calm-backstage-system already exists and has no calm.finos.org\/service label/,
    );
    expect(() =>
      checkExistingNamespace(
        'calm-stock-api',
        'stock-api',
        ns({ 'calm.finos.org/service': 'other' }),
      ),
    ).toThrow(/belongs to the service "other"/);
  });
});

describe('applyArgs', () => {
  it('applies the overlay', () => {
    expect(applyArgs('/o/deploy/k8s-overlay')).toEqual([
      'apply',
      '-k',
      '/o/deploy/k8s-overlay',
    ]);
  });
});

describe('summariseObjects', () => {
  it('names the deployments and network policies and lists the service ports', () => {
    expect(
      summariseObjects([
        { kind: 'Deployment', metadata: { name: 'web-service' } },
        { kind: 'Deployment', metadata: { name: 'api-gateway' } },
        {
          kind: 'Deployment',
          metadata: {
            name: 'orders-api',
            annotations: { 'calm.finos.org/unique-id': 'Orders_API' },
          },
        },
        { kind: 'NetworkPolicy', metadata: { name: 'default-deny' } },
        {
          kind: 'Service',
          metadata: { name: 'api-gateway' },
          spec: { ports: [{ port: 80 }] },
        },
        { kind: 'ConfigMap', metadata: { name: 'gateway-config' } },
      ]),
    ).toEqual({
      deployments: ['api-gateway', 'orders-api', 'web-service'],
      nodes: ['Orders_API', 'api-gateway', 'web-service'],
      networkPolicies: ['default-deny'],
      services: ['api-gateway:80'],
    });
  });
});

describe('the actions without a cluster', () => {
  const ctx = (input: object) =>
    ({
      input,
      logger: { info: jest.fn(), warn: jest.fn() },
      output: jest.fn(),
      workspacePath: os.tmpdir(),
    } as any);
  const localDir = path.join(os.tmpdir(), 'calm-output');
  const dir = path.join(localDir, 'stock-api');
  const build = { dir, name: 'stock-api', tag: 'run-1' };
  const deploy = { dir, name: 'stock-api', image: 'stock-api:run-1' };

  it('refuse to run when calm.deploy.kubernetes is not set', async () => {
    await expect(
      createCalmImageBuildAction({ localDir }).handler(ctx(build)),
    ).rejects.toThrow(/are not set.*yarn k8s:up/);
    await expect(
      createCalmDeployK8sAction({ localDir }).handler(ctx(deploy)),
    ).rejects.toThrow(/are not set.*yarn k8s:up/);
  });

  it('refuse to run when the kubeconfig file is missing, and say how to get it', async () => {
    const settings = {
      kubeconfig: path.join(os.tmpdir(), 'calm-no-such-folder', 'config'),
      context: 'calm-backstage',
      minikubeProfile: 'calm-backstage',
      namespacePrefix: 'calm-',
    };
    const message =
      /The kubeconfig .*calm-no-such-folder.config .* does not exist\. Run `yarn k8s:up`/;
    await expect(
      createCalmImageBuildAction({ settings, localDir }).handler(ctx(build)),
    ).rejects.toThrow(message);
    await expect(
      createCalmDeployK8sAction({ settings, localDir }).handler(ctx(deploy)),
    ).rejects.toThrow(message);
  });

  it('check the name, the namespace and the folder before any kubectl or minikube call', async () => {
    // A kubeconfig that exists (and is empty), so the guards after it are reached; the PATH is emptied so a guard
    // that let a call through would fail on the missing program instead.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-deploy-test-'));
    const kubeconfig = path.join(tmp, 'config');
    await fs.writeFile(kubeconfig, '');
    const settings = (namespacePrefix: string) => ({
      kubeconfig,
      context: 'calm-backstage',
      minikubeProfile: 'calm-backstage',
      namespacePrefix,
    });
    const deployWith = (prefix: string, input: object) =>
      createCalmDeployK8sAction({
        settings: settings(prefix),
        localDir,
      }).handler(ctx({ ...deploy, ...input }));
    const path0 = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(deployWith('calm-', { name: 'Stock_API' })).rejects.toThrow(
        /cannot name Kubernetes objects/,
      );
      await expect(deployWith('', { name: 'default' })).rejects.toThrow(
        /Refusing to deploy to the namespace "default"/,
      );
      await expect(deployWith('kube-', { name: 'system' })).rejects.toThrow(
        /Refusing to deploy to the namespace "kube-system"/,
      );
      await expect(
        deployWith('calm-', { dir: path.join(os.tmpdir(), 'elsewhere') }),
      ).rejects.toThrow(/outside/i);
      await expect(deployWith('calm-', {})).rejects.toThrow(
        /has no kustomization.yaml/,
      );
      await expect(
        createCalmImageBuildAction({
          settings: settings('calm-'),
          localDir,
        }).handler(ctx({ ...build, tag: 'latest' })),
      ).rejects.toThrow(/latest is refused/);
      // A name the form allows (63 characters) whose namespace is too long, refused by the step the Template runs
      // first, before anything is written.
      await expect(
        createCalmClusterCheckAction({ settings: settings('calm-') }).handler(
          ctx({ name: `a${'b'.repeat(61)}c` }),
        ),
      ).rejects.toThrow(/is not a valid Kubernetes namespace name/);
    } finally {
      process.env.PATH = path0;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('serviceEntity: Kubernetes annotations', () => {
  const base = {
    name: 'stock-api',
    owner: 'group:default/guests',
    patternId: 'web-service',
    patternVersion: '1.0.0',
    bundleName: 'web-service',
    bundleVersion: '3.0.0',
  };

  it('names the label value and the namespace for a deployable bundle', () => {
    const entity = serviceEntity({
      ...base,
      kubernetes: { id: 'stock-api', namespace: 'calm-stock-api' },
    });
    expect(entity.metadata.annotations).toMatchObject({
      [K8S.id]: 'stock-api',
      [K8S.namespace]: 'calm-stock-api',
    });
  });

  it('has neither otherwise', () => {
    const annotations = serviceEntity(base).metadata.annotations ?? {};
    expect(annotations[K8S.id]).toBeUndefined();
    expect(annotations[K8S.namespace]).toBeUndefined();
  });
});

/** A Hub that keeps the decorators posted to it, and reads each back the way recordDeployment checks. */
function fakeRecordingHub(opts: { failPost?: boolean } = {}) {
  const posted: any[] = [];
  const hub = {
    baseUrl: 'http://hub',
    architectures: jest.fn(async () => [{ customId: 'orders', numericId: 4 }]),
    createDecorator: jest.fn(async (_ns: string, d: any) => {
      if (opts.failPost) {
        throw new Error('hub is down');
      }
      posted.push(d);
      return posted.length;
    }),
    listDecorators: jest.fn(async () => posted.map((_, i) => i + 1)),
    getDecorator: jest.fn(async (_ns: string, id: number) => ({
      uniqueId: posted[id - 1]['unique-id'],
    })),
  };
  return { hub: hub as any, posted };
}

const record = {
  hubNamespace: 'hackathon',
  architecture: 'orders',
  version: '1.0.0',
  architecturePath: 'architecture.json',
};

describe('calm:deploy:k8s: a failed deployment', () => {
  let root: string;
  let localDir: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-deploy-fail-'));
    localDir = path.join(root, 'output');
    dir = path.join(localDir, 'orders');
    await fs.mkdir(path.join(dir, 'deploy', 'k8s'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'kustomization.yaml'),
      'resources: []\n',
    );
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'workloads.yaml'),
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: web-service',
        '  labels:',
        '    calm.finos.org/node: web-service',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: api-gateway',
        '  labels:',
        '    calm.finos.org/node: api-gateway',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(root, 'architecture.json'),
      JSON.stringify({
        nodes: [
          { 'unique-id': 'web-service' },
          { 'unique-id': 'api-gateway' },
          { 'unique-id': 'mongo-database' },
        ],
      }),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const kubeconfig = () => path.join(root, 'kubeconfig');
  const run = async (opts: {
    input?: object;
    hub?: any;
    namespace?: object;
    failRollout?: string;
  }) => {
    await fs.writeFile(kubeconfig(), '');
    const c = {
      input: {
        dir,
        name: 'orders',
        image: 'orders:run-1',
        ...opts.input,
      },
      logger: { info: jest.fn(), warn: jest.fn() },
      output: jest.fn(),
      workspacePath: root,
      task: { id: 'task-1' },
    } as any;
    const kubectl = jest.fn(async (args: string[]) => {
      const a = args.join(' ');
      if (a.startsWith('get namespace')) {
        return opts.namespace ? JSON.stringify(opts.namespace) : '';
      }
      if (a.includes('get deployments')) {
        return JSON.stringify({
          items: [{ kind: 'Deployment', metadata: { name: 'web-service' } }],
        });
      }
      if (a.includes('rollout status') && opts.failRollout) {
        throw new Error(opts.failRollout);
      }
      return '';
    });
    const result = createCalmDeployK8sAction({
      settings: {
        kubeconfig: kubeconfig(),
        context: 'calm-backstage',
        minikubeProfile: 'calm-backstage',
        namespacePrefix: 'calm-',
      },
      localDir,
      hub: opts.hub,
      appBaseUrl: 'http://localhost:3100',
      kubectl: () => kubectl,
    }).handler(c);
    return { result, c, kubectl };
  };
  const rollout =
    'error: timed out waiting for the condition on deployments/web-service\nsecond line';

  it('records a failed decorator, applying to the labelled nodes, and rethrows the deploy error', async () => {
    const { hub, posted } = fakeRecordingHub();
    const { result, c } = await run({
      input: { record },
      hub,
      failRollout: rollout,
    });
    await expect(result).rejects.toThrow(/timed out waiting/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      'unique-id': 'orders-task-1',
      // The Service's label does not count: only workloads name the node they run.
      'applies-to': ['web-service'],
      data: {
        status: 'failed',
        'start-time': expect.any(String),
        'end-time': expect.any(String),
      },
    });
    const notes: string = posted[0].data.notes;
    expect(notes).toContain('timed out waiting for the condition');
    expect(notes).not.toContain('\n');
    // The lines of the error are joined, so the notes stay one line.
    expect(notes).toContain('web-service second line');
    expect(c.output).not.toHaveBeenCalledWith('endTime', expect.anything());
  });

  it('applies to every architecture node when no workload names one', async () => {
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'workloads.yaml'),
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n',
    );
    const { hub, posted } = fakeRecordingHub();
    const { result } = await run({
      input: { record },
      hub,
      failRollout: rollout,
    });
    await expect(result).rejects.toThrow(/timed out waiting/);
    expect(posted[0]['applies-to']).toEqual([
      'web-service',
      'api-gateway',
      'mongo-database',
    ]);
  });

  it('calls no Hub without record', async () => {
    const { hub } = fakeRecordingHub();
    const { result } = await run({ hub, failRollout: rollout });
    await expect(result).rejects.toThrow(/timed out waiting/);
    expect(hub.createDecorator).not.toHaveBeenCalled();
    expect(hub.architectures).not.toHaveBeenCalled();
  });

  it('rejects with the deploy error and warns when recording fails', async () => {
    const { hub } = fakeRecordingHub({ failPost: true });
    const { result, c } = await run({
      input: { record },
      hub,
      failRollout: rollout,
    });
    await expect(result).rejects.toThrow(/timed out waiting/);
    expect(c.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Could not record the failed deployment.*hub is down/,
      ),
    );
  });

  it('records nothing when it fails before the deployment started', async () => {
    const { hub } = fakeRecordingHub();
    const { result } = await run({
      input: { record },
      hub,
      namespace: {
        metadata: { labels: { 'calm.finos.org/service': 'billing' } },
      },
    });
    await expect(result).rejects.toThrow(/belongs to the service "billing"/);
    expect(hub.createDecorator).not.toHaveBeenCalled();
  });
});
