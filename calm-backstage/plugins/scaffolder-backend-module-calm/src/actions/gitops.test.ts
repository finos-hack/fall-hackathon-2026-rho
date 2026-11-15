import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  git,
  gitCommitAll,
  gitInit,
  gitPush,
} from '@internal/backstage-plugin-calm-node';
import {
  createCalmDeployGitopsAction,
  waitForKustomization,
} from './deployGitops';
import { GITOPS_OVERLAY_HEADER, writeOverlay } from './deployK8s';
import {
  createCalmGitPublishAction,
  withGitAnnotations,
  withGitopsAnnotations,
} from './gitPublish';

let root: string;
let localDir: string;
let remoteBase: string;
let kubeconfig: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-gitops-'));
  localDir = path.join(root, 'output');
  remoteBase = path.join(root, 'git');
  await fs.mkdir(path.join(remoteBase, 'calm-services'), { recursive: true });
  kubeconfig = path.join(root, 'kubeconfig');
  await fs.writeFile(kubeconfig, '');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ctx = (input: object) =>
  ({
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: jest.fn(),
    workspacePath: root,
    task: { id: 'task-test' },
  } as any);
const outputs = (c: any) =>
  Object.fromEntries(c.output.mock.calls.map((x: any[]) => [x[0], x[1]]));

/** A bare repository standing in for Gitea's push-to-create. */
async function bare(name: string) {
  const dir = path.join(remoteBase, 'calm-services', `${name}.git`);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '--bare', '-b', 'main']);
  return dir;
}

const gitops = () => ({
  gitUrl: `file://${remoteBase}`,
  clusterGitUrl: 'http://host.minikube.internal:3300',
  servicesOrg: 'calm-services',
  templatesRepo: 'calm-templates/bundles',
  branch: 'main',
  auth: { username: 'calm', password: 'pw' },
});
const settings = () => ({
  kubeconfig,
  context: 'calm-backstage',
  minikubeProfile: 'calm-backstage',
  namespacePrefix: 'calm-',
});

async function service(name: string) {
  const dir = path.join(localDir, name);
  await fs.mkdir(path.join(dir, 'deploy', 'k8s'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'deploy', 'k8s', 'kustomization.yaml'),
    'resources: []\n',
  );
  await fs.writeFile(
    path.join(dir, 'catalog-info.yaml'),
    YAML.stringify({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name,
        annotations: { 'calm.finos.org/bundle': 'node-service' },
        tags: ['calm'],
      },
      spec: { type: 'service' },
    }),
  );
  return dir;
}

describe('withGitAnnotations', () => {
  it('adds the Kustomization and the calm-gitops tag once deployed, and the repository with a link, once', () => {
    const once = withGitAnnotations(
      YAML.stringify({ metadata: { name: 'orders', tags: ['calm'] } }),
      { name: 'orders', repoUrl: 'http://localhost:3300/calm-services/orders' },
    );
    const twice = YAML.parse(
      withGitopsAnnotations(
        withGitopsAnnotations(
          withGitAnnotations(once, {
            name: 'orders',
            repoUrl: 'http://localhost:3300/calm-services/orders',
          }),
          'orders',
        ),
        'orders',
      ),
    );
    expect(
      YAML.parse(once).metadata.annotations['calm.finos.org/gitops'],
    ).toBeUndefined();
    expect(twice.metadata.annotations).toEqual({
      'calm.finos.org/git-repo': 'http://localhost:3300/calm-services/orders',
      'calm.finos.org/gitops': 'flux-system/calm-orders',
    });
    expect(twice.metadata.tags).toEqual(['calm', 'calm-gitops']);
    expect(twice.metadata.links).toHaveLength(1);
  });
});

describe('calm:git:publish', () => {
  it('commits the folder with the Git annotations and pushes it', async () => {
    const remote = await bare('orders');
    const dir = await service('orders');
    const c = ctx({ dir, name: 'orders' });
    await createCalmGitPublishAction({ settings: gitops(), localDir }).handler(
      c,
    );
    const out = outputs(c);
    expect(out.repoUrl).toBe(`file://${remoteBase}/calm-services/orders`);
    expect(await git(remote, ['rev-parse', 'main'])).toBe(out.commit);
    expect(out.shortCommit).toBe(out.commit.slice(0, 12));
    const pushed = await git(remote, ['show', 'main:catalog-info.yaml']);
    expect(pushed).toContain('calm.finos.org/git-repo:');
    // Not deployed yet: the service is not offered for upgrades until calm:deploy:gitops has run.
    expect(pushed).not.toContain('calm.finos.org/gitops');
    expect(await git(dir, ['remote', 'get-url', 'origin'])).toBe(
      `file://${remoteBase}/calm-services/orders.git`,
    );
  });

  it('refuses a remote that has commits the working copy lacks', async () => {
    const remote = await bare('orders');
    const earlier = path.join(root, 'earlier');
    await fs.mkdir(earlier);
    await fs.writeFile(path.join(earlier, 'x'), 'old');
    await gitInit(earlier);
    await gitCommitAll(earlier, 'old service');
    await gitPush(earlier, `file://${remote}`, 'main');

    const dir = await service('orders');
    await expect(
      createCalmGitPublishAction({ settings: gitops(), localDir }).handler(
        ctx({ dir, name: 'orders' }),
      ),
    ).rejects.toThrow(
      /refused \(rejected\).*delete that repository or pick another name/,
    );
  });
});

