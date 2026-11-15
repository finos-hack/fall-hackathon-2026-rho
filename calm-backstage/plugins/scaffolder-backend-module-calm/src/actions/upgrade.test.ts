import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { readBundleMeta } from '@internal/backstage-plugin-calm-common';
import {
  git,
  gitCommitAll,
  gitInit,
  gitPush,
} from '@internal/backstage-plugin-calm-node';
import {
  LEGACY_COPY_REMOVED,
  createCalmUpgradeRenderAction,
  upgradeBranch,
  withUpgradedBundles,
} from './upgradeRender';
import { createCalmUpgradeMergeAction, pullRequestBody } from './upgradeMerge';
import { GITOPS_OVERLAY_HEADER, writeOverlay } from './deployK8s';

let root: string;
let localDir: string;
let remoteBase: string;
let workspace: string;
let kubeconfig: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-upgrade-'));
  localDir = path.join(root, 'output');
  remoteBase = path.join(root, 'git');
  workspace = path.join(root, 'ws');
  await fs.mkdir(path.join(remoteBase, 'calm-services'), { recursive: true });
  await fs.mkdir(workspace);
  kubeconfig = path.join(root, 'kubeconfig');
  await fs.writeFile(kubeconfig, '');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

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

/** A kubectl standing in for the cluster: records what each `apply` applied, its arguments before `-f`, and the remote's branches then. */
function fakeKubectl(remote: string, namespace?: any) {
  const applied: { objects: any[]; flags: string[]; remoteBranches: string }[] =
    [];
  const kubectl = async (args: string[]) => {
    if (args[0] === 'get' && args[1] === 'namespace') {
      return namespace ? JSON.stringify(namespace) : '';
    }
    if (args[0] === 'apply') {
      const f = args.indexOf('-f');
      applied.push({
        objects: YAML.parseAllDocuments(await fs.readFile(args[f + 1], 'utf-8'))
          .map(d => d.toJSON())
          .filter(Boolean),
        flags: args.slice(1, f),
        remoteBranches: await git(remote, [
          'for-each-ref',
          '--format=%(refname:short) %(objectname)',
          'refs/heads',
        ]),
      });
    }
    return '';
  };
  return { applied, kubectl };
}

const ctx = (input: object) => {
  const outputs: Record<string, any> = {};
  return {
    input,
    outputs,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: (k: string, v: any) => {
      outputs[k] = v;
    },
    workspacePath: workspace,
    task: { id: 'task-test' },
    getInitiatorCredentials: async () => ({}),
  } as any;
};

const annotations = {
  'calm.finos.org/namespace': 'hackathon',
  'calm.finos.org/pattern': 'web-service',
  'calm.finos.org/bundle': 'node-service',
  'calm.finos.org/bundle-version': '1.0.0',
  'calm.finos.org/deploy-bundle': 'k8s-deploy',
  'calm.finos.org/deploy-bundle-version': '1.0.0',
  'calm.finos.org/gitops': 'flux-system/calm-orders',
  'calm.finos.org/architecture': 'orders',
  'calm.finos.org/architecture-version': '1.0.0',
};
const entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'orders',
    annotations,
    description:
      'rendered with the starter node-service 1.0.0 and the deployment rules k8s-deploy 1.0.0',
  },
  spec: {
    type: 'service',
    dependsOn: [
      'resource:default/pattern-web-service',
      'resource:default/bundle-node-service-1.0.0',
      'resource:default/bundle-k8s-deploy-1.0.0',
    ],
  },
};
const meta = (name: string, version: string, kind: string) =>
  readBundleMeta({
    name,
    version,
    kind,
    patterns: [{ namespace: 'hackathon', patternId: 'web-service' }],
  });

/** The architecture files the bundles were rendered against, in order. */
let renderedFrom: string[] = [];
beforeEach(() => {
  renderedFrom = [];
});

