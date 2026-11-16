import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  KUBERNETES_ANNOTATIONS as K8S,
  namespaceManifest,
} from '@internal/backstage-plugin-calm-common';
import {
  GITOPS_OVERLAY_HEADER,
  applyArgs,
  checkExistingNamespace,
  createCalmDeployK8sAction,
  overlayKustomization,
  parseImage,
  planFromBase,
  summariseObjects,
  writeOverlay,
} from './deployK8s';
import { createCalmClusterCheckAction } from './clusterCheck';
import { createCalmImageBuildAction, imageReference } from './imageBuild';
import { serviceEntity } from './publishLocal';

/** Every file under `dir`, by relative path, with its content. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const out: Record<string, string> = {};
  for (const f of files.filter(x => x.isFile())) {
    const abs = path.join(f.parentPath, f.name);
    out[path.relative(dir, abs)] = await fs.readFile(abs, 'utf-8');
  }
  return out;
}

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
          'pod-security.kubernetes.io/enforce': 'baseline',
          'pod-security.kubernetes.io/warn': 'baseline',
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

describe('writeOverlay', () => {
  const opts = {
    name: 'stock-api',
    namespace: 'calm-stock-api',
    image: 'stock-api:run-1',
  };
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-overlay-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const read = async (overlayDir: string) => ({
    files: (await fs.readdir(overlayDir)).sort(),
    kustomization: YAML.parse(
      await fs.readFile(path.join(overlayDir, 'kustomization.yaml'), 'utf-8'),
    ),
  });

  it('keeps the Namespace in the overlay kubectl applies', async () => {
    const overlay = await read(await writeOverlay(dir, opts, '# kubectl'));
    expect(overlay.files).toEqual(['kustomization.yaml', 'namespace.yaml']);
    expect(overlay.kustomization.resources).toEqual([
      'namespace.yaml',
      '../k8s',
    ]);
  });

  it('enforces Pod Security baseline on the Namespace kubectl applies', async () => {
    const overlayDir = await writeOverlay(dir, opts, '# kubectl');
    const ns = YAML.parse(
      await fs.readFile(path.join(overlayDir, 'namespace.yaml'), 'utf-8'),
    );
    expect(ns.kind).toBe('Namespace');
    expect(ns.metadata.labels).toMatchObject({
      'pod-security.kubernetes.io/enforce': 'baseline',
      'pod-security.kubernetes.io/warn': 'baseline',
    });
  });

  it('leaves the Namespace out of the overlay Flux applies, and removes one an earlier deploy wrote', async () => {
    await writeOverlay(dir, opts, '# kubectl');
    const overlay = await read(
      await writeOverlay(dir, opts, GITOPS_OVERLAY_HEADER, {
        withNamespace: false,
      }),
    );
    expect(overlay.files).toEqual(['kustomization.yaml']);
    expect(overlay.kustomization.resources).toEqual(['../k8s']);
    expect(overlay.kustomization.namespace).toBe('calm-stock-api');
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
        // The same node under an earlier converted name, which remains until it is pruned: listed once in nodes.
        {
          kind: 'Deployment',
          metadata: {
            name: 'orders-api-1x2y3z',
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
      deployments: [
        'api-gateway',
        'orders-api',
        'orders-api-1x2y3z',
        'web-service',
      ],
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
      task: { id: 'task-test' },
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

  it('image build in a dry run spawns nothing and gives the image', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-image-dry-'));
    const kubeconfig = path.join(tmp, 'config');
    await fs.writeFile(kubeconfig, '');
    const settings = {
      kubeconfig,
      context: 'calm-backstage',
      minikubeProfile: 'calm-backstage',
      namespacePrefix: 'calm-',
    };
    const dryDir = path.join(tmp, 'dry-run-output', 'stock-api');
    const c = {
      ...ctx({ ...build, dir: dryDir }),
      workspacePath: tmp,
      isDryRun: true,
    };
    const path0 = process.env.PATH;
    process.env.PATH = '';
    try {
      await createCalmImageBuildAction({ settings, localDir }).handler(c);
      expect(c.output).toHaveBeenCalledWith('image', 'stock-api:run-1');
      expect(c.logger.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Dry run: would run .*minikube -p calm-backstage image build -t stock-api:run-1 .*dry-run-output.stock-api$/,
        ),
      );
      await expect(
        createCalmImageBuildAction({ settings, localDir }).handler({
          ...c,
          input: { ...build, dir: dryDir, tag: 'latest' },
        }),
      ).rejects.toThrow(/latest is refused/);
      await expect(
        createCalmImageBuildAction({ localDir }).handler(c),
      ).rejects.toThrow(/are not set/);
      // Without a dry run the dry-run folder is refused.
      await expect(
        createCalmImageBuildAction({ settings, localDir }).handler({
          ...c,
          isDryRun: false,
        }),
      ).rejects.toThrow(/outside/i);
    } finally {
      process.env.PATH = path0;
      await fs.rm(tmp, { recursive: true, force: true });
    }
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
    hub: { namespace: 'hackathon', architecture: 'x', version: '1.0.0' },
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
    // The real client gives a copy that sends the signal with each request; this one is the same fake.
    withSignal: jest.fn((): any => hub),
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
      'resources:\n  - workloads.yaml\n',
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
    failApply?: string;
    signal?: AbortSignal;
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
      signal: opts.signal,
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
      if (a.startsWith('apply') && opts.failApply) {
        throw new Error(opts.failApply);
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
      // Not the unique-id a successful retry of the task records.
      'unique-id': 'orders-task-1-failed',
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

  it('applies to the unique-id of a workload with a converted name', async () => {
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'workloads.yaml'),
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: web-service-ab12cd',
        '  annotations:',
        '    calm.finos.org/unique-id: Web_Service',
        '  labels:',
        '    calm.finos.org/node: web-service-ab12cd',
        '---',
        'apiVersion: apps/v1',
        'kind: StatefulSet',
        'metadata:',
        '  name: mongo-database',
        '  labels:',
        '    calm.finos.org/node: mongo-database',
        '',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(root, 'architecture.json'),
      JSON.stringify({
        nodes: [
          { 'unique-id': 'Web_Service' },
          { 'unique-id': 'mongo-database' },
        ],
      }),
    );
    const { hub, posted } = fakeRecordingHub();
    const { result } = await run({
      input: { record },
      hub,
      failRollout: rollout,
    });
    await expect(result).rejects.toThrow(/timed out waiting/);
    expect(posted).toHaveLength(1);
    expect(posted[0]['applies-to']).toEqual(['Web_Service', 'mongo-database']);
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

  it('records nothing when the overlay cannot be written, before any kubectl apply', async () => {
    // A file where the overlay folder goes.
    await fs.writeFile(path.join(dir, 'deploy', 'k8s-overlay'), 'not a folder');
    const { hub } = fakeRecordingHub();
    const { result, kubectl } = await run({ input: { record }, hub });
    await expect(result).rejects.toThrow(/k8s-overlay/);
    expect(kubectl).not.toHaveBeenCalled();
    expect(hub.createDecorator).not.toHaveBeenCalled();
  });

  it('records nothing, and still rejects with the deploy error, when the task was cancelled', async () => {
    const { hub } = fakeRecordingHub();
    const { result } = await run({
      input: { record },
      hub,
      failRollout: rollout,
      signal: AbortSignal.abort(),
    });
    await expect(result).rejects.toThrow(/timed out waiting/);
    expect(hub.architectures).not.toHaveBeenCalled();
    expect(hub.createDecorator).not.toHaveBeenCalled();
  });

  it('records a failed decorator when kubectl apply fails', async () => {
    const { hub, posted } = fakeRecordingHub();
    const { result } = await run({
      input: { record },
      hub,
      failApply: 'error: the server rejected the manifest',
    });
    await expect(result).rejects.toThrow(/server rejected the manifest/);
    expect(posted).toHaveLength(1);
    expect(posted[0].data.status).toBe('failed');
  });
});

describe('calm:deploy:k8s: a dry run', () => {
  let root: string;
  let dir: string;
  const localDir = () => path.join(root, 'output');
  const settings = () => ({
    kubeconfig: path.join(root, 'kubeconfig'),
    context: 'calm-backstage',
    minikubeProfile: 'calm-backstage',
    namespacePrefix: 'calm-',
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-deploy-dry-'));
    await fs.writeFile(path.join(root, 'kubeconfig'), '');
    dir = path.join(root, 'dry-run-output', 'orders');
    await fs.mkdir(path.join(dir, 'deploy', 'k8s'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'kustomization.yaml'),
      'resources:\n  - workloads.yaml\n',
    );
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'workloads.yaml'),
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: web-deployment',
        '  annotations:',
        '    calm.finos.org/unique-id: web-service',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: web',
        'spec:',
        '  ports:',
        '    - port: 8080',
        '---',
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: web-policy',
        '',
      ].join('\n'),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = (input: object = {}) =>
    ({
      input: { dir, name: 'orders', image: 'orders:dry-run', ...input },
      logger: { info: jest.fn(), warn: jest.fn() },
      output: jest.fn(),
      workspacePath: root,
      task: { id: 'task-1' },
      isDryRun: true,
    } as any);
  const outs = (c: any) =>
    Object.fromEntries(c.output.mock.calls.map((x: any[]) => [x[0], x[1]]));

  it('calls no kubectl, writes the overlay in the dry-run folder and derives the outputs from the base', async () => {
    const kubectl = jest.fn(async () => '');
    const { hub } = fakeRecordingHub();
    const c = context({ record });
    await createCalmDeployK8sAction({
      settings: settings(),
      localDir: localDir(),
      kubectl: () => kubectl,
      hub,
      appBaseUrl: 'http://backstage',
    }).handler(c);
    expect(kubectl).not.toHaveBeenCalled();
    // Nothing failed and nothing is recorded: no decorator is posted.
    expect(hub.createDecorator).not.toHaveBeenCalled();
    expect(outs(c)).toMatchObject({
      namespace: 'calm-orders',
      deployments: ['web-deployment'],
      nodes: ['web-service'],
      networkPolicies: ['web-policy'],
      services: ['web:8080'],
      cluster: 'calm-backstage',
      kubectl: expect.stringContaining('-n calm-orders'),
      startTime: expect.any(String),
      endTime: expect.any(String),
    });
    expect(await fs.readdir(path.join(dir, 'deploy', 'k8s-overlay'))).toContain(
      'kustomization.yaml',
    );
    const logged = c.logger.info.mock.calls.map((x: any[]) => x[0]);
    expect(
      logged.every((l: string) => /^(Dry run: would |Wrote )/.test(l)),
    ).toBe(true);
    expect(logged.join('\n')).toMatch(
      /Dry run: would apply 3 objects into calm-orders: Deployment\/web-deployment, Service\/web/,
    );
    expect(logged.join('\n')).toMatch(
      /Dry run: would run .*kubectl.* apply -k/,
    );
  });

  it('writes nothing in a localDir folder, logs the overlay it would write and still gives the outputs', async () => {
    const published = path.join(localDir(), 'orders');
    await fs.cp(dir, published, { recursive: true });
    const before = await snapshot(published);
    const kubectl = jest.fn(async () => '');
    const c = context({ dir: published });
    await createCalmDeployK8sAction({
      settings: settings(),
      localDir: localDir(),
      kubectl: () => kubectl,
    }).handler(c);
    expect(await snapshot(published)).toEqual(before);
    expect(kubectl).not.toHaveBeenCalled();
    expect(outs(c)).toMatchObject({
      namespace: 'calm-orders',
      deployments: ['web-deployment'],
      nodes: ['web-service'],
      networkPolicies: ['web-policy'],
      services: ['web:8080'],
      cluster: 'calm-backstage',
      kubectl: expect.stringContaining('-n calm-orders'),
    });
    const logged = c.logger.info.mock.calls.map((x: any[]) => x[0]);
    expect(
      logged.every((l: string) =>
        /^Dry run: (would |the overlay would be:\n)/.test(l),
      ),
    ).toBe(true);
  });

  it('in a localDir folder logs one line tying the kubectl command to the overlay it would write, and the overlay, not the stale one there', async () => {
    const published = path.join(localDir(), 'orders');
    await fs.cp(dir, published, { recursive: true });
    const staleFile = path.join(
      published,
      'deploy',
      'k8s-overlay',
      'kustomization.yaml',
    );
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(
      staleFile,
      'namespace: calm-old\nimages:\n  - name: placeholder\n    newName: old-image\n    newTag: v0\n',
    );
    const before = await snapshot(published);
    const c = context({ dir: published });
    await createCalmDeployK8sAction({
      settings: settings(),
      localDir: localDir(),
      kubectl: () => jest.fn(async () => ''),
    }).handler(c);
    expect(await snapshot(published)).toEqual(before);
    const logged: string[] = c.logger.info.mock.calls.map((x: any[]) => x[0]);
    const overlayDir = path.join(published, 'deploy', 'k8s-overlay');
    const combined = logged.filter(l =>
      l.startsWith('Dry run: would write the overlay'),
    );
    expect(combined).toHaveLength(1);
    expect(combined[0]).toContain(overlayDir);
    expect(combined[0]).toContain('orders:dry-run');
    expect(combined[0]).toContain('calm-orders');
    expect(combined[0]).toMatch(/then run .*kubectl.* apply -k /);
    expect(combined[0]).toContain(`apply -k ${overlayDir}`);
    // No line runs kubectl on its own, without saying the overlay is written first.
    expect(
      logged.filter(l => /would run/.test(l) && !/would write/.test(l)),
    ).toEqual([]);
    const shown = logged.find(l =>
      l.startsWith('Dry run: the overlay would be:'),
    );
    expect(shown).toBeDefined();
    expect(shown).toContain('\n# Written by calm:deploy:k8s. Apply by hand');
    const yaml = YAML.parse(shown!.slice(shown!.indexOf('\n') + 1));
    expect(yaml.namespace).toBe('calm-orders');
    expect(yaml.images).toEqual([
      expect.objectContaining({ newName: 'orders', newTag: 'dry-run' }),
    ]);
    expect(shown).not.toContain('old-image');
    expect(shown).not.toContain('calm-old');
  });

  it('still fails without the cluster settings, with a missing base, and outside both folders', async () => {
    await expect(
      createCalmDeployK8sAction({ localDir: localDir() }).handler(context()),
    ).rejects.toThrow(/are not set/);
    await fs.rm(path.join(dir, 'deploy', 'k8s', 'kustomization.yaml'));
    await expect(
      createCalmDeployK8sAction({
        settings: settings(),
        localDir: localDir(),
      }).handler(context()),
    ).rejects.toThrow(/no kustomization.yaml/);
    await expect(
      createCalmDeployK8sAction({
        settings: settings(),
        localDir: localDir(),
      }).handler(context({ dir: path.join(root, 'elsewhere') })),
    ).rejects.toThrow(/outside/i);
  });
});

describe('planFromBase', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-plan-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  /** Writes files under `dir` by relative path; `kustomization.yaml` of the base lists `resources`. */
  const put = async (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    }
  };
  const kustomization = (...resources: string[]) =>
    `resources:\n${resources.map(r => `  - ${r}\n`).join('')}`;
  const cm = (name: string) =>
    `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n`;

  it('names an object without a metadata.name as Kind/?', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('objects.yaml'),
      'deploy/k8s/objects.yaml': 'apiVersion: v1\nkind: ConfigMap\n',
    });
    expect((await planFromBase(dir)).objects).toEqual(['ConfigMap/?']);
  });

  it('follows the resources in the order they are listed, not the file names', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('b.yaml', 'a.yaml'),
      'deploy/k8s/a.yaml': cm('a'),
      'deploy/k8s/b.yaml': `${cm('b1')}---\n${cm('b2')}`,
    });
    expect((await planFromBase(dir)).objects).toEqual([
      'ConfigMap/b1',
      'ConfigMap/b2',
      'ConfigMap/a',
    ]);
  });

  it('does not count a yaml file the kustomization does not list', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('listed.yaml'),
      'deploy/k8s/listed.yaml': cm('listed'),
      'deploy/k8s/unlisted.yaml': cm('unlisted'),
    });
    expect((await planFromBase(dir)).objects).toEqual(['ConfigMap/listed']);
  });

  it('does not count a kustomization.yml in the base as an object file', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('listed.yaml'),
      'deploy/k8s/listed.yaml': cm('listed'),
      'deploy/k8s/kustomization.yml': `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n`,
    });
    expect((await planFromBase(dir)).objects).toEqual(['ConfigMap/listed']);
  });

  it('gives no objects without resources', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': 'namespace: x\n',
      'deploy/k8s/a.yaml': cm('a'),
    });
    expect((await planFromBase(dir)).objects).toEqual([]);
    await put({ 'deploy/k8s/kustomization.yaml': 'resources: []\n' });
    expect((await planFromBase(dir)).objects).toEqual([]);
  });

  it('takes the objects of a listed subdirectory from its own kustomization', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('first.yaml', 'extra'),
      'deploy/k8s/first.yaml': cm('first'),
      'deploy/k8s/extra/kustomization.yaml': kustomization('more.yaml'),
      'deploy/k8s/extra/more.yaml': cm('more'),
      'deploy/k8s/extra/unlisted.yaml': cm('unlisted'),
    });
    expect((await planFromBase(dir)).objects).toEqual([
      'ConfigMap/first',
      'ConfigMap/more',
    ]);
  });

  it('throws for an entry that leaves the published folder, though the target exists', async () => {
    await put({
      'pub/deploy/k8s/kustomization.yaml': kustomization('../../../x.yaml'),
      'x.yaml': cm('x'),
    });
    await expect(planFromBase(path.join(dir, 'pub'))).rejects.toThrow(
      /\.\.\/\.\.\/\.\.\/x\.yaml.*outside the published folder/,
    );
  });

  it('throws for a listed file that is a symlink to a file outside the published folder', async () => {
    await put({
      'pub/deploy/k8s/kustomization.yaml': kustomization('link.yaml'),
      'x.yaml': cm('x'),
    });
    await fs.symlink(
      path.join(dir, 'x.yaml'),
      path.join(dir, 'pub', 'deploy', 'k8s', 'link.yaml'),
    );
    await expect(planFromBase(path.join(dir, 'pub'))).rejects.toThrow(
      /link\.yaml.*outside the published folder/,
    );
  });

  it('throws for a resources value that is not a list', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': 'resources: a.yaml\n',
      'deploy/k8s/a.yaml': cm('a'),
    });
    await expect(planFromBase(dir)).rejects.toThrow(
      /resources in .*kustomization\.yaml is not a list/,
    );
  });

  it('throws on a directory symlink back to its own base as listed more than once', async () => {
    await put({ 'deploy/k8s/kustomization.yaml': kustomization('sub') });
    await fs.symlink('.', path.join(dir, 'deploy', 'k8s', 'sub'));
    await expect(planFromBase(dir)).rejects.toThrow(/more than once/);
  });

  it('throws for a remote entry, saying a dry run cannot read it', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization(
        'https://example.com/x.yaml',
      ),
    });
    await expect(planFromBase(dir)).rejects.toThrow(
      /https:\/\/example\.com\/x\.yaml.*remote|remote.*https:\/\/example\.com\/x\.yaml/s,
    );
  });

  it('throws naming a listed file that does not exist, and a directory without a kustomization', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('missing.yaml'),
    });
    await expect(planFromBase(dir)).rejects.toThrow(/missing\.yaml/);
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('sub'),
      'deploy/k8s/sub/a.yaml': cm('a'),
    });
    await expect(planFromBase(dir)).rejects.toThrow(/sub/);
  });

  it('throws on a directory listed in a cycle', async () => {
    await put({
      'deploy/k8s/kustomization.yaml': kustomization('sub'),
      'deploy/k8s/sub/kustomization.yaml': kustomization('..'),
    });
    await expect(planFromBase(dir)).rejects.toThrow(/more than once/);
  });
});