/** A kubectl that answers from the state of a fake cluster; Flux "applies" the remote's main. */
function fakeKubectl(opts: {
  remote: string;
  namespace?: any;
  failFlux?: string;
}) {
  const calls: string[][] = [];
  /** What each `apply` applied, its arguments before `-f`, and the remote's main at that moment. */
  const applied: {
    objects: any[];
    flags: string[];
    remoteMain: string;
    call: number;
  }[] = [];
  const kubectl = async (args: string[]) => {
    calls.push(args);
    const a = args.join(' ');
    if (args[0] === 'apply') {
      const f = args.indexOf('-f');
      applied.push({
        objects: YAML.parseAllDocuments(await fs.readFile(args[f + 1], 'utf-8'))
          .map(d => d.toJSON())
          .filter(Boolean),
        flags: args.slice(1, f),
        remoteMain: await git(opts.remote, ['rev-parse', 'main']),
        call: calls.length - 1,
      });
      return '';
    }
    if (a.startsWith('get namespace')) {
      return opts.namespace ? JSON.stringify(opts.namespace) : '';
    }
    if (a.includes('get kustomization')) {
      const sha = await git(opts.remote, ['rev-parse', 'main']);
      return JSON.stringify({
        status: opts.failFlux
          ? {
              conditions: [
                { type: 'Ready', status: 'False', message: opts.failFlux },
              ],
            }
          : {
              conditions: [
                {
                  type: 'Ready',
                  status: 'True',
                  message: `Applied revision: main@sha1:${sha}`,
                },
              ],
              lastAppliedRevision: `main@sha1:${sha}`,
            },
      });
    }
    if (a.includes('get deployments,networkpolicies,services')) {
      return JSON.stringify({
        items: [
          { kind: 'Deployment', metadata: { name: 'web-service' } },
          {
            kind: 'Service',
            metadata: { name: 'api-gateway' },
            spec: { ports: [{ port: 80 }] },
          },
        ],
      });
    }
    return '';
  };
  return { calls, applied, kubectl };
}