/** Each bundle version renders files whose content names it; node-service 1.1.0 drops src/old.js. */
const renderInto = async (bundle: string, arch: string, outDir: string) => {
  if (arch) {
    renderedFrom.push(arch);
  }
  let files: Record<string, string> = {
    'src/server.js': `// ${bundle}\n`,
    Dockerfile: 'FROM node\n',
  };
  if (bundle.startsWith('k8s-deploy')) {
    files = {
      'deploy/k8s/workloads.yaml': `# ${bundle}\n`,
      'deploy/k8s/kustomization.yaml': 'resources: [workloads.yaml]\n',
    };
  } else if (bundle === 'node-service@1.0.0') {
    files = { ...files, 'src/old.js': 'old\n' };
  }
  for (const [f, t] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(outDir, f)), { recursive: true });
    await fs.writeFile(path.join(outDir, f), t);
  }
  return {
    files: Object.keys(files).sort(),
    ref: `reg/${bundle}`,
    digest: 'sha256:x',
  };
};

/**
 * A working copy pushed to a bare remote, as calm:git:publish leaves it, after a deploy. `legacyCopy`: as a service
 * made before CALM Hub became the only store, with architecture.json and the architecture-file annotation.
 */
async function service(
  legacyCopy = false,
): Promise<{ dir: string; remote: string }> {
  const remote = path.join(remoteBase, 'calm-services', 'orders.git');
  await fs.mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '--bare', '-b', 'main']);
  const dir = path.join(localDir, 'orders');
  await renderInto('node-service@1.0.0', '', dir);
  await renderInto('k8s-deploy@1.0.0', '', dir);
  await fs.writeFile(path.join(dir, 'src', 'mine.js'), 'developer code\n');
  if (legacyCopy) {
    await fs.writeFile(path.join(dir, 'architecture.json'), '{"stale":true}');
  }
  const info = legacyCopy
    ? {
        ...entity,
        metadata: {
          ...entity.metadata,
          annotations: {
            ...annotations,
            'calm.finos.org/architecture-file': './architecture.json',
          },
        },
      }
    : entity;
  await fs.writeFile(path.join(dir, 'catalog-info.yaml'), YAML.stringify(info));
  await fs.mkdir(path.join(dir, 'deploy', 'k8s-overlay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'deploy', 'k8s-overlay', 'kustomization.yaml'),
    YAML.stringify({
      images: [{ name: 'calm-service', newName: 'orders', newTag: 'abc' }],
    }),
  );
  await gitInit(dir);
  await gitCommitAll(dir, 'create');
  await gitPush(dir, `file://${remote}`, 'main');
  return { dir, remote };
}

/** CALM Hub's copy of the architecture: names its coordinates, so a test sees which version was read. */
const hubDoc = (namespace: string, id: string, version: string) => ({
  $id: `${namespace}/${id}/${version}`,
});

const renderAction = (
  bundles: ReturnType<typeof meta>[],
  opts: {
    hub?: (namespace: string, id: string, version: string) => Promise<any>;
    entity?: any;
  } = {},
) =>
  createCalmUpgradeRenderAction({
    catalog: { getEntityByRef: async () => opts.entity ?? entity } as any,
    gitops: gitops(),
    localDir,
    listBundles: async () => bundles,
    renderInto,
    hub: { architecture: opts.hub ?? (async (n, i, v) => hubDoc(n, i, v)) },
  });

