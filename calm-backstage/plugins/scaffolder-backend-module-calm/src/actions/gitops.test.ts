import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { git, gitCommitAll, gitInit, gitPush } from '@internal/backstage-plugin-calm-node';
import { createCalmDeployGitopsAction, waitForKustomization } from './deployGitops';
import { createCalmGitPublishAction, withGitAnnotations } from './gitPublish';

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
  await fs.writeFile(path.join(dir, 'deploy', 'k8s', 'kustomization.yaml'), 'resources: []\n');
  await fs.writeFile(
    path.join(dir, 'catalog-info.yaml'),
    YAML.stringify({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name, annotations: { 'calm.finos.org/bundle': 'node-service' }, tags: ['calm'] },
      spec: { type: 'service' },
    }),
  );
  return dir;
}

describe('withGitAnnotations', () => {
  it('adds the repository, the Kustomization, the calm-gitops tag and a link, once', () => {
    const once = withGitAnnotations(
      YAML.stringify({ metadata: { name: 'orders', tags: ['calm'] } }),
      { name: 'orders', repoUrl: 'http://localhost:3300/calm-services/orders' },
    );
    const twice = YAML.parse(
      withGitAnnotations(once, {
        name: 'orders',
        repoUrl: 'http://localhost:3300/calm-services/orders',
      }),
    );
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
    await createCalmGitPublishAction({ settings: gitops(), localDir }).handler(c);
    const out = outputs(c);
    expect(out.repoUrl).toBe(`file://${remoteBase}/calm-services/orders`);
    expect(await git(remote, ['rev-parse', 'main'])).toBe(out.commit);
    expect(out.shortCommit).toBe(out.commit.slice(0, 12));
    const pushed = await git(remote, ['show', 'main:catalog-info.yaml']);
    expect(pushed).toContain('calm.finos.org/gitops: flux-system/calm-orders');
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
    ).rejects.toThrow(/refused \(rejected\).*delete that repository or pick another name/);
  });
});

/** A kubectl that answers from the state of a fake cluster; Flux "applies" the remote's main. */
function fakeKubectl(opts: { remote: string; namespace?: any; failFlux?: string }) {
  const calls: string[][] = [];
  const kubectl = async (args: string[]) => {
    calls.push(args);
    const a = args.join(' ');
    if (a.startsWith('get namespace')) {
      return opts.namespace ? JSON.stringify(opts.namespace) : '';
    }
    if (a.includes('get kustomization')) {
      const sha = await git(opts.remote, ['rev-parse', 'main']);
      return JSON.stringify({
        status: opts.failFlux
          ? { conditions: [{ type: 'Ready', status: 'False', message: opts.failFlux }] }
          : {
              conditions: [{ type: 'Ready', status: 'True', message: `Applied revision: main@sha1:${sha}` }],
              lastAppliedRevision: `main@sha1:${sha}`,
            },
      });
    }
    if (a.includes('get deployments,networkpolicies,services')) {
      return JSON.stringify({
        items: [
          { kind: 'Deployment', metadata: { name: 'web-service' } },
          { kind: 'Service', metadata: { name: 'api-gateway' }, spec: { ports: [{ port: 80 }] } },
        ],
      });
    }
    return '';
  };
  return { calls, kubectl };
}

describe('calm:deploy:gitops', () => {
  async function published(name: string) {
    const remote = await bare(name);
    const dir = await service(name);
    await createCalmGitPublishAction({ settings: gitops(), localDir }).handler(ctx({ dir, name }));
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
    expect(await git(remote, ['log', '-1', '--format=%s', 'main'])).toBe('Deploy orders:abc123');
    const overlay = YAML.parse(
      await git(remote, ['show', 'main:deploy/k8s-overlay/kustomization.yaml']),
    );
    expect(overlay.images).toEqual([{ name: 'calm-service', newName: 'orders', newTag: 'abc123' }]);
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
      expect.arrayContaining(['gitrepository/calm-orders', 'kustomization/calm-orders']),
    );
    expect(annotate.at(-1)).toMatch(/^reconcile\.fluxcd\.io\/requestedAt=/);
    expect(fake.calls.some(c2 => c2.includes('rollout'))).toBe(true);
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
      namespace: { metadata: { labels: { 'calm.finos.org/service': 'billing' } } },
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
            { type: 'Ready', status: 'False', message: 'failed to checkout: connection refused' },
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
    ).rejects.toThrow(/did not apply aaaaaaaaaaaa within 10 s.*not Ready.*connection refused/);
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
    const s = await waitForKustomization(kubectl, 'orders', sha, { pollMs: 0, sleep: async () => {} });
    expect(polls).toBe(3);
    expect(s.appliedRevision).toBe(`main@sha1:${sha}`);
  });
});