describe('calm:deploy:gitops', () => {
  async function published(name: string) {
    const remote = await bare(name);
    const dir = await service(name);
    await createCalmGitPublishAction({ settings: gitops(), localDir }).handler(
      ctx({ dir, name }),
    );
    return { remote, dir };
  }

  it('commits deploy/k8s-overlay, pushes, applies the Flux objects, annotates requestedAt and waits for the pushed sha', async () => {
    const { remote, dir } = await published('orders');
    const fake = fakeKubectl({ remote });
    const c = ctx({ dir, name: 'orders', image: 'orders:abc123' });
    await createCalmDeployGitopsAction({
      settings: settings(),
      gitops: gitops(),
      localDir,
      kubectl: () => fake.kubectl,
      wait: { pollMs: 1, timeoutMs: 1000 },
    }).handler(c);
    const out = outputs(c);
    expect(await git(remote, ['rev-parse', 'main'])).toBe(out.commit);
    expect(await git(remote, ['log', '-1', '--format=%s', 'main'])).toBe(
      'Deploy orders:abc123',
    );
    const overlay = YAML.parse(
      await git(remote, ['show', 'main:deploy/k8s-overlay/kustomization.yaml']),
    );
    expect(overlay.images).toEqual([
      { name: 'calm-service', newName: 'orders', newTag: 'abc123' },
    ]);
    expect(await git(remote, ['show', 'main:catalog-info.yaml'])).toContain(
      'calm.finos.org/gitops: flux-system/calm-orders',
    );
    expect(out).toMatchObject({
      namespace: 'calm-orders',
      deployments: ['web-service'],
      services: ['api-gateway:80'],
      kustomization: 'flux-system/calm-orders',
    });
    const applied = fake.calls.find(c2 => c2[0] === 'apply');
    expect(applied).toBeDefined();
    const annotate = fake.calls.find(c2 => c2.includes('annotate'))!;
    expect(annotate).toEqual(
      expect.arrayContaining([
        'gitrepository/calm-orders',
        'kustomization/calm-orders',
      ]),
    );
    expect(annotate.at(-1)).toMatch(/^reconcile\.fluxcd\.io\/requestedAt=/);
    expect(fake.calls.some(c2 => c2.includes('rollout'))).toBe(true);
  });

  it('applies the prune-disabled namespace, service account and role binding before the push that drops namespace.yaml, and Flux applies as that account', async () => {
    const { remote, dir } = await published('orders');
    // Deployed before Flux had a service account: the overlay on main holds the Namespace.
    await writeOverlay(
      dir,
      { name: 'orders', namespace: 'calm-orders', image: 'orders:old' },
      GITOPS_OVERLAY_HEADER,
    );
    await gitCommitAll(dir, 'Deploy orders:old');
    await gitPush(dir, `file://${remote}`, 'main');
    const before = await git(remote, ['rev-parse', 'main']);
    expect(
      await git(remote, ['show', 'main:deploy/k8s-overlay/namespace.yaml']),
    ).toContain('kind: Namespace');
    const fake = fakeKubectl({ remote });
    const c = ctx({ dir, name: 'orders', image: 'orders:abc123' });
    await createCalmDeployGitopsAction({
      settings: settings(),
      gitops: gitops(),
      localDir,
      kubectl: () => fake.kubectl,
      wait: { pollMs: 1, timeoutMs: 1000 },
    }).handler(c);
    const kinds = fake.applied.map(x => x.objects.map(o => o.kind));
    expect(kinds).toEqual([
      [
        'Namespace',
        'ServiceAccount',
        'RoleBinding',
        'ClusterRole',
        'ClusterRoleBinding',
      ],
      ['GitRepository', 'Kustomization'],
    ]);
    const [tenant, flux] = fake.applied;
    // The prune-disabled Namespace is on the cluster before Flux sees an overlay without it.
    expect(tenant.remoteMain).toBe(before);
    // Server-side apply under its own field manager: Flux takes over fields owned by kubectl's managers.
    expect(tenant.flags).toEqual([
      '--server-side',
      '--field-manager=calm-backstage',
      '--force-conflicts',
    ]);
    expect(flux.flags).toEqual([]);
    expect(tenant.objects[0]).toMatchObject({
      metadata: {
        name: 'calm-orders',
        labels: { 'calm.finos.org/service': 'orders' },
        annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
      },
    });
    expect(flux.remoteMain).toBe(outputs(c).commit);
    expect(flux.objects[1].spec).toMatchObject({
      serviceAccountName: 'calm-orders',
      targetNamespace: 'calm-orders',
    });
    const annotate = fake.calls.findIndex(c2 => c2.includes('annotate'));
    expect(tenant.call).toBeLessThan(flux.call);
    expect(flux.call).toBeLessThan(annotate);
    expect(
      await git(remote, [
        'ls-tree',
        '--name-only',
        'main',
        'deploy/k8s-overlay/',
      ]),
    ).toBe('deploy/k8s-overlay/kustomization.yaml');
    const overlay = YAML.parse(
      await git(remote, ['show', 'main:deploy/k8s-overlay/kustomization.yaml']),
    );
    expect(overlay.resources).toEqual(['../k8s']);
  });

  it('makes no commit when the overlay already deploys the image', async () => {
    const { remote, dir } = await published('orders');
    const fake = fakeKubectl({ remote });
    const action = createCalmDeployGitopsAction({
      settings: settings(),
      gitops: gitops(),
      localDir,
      kubectl: () => fake.kubectl,
      wait: { pollMs: 1, timeoutMs: 1000 },
    });
    await action.handler(ctx({ dir, name: 'orders', image: 'orders:abc123' }));
    const first = await git(remote, ['rev-parse', 'main']);
    const c = ctx({ dir, name: 'orders', image: 'orders:abc123' });
    await action.handler(c);
    expect(await git(remote, ['rev-parse', 'main'])).toBe(first);
    expect(outputs(c).commit).toBe(first);
  });

  it('refuses a namespace owned by another service before committing', async () => {
    const { remote, dir } = await published('orders');
    const before = await git(remote, ['rev-parse', 'main']);
    const fake = fakeKubectl({
      remote,
      namespace: {
        metadata: { labels: { 'calm.finos.org/service': 'billing' } },
      },
    });
    await expect(
      createCalmDeployGitopsAction({
        settings: settings(),
        gitops: gitops(),
        localDir,
        kubectl: () => fake.kubectl,
      }).handler(ctx({ dir, name: 'orders', image: 'orders:abc' })),
    ).rejects.toThrow(/belongs to the service "billing"/);
    expect(await git(remote, ['rev-parse', 'main'])).toBe(before);
  });
});