describe('calm:upgrade:render', () => {
  it('refuses a second upgrade of the same service while the first is between its render and its deploy', async () => {
    const { dir } = await service();
    const bundles = [
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ];
    const input = {
      entityRef: 'component:default/orders',
      upgradeCode: true,
      upgradeDeploy: true,
    };
    const first = { ...ctx(input), task: { id: 'task-a' } };
    await renderAction(bundles).handler(first);
    expect(first.outputs.changed).toBe(true);
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

    const second = { ...ctx(input), task: { id: 'task-b' } };
    await expect(renderAction(bundles).handler(second)).rejects.toThrow(
      /in use by the task task-a/,
    );
    // The first task's branch and files were not touched.
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
  });

  it('re-renders deploy/k8s only for a deployment upgrade and keeps src/', async () => {
    const { dir, remote } = await service();
    const before = await git(remote, ['rev-parse', 'main']);
    const c = ctx({
      entityRef: 'component:default/orders',
      upgradeCode: true,
      upgradeDeploy: true,
    });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ]).handler(c);
    expect(c.outputs).toMatchObject({
      changed: true,
      codeChanged: false,
      branch: 'upgrade/deploy-k8s-deploy-1.1.0',
      currentImage: 'orders:abc',
      deployBundle: 'k8s-deploy@1.1.0',
      starter: 'node-service@1.0.0',
      summary: 'Deployment rules: k8s-deploy 1.0.0 → 1.1.0',
    });
    expect(
      await fs.readFile(path.join(dir, 'deploy/k8s/workloads.yaml'), 'utf-8'),
    ).toBe('# k8s-deploy@1.1.0\n');
    expect(await fs.readFile(path.join(dir, 'src/server.js'), 'utf-8')).toBe(
      '// node-service@1.0.0\n',
    );
    const info = YAML.parse(
      await fs.readFile(path.join(dir, 'catalog-info.yaml'), 'utf-8'),
    );
    expect(
      info.metadata.annotations['calm.finos.org/deploy-bundle-version'],
    ).toBe('1.1.0');
    expect(info.spec.dependsOn).toContain(
      'resource:default/bundle-k8s-deploy-1.1.0',
    );
    // Committed on the branch, not pushed: the remote's main is untouched.
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
      'upgrade/deploy-k8s-deploy-1.1.0',
    );
    expect(await git(remote, ['rev-parse', 'main'])).toBe(before);
    // The architecture came from CALM Hub, at the version the annotations name, and the render read that file.
    expect(
      JSON.parse(
        await fs.readFile(path.join(workspace, 'architecture.json'), 'utf-8'),
      ),
    ).toEqual(hubDoc('hackathon', 'orders', '1.0.0'));
    expect(c.outputs.architecturePath).toBe('architecture.json');
    expect(renderedFrom).toEqual([path.join(workspace, 'architecture.json')]);
    await expect(
      fs.stat(path.join(dir, 'architecture.json')),
    ).rejects.toThrow();
  });

  it('removes a service’s old architecture.json and its annotation on the upgrade branch', async () => {
    const { dir } = await service(true);
    const c = ctx({ entityRef: 'component:default/orders' });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ]).handler(c);
    expect(c.outputs.summary).toBe(
      `Deployment rules: k8s-deploy 1.0.0 → 1.1.0\n${LEGACY_COPY_REMOVED}`,
    );
    await expect(
      fs.stat(path.join(dir, 'architecture.json')),
    ).rejects.toThrow();
    const info = YAML.parse(
      await fs.readFile(path.join(dir, 'catalog-info.yaml'), 'utf-8'),
    );
    expect(info.metadata.annotations).not.toHaveProperty(
      'calm.finos.org/architecture-file',
    );
    expect(await git(dir, ['log', '-1', '--format=%B'])).toContain(
      LEGACY_COPY_REMOVED,
    );
    // Rendered from CALM Hub's copy, not the stale file.
    expect(renderedFrom).toEqual([path.join(workspace, 'architecture.json')]);
  });

  it('replaces the old starter’s files on a code upgrade and keeps files the developer added', async () => {
    const { dir } = await service();
    const c = ctx({
      entityRef: 'component:default/orders',
      upgradeDeploy: false,
    });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('node-service', '1.1.0', 'starter'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ]).handler(c);
    expect(c.outputs).toMatchObject({
      changed: true,
      codeChanged: true,
      branch: 'upgrade/code-node-service-1.1.0',
    });
    expect(await fs.readFile(path.join(dir, 'src/server.js'), 'utf-8')).toBe(
      '// node-service@1.1.0\n',
    );
    await expect(fs.stat(path.join(dir, 'src/old.js'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'src/mine.js'), 'utf-8')).toBe(
      'developer code\n',
    );
    expect(
      await fs.readFile(path.join(dir, 'deploy/k8s/workloads.yaml'), 'utf-8'),
    ).toBe('# k8s-deploy@1.0.0\n');
  });

  it('makes no commit when nothing changes', async () => {
    const { dir } = await service();
    const head = await git(dir, ['rev-parse', 'HEAD']);
    const c = ctx({ entityRef: 'component:default/orders' });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
    ]).handler(c);
    expect(c.outputs).toMatchObject({
      changed: false,
      codeChanged: false,
      summary: 'Already up to date.',
    });
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(dir, ['branch', '--list'])).toBe('* main');
  });
});