describe('waitForKustomization', () => {
  it('fails with the Ready message after the timeout', async () => {
    let t = 0;
    const kubectl = async () =>
      JSON.stringify({
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              message: 'failed to checkout: connection refused',
            },
          ],
        },
      });
    await expect(
      waitForKustomization(kubectl, 'orders', 'a'.repeat(40), {
        timeoutMs: 10_000,
        pollMs: 2_000,
        now: () => t,
        sleep: async ms => {
          t += ms;
        },
      }),
    ).rejects.toThrow(
      /did not apply aaaaaaaaaaaa within 10 s.*not Ready.*connection refused/,
    );
  });

  it('keeps waiting while Flux has applied an older commit', async () => {
    const sha = 'b'.repeat(40);
    let polls = 0;
    const kubectl = async () => {
      polls++;
      const rev = polls < 3 ? 'a'.repeat(40) : sha;
      return JSON.stringify({
        status: {
          conditions: [{ type: 'Ready', status: 'True', message: 'ok' }],
          lastAppliedRevision: `main@sha1:${rev}`,
        },
      });
    };
    const s = await waitForKustomization(kubectl, 'orders', sha, {
      pollMs: 0,
      sleep: async () => {},
    });
    expect(polls).toBe(3);
    expect(s.appliedRevision).toBe(`main@sha1:${sha}`);
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

describe('calm:deploy:gitops: a failed deployment', () => {
  const failing = async () => {
    const remote = await bare('orders');
    const dir = await service('orders');
    await createCalmGitPublishAction({ settings: gitops(), localDir }).handler(
      ctx({ dir, name: 'orders' }),
    );
    await fs.writeFile(
      path.join(dir, 'deploy', 'k8s', 'workloads.yaml'),
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web-service\n  labels:\n    calm.finos.org/node: web-service\n',
    );
    await fs.writeFile(
      path.join(root, 'architecture.json'),
      JSON.stringify({
        nodes: [{ 'unique-id': 'web-service' }, { 'unique-id': 'mongo' }],
      }),
    );
    return { remote, dir };
  };
  const run = async (opts: {
    input?: object;
    hub?: any;
    namespace?: object;
    failFlux?: string;
    branch?: string;
  }) => {
    const { remote, dir } = await failing();
    if (opts.branch) {
      await git(dir, ['checkout', '-q', '-b', opts.branch]);
    }
    const fake = fakeKubectl({
      remote,
      failFlux: opts.failFlux ?? 'kustomize build failed',
      namespace: opts.namespace,
    });
    const c = ctx({
      dir,
      name: 'orders',
      image: 'orders:abc',
      ...opts.input,
    });
    c.task = { id: 'task-1' };
    const result = createCalmDeployGitopsAction({
      settings: settings(),
      gitops: gitops(),
      localDir,
      kubectl: () => fake.kubectl,
      wait: { pollMs: 1, timeoutMs: 20 },
      hub: opts.hub,
      appBaseUrl: 'http://localhost:3100',
    }).handler(c);
    return { result, c };
  };
  it('records a failed decorator when Flux does not apply the commit, and rethrows', async () => {
    const { hub, posted } = fakeRecordingHub();
    const { result } = await run({ input: { record }, hub });
    await expect(result).rejects.toThrow(/kustomize build failed/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      'applies-to': ['web-service'],
      data: { status: 'failed', 'start-time': expect.any(String) },
    });
    expect(posted[0].data.notes).toContain('kustomize build failed');
  });

  it('calls no Hub without record', async () => {
    const { hub } = fakeRecordingHub();
    const { result } = await run({ hub });
    await expect(result).rejects.toThrow(/kustomize build failed/);
    expect(hub.createDecorator).not.toHaveBeenCalled();
  });

  it('rejects with the deploy error and warns when recording fails', async () => {
    const { hub } = fakeRecordingHub({ failPost: true });
    const { result, c } = await run({ input: { record }, hub });
    await expect(result).rejects.toThrow(/kustomize build failed/);
    expect(c.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Could not record the failed deployment.*hub is down/,
      ),
    );
  });

  it('records nothing when the namespace belongs to another service', async () => {
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

  it('records nothing when the working copy is on another branch', async () => {
    const { hub } = fakeRecordingHub();
    const { result } = await run({ input: { record }, hub, branch: 'feature' });
    await expect(result).rejects.toThrow(/is on the branch feature, not main/);
    expect(hub.architectures).not.toHaveBeenCalled();
    expect(hub.createDecorator).not.toHaveBeenCalled();
  });
});