describe('calm:upgrade:merge', () => {
  it('a failed build leaves main and the remote untouched (render alone pushes nothing)', async () => {
    const { remote } = await service();
    const before = await git(remote, ['rev-parse', 'main']);
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('node-service', '1.1.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
    ]).handler(ctx({ entityRef: 'component:default/orders' }));
    // The build step fails here, so calm:upgrade:merge never runs.
    expect(await git(remote, ['rev-parse', 'main'])).toBe(before);
    expect(await git(remote, ['branch', '--list'])).toBe('* main');
  });

  it('sets the image on the branch, pushes it, opens and merges the pull request and updates main', async () => {
    const { dir, remote } = await service();
    const r = ctx({ entityRef: 'component:default/orders' });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ]).handler(r);
    const calls: any[] = [];
    // Stands in for Gitea: "merging" fast-forwards the remote's main to the branch.
    let refusals = 1;
    const gitea = {
      findOpenPullRequest: async () => undefined,
      createPullRequest: async (owner: string, repo: string, pr: any) => {
        calls.push(['create', owner, repo, pr]);
        return { number: 7, url: 'http://gitea/calm-services/orders/pulls/7' };
      },
      mergePullRequest: async (_o: string, _r: string, n: number) => {
        // Gitea refuses until it has checked that the pull request can be merged.
        if (refusals-- > 0) {
          throw new Error(
            'Gitea POST /merge returned 405: Please try again later',
          );
        }
        calls.push(['merge', n]);
        const sha = await git(remote, ['rev-parse', r.outputs.branch]);
        await git(remote, ['update-ref', 'refs/heads/main', sha]);
      },
    } as any;
    const m = ctx({
      dir,
      name: 'orders',
      branch: r.outputs.branch,
      image: 'orders:abc',
      summary: r.outputs.summary,
    });
    await createCalmUpgradeMergeAction({
      gitops: gitops(),
      settings: settings(),
      localDir,
      gitea,
      kubectl: () => fakeKubectl(remote).kubectl,
      mergeRetryMs: 1,
    }).handler(m);
    expect(calls[0][3]).toMatchObject({
      head: 'upgrade/deploy-k8s-deploy-1.1.0',
      base: 'main',
    });
    expect(calls[0][3].title).toBe(
      'Upgrade orders: Deployment rules: k8s-deploy 1.0.0 → 1.1.0',
    );
    expect(calls[0][3].body).toContain('deploy/k8s/workloads.yaml');
    expect(calls[1]).toEqual(['merge', 7]);
    expect(m.outputs.prUrl).toBe('http://gitea/calm-services/orders/pulls/7');
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(m.outputs.commit).toBe(await git(remote, ['rev-parse', 'main']));
    expect(await git(dir, ['branch', '--list'])).toBe('* main');
    // Flux's service account cannot apply a Namespace: calm:deploy:gitops applies it, not the overlay.
    expect(
      await git(remote, [
        'ls-tree',
        '--name-only',
        'main',
        'deploy/k8s-overlay/',
      ]),
    ).toBe('deploy/k8s-overlay/kustomization.yaml');
    expect(
      YAML.parse(
        await git(remote, [
          'show',
          'main:deploy/k8s-overlay/kustomization.yaml',
        ]),
      ).resources,
    ).toEqual(['../k8s']);
    // The overlay on main is what calm:deploy:gitops writes for the same image: it will make no further commit.
    await writeOverlay(
      dir,
      { name: 'orders', namespace: 'calm-orders', image: 'orders:abc' },
      GITOPS_OVERLAY_HEADER,
      { withNamespace: false },
    );
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
  });

  it('applies the prune-disabled namespace and the Flux service account before it pushes the branch that drops namespace.yaml and merges', async () => {
    const { dir, remote } = await service();
    // Deployed before Flux had a service account: the overlay on main holds the Namespace.
    await writeOverlay(
      dir,
      { name: 'orders', namespace: 'calm-orders', image: 'orders:abc' },
      GITOPS_OVERLAY_HEADER,
    );
    await gitCommitAll(dir, 'Deploy orders:abc');
    await gitPush(dir, `file://${remote}`, 'main');
    const before = await git(remote, ['rev-parse', 'main']);
    const r = ctx({ entityRef: 'component:default/orders' });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ]).handler(r);
    const fake = fakeKubectl(remote);
    const gitea = {
      findOpenPullRequest: async () => undefined,
      createPullRequest: async () => ({ number: 7, url: 'u' }),
      mergePullRequest: async () => {
        await git(remote, [
          'update-ref',
          'refs/heads/main',
          await git(remote, ['rev-parse', r.outputs.branch]),
        ]);
      },
    } as any;
    await createCalmUpgradeMergeAction({
      gitops: gitops(),
      settings: settings(),
      localDir,
      gitea,
      kubectl: () => fake.kubectl,
    }).handler(
      ctx({
        dir,
        name: 'orders',
        branch: r.outputs.branch,
        image: 'orders:def',
        summary: 's',
      }),
    );
    expect(fake.applied).toHaveLength(1);
    const [tenant] = fake.applied;
    expect(tenant.objects.map(o => o.kind)).toEqual([
      'Namespace',
      'ServiceAccount',
      'RoleBinding',
      'ClusterRole',
      'ClusterRoleBinding',
    ]);
    expect(tenant.objects[0].metadata).toMatchObject({
      name: 'calm-orders',
      annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
    });
    // Server-side apply under its own field manager: Flux takes over fields owned by kubectl's managers.
    expect(tenant.flags).toEqual([
      '--server-side',
      '--field-manager=calm-backstage',
      '--force-conflicts',
    ]);
    // Applied while the remote held only the old main: before the branch was pushed and merged.
    expect(tenant.remoteBranches).toBe(`main ${before}`);
    expect(
      await git(remote, [
        'ls-tree',
        '--name-only',
        'main',
        'deploy/k8s-overlay/',
      ]),
    ).toBe('deploy/k8s-overlay/kustomization.yaml');
  });

  it('refuses a namespace owned by another service before it pushes', async () => {
    const { dir, remote } = await service();
    const r = ctx({ entityRef: 'component:default/orders' });
    await renderAction([
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ]).handler(r);
    const fake = fakeKubectl(remote, {
      metadata: { labels: { 'calm.finos.org/service': 'billing' } },
    });
    await expect(
      createCalmUpgradeMergeAction({
        gitops: gitops(),
        settings: settings(),
        localDir,
        gitea: {} as any,
        kubectl: () => fake.kubectl,
      }).handler(
        ctx({
          dir,
          name: 'orders',
          branch: r.outputs.branch,
          image: 'orders:def',
        }),
      ),
    ).rejects.toThrow(/belongs to the service "billing"/);
    expect(fake.applied).toEqual([]);
    expect(await git(remote, ['branch', '--list'])).toBe('* main');
  });
});

describe('calm:upgrade:render refusals', () => {
  it('fails when CALM Hub does not give the architecture, and changes nothing', async () => {
    const { dir } = await service(true);
    const head = await git(dir, ['rev-parse', 'HEAD']);
    await expect(
      renderAction(
        [
          meta('node-service', '1.0.0', 'starter'),
          meta('k8s-deploy', '1.0.0', 'deployment'),
          meta('k8s-deploy', '1.1.0', 'deployment'),
        ],
        {
          hub: async () => {
            throw new Error('404 Not Found');
          },
        },
      ).handler(ctx({ entityRef: 'component:default/orders' })),
    ).rejects.toThrow(
      /CALM Hub did not give the architecture hackathon\/orders 1\.0\.0 of component:default\/orders: 404 Not Found/,
    );
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(dir, ['branch', '--list'])).toBe('* main');
    expect(renderedFrom).toEqual([]);
  });

  it('refuses a service that does not name its architecture in CALM Hub', async () => {
    await service(true);
    const {
      'calm.finos.org/architecture': _id,
      'calm.finos.org/architecture-version': _v,
      ...rest
    } = annotations;
    await expect(
      renderAction(
        [
          meta('node-service', '1.0.0', 'starter'),
          meta('k8s-deploy', '1.1.0', 'deployment'),
        ],
        {
          entity: {
            ...entity,
            metadata: { ...entity.metadata, annotations: rest },
          },
        },
      ).handler(ctx({ entityRef: 'component:default/orders' })),
    ).rejects.toThrow(/does not name its architecture in CALM Hub/);
  });

  it('refuses uncommitted work on main instead of discarding it', async () => {
    const { dir } = await service();
    await fs.writeFile(path.join(dir, 'src', 'mine.js'), 'unsaved edit\n');
    await expect(
      renderAction([
        meta('node-service', '1.0.0', 'starter'),
        meta('k8s-deploy', '1.0.0', 'deployment'),
        meta('k8s-deploy', '1.1.0', 'deployment'),
      ]).handler(ctx({ entityRef: 'component:default/orders' })),
    ).rejects.toThrow(/uncommitted changes on main/);
    expect(await fs.readFile(path.join(dir, 'src', 'mine.js'), 'utf-8')).toBe(
      'unsaved edit\n',
    );
  });

  it('refuses a service that was never deployed', async () => {
    const { dir, remote } = await service();
    await fs.rm(path.join(dir, 'deploy', 'k8s-overlay'), { recursive: true });
    await gitCommitAll(dir, 'no overlay');
    await gitPush(dir, `file://${remote}`, 'main');
    await expect(
      renderAction([
        meta('node-service', '1.0.0', 'starter'),
        meta('k8s-deploy', '1.0.0', 'deployment'),
        meta('k8s-deploy', '1.1.0', 'deployment'),
      ]).handler(ctx({ entityRef: 'component:default/orders' })),
    ).rejects.toThrow(/never been deployed/);
  });

  it('a second run after a failed merge replaces the upgrade branch on the remote', async () => {
    const { dir, remote } = await service();
    const bundles = [
      meta('node-service', '1.0.0', 'starter'),
      meta('k8s-deploy', '1.0.0', 'deployment'),
      meta('k8s-deploy', '1.1.0', 'deployment'),
    ];
    const failing = {
      findOpenPullRequest: async () => undefined,
      createPullRequest: async () => {
        throw new Error('Gitea down');
      },
    } as any;
    const r1 = ctx({ entityRef: 'component:default/orders' });
    await renderAction(bundles).handler(r1);
    await expect(
      createCalmUpgradeMergeAction({
        gitops: gitops(),
        settings: settings(),
        localDir,
        gitea: failing,
        kubectl: () => fakeKubectl(remote).kubectl,
      }).handler(
        ctx({
          dir,
          name: 'orders',
          branch: r1.outputs.branch,
          image: 'orders:abc',
          summary: 's',
        }),
      ),
    ).rejects.toThrow(/Gitea down/);
    // The working copy is left on the upgrade branch; a new run starts again from main and pushes a new branch.
    const r2 = ctx({ entityRef: 'component:default/orders' });
    await renderAction(bundles).handler(r2);
    const ok = {
      findOpenPullRequest: async () => ({ number: 3, url: 'u' }),
      mergePullRequest: async () => {
        await git(remote, [
          'update-ref',
          'refs/heads/main',
          await git(remote, ['rev-parse', r2.outputs.branch]),
        ]);
      },
    } as any;
    const m = ctx({
      dir,
      name: 'orders',
      branch: r2.outputs.branch,
      image: 'orders:abc',
      summary: 's',
    });
    await createCalmUpgradeMergeAction({
      gitops: gitops(),
      settings: settings(),
      localDir,
      gitea: ok,
      kubectl: () => fakeKubectl(remote).kubectl,
    }).handler(m);
    expect(m.outputs.prUrl).toBe('u');
    expect(
      await fs.readFile(path.join(dir, 'deploy/k8s/workloads.yaml'), 'utf-8'),
    ).toBe('# k8s-deploy@1.1.0\n');
  });
});

describe('helpers', () => {
  it('names the branch after what changes', () => {
    expect(
      upgradeBranch({
        starter: { name: 's', from: '1', to: '2' },
        deploy: { name: 'd', from: '1', to: '3' },
      }),
    ).toBe('upgrade/both-s-2-d-3');
  });

  it('swaps the bundle Resources in dependsOn and the versions in the description', () => {
    const out = YAML.parse(
      withUpgradedBundles(
        YAML.stringify(entity),
        {
          starter: { name: 'node-service', from: '1.0.0', to: '1.1.0' },
        },
        { ref: 'reg/node-service:1.1.0', digest: 'sha256:y' },
      ),
    );
    expect(out.spec.dependsOn).toEqual([
      'resource:default/pattern-web-service',
      'resource:default/bundle-node-service-1.1.0',
      'resource:default/bundle-k8s-deploy-1.0.0',
    ]);
    expect(out.metadata.annotations['calm.finos.org/bundle-ref']).toBe(
      'reg/node-service:1.1.0',
    );
    expect(out.metadata.description).toContain('node-service 1.1.0');
    expect(
      pullRequestBody({ summary: 'S', diffStat: 'D', image: 'i:1' }),
    ).toContain('`i:1`');
  });
});
