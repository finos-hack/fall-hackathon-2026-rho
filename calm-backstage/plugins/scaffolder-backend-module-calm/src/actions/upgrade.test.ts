import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { readBundleMeta } from '@internal/backstage-plugin-calm-common';
import { git, gitCommitAll, gitInit, gitPush } from '@internal/backstage-plugin-calm-node';
import { createCalmUpgradeRenderAction, upgradeBranch, withUpgradedBundles } from './upgradeRender';
import { createCalmUpgradeMergeAction, pullRequestBody } from './upgradeMerge';
import { GITOPS_OVERLAY_HEADER, writeOverlay } from './deployK8s';

let root: string;
let localDir: string;
let remoteBase: string;
let workspace: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-upgrade-'));
  localDir = path.join(root, 'output');
  remoteBase = path.join(root, 'git');
  workspace = path.join(root, 'ws');
  await fs.mkdir(path.join(remoteBase, 'calm-services'), { recursive: true });
  await fs.mkdir(workspace);
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
  metadata: { name: 'orders', annotations, description: 'rendered with the starter node-service 1.0.0 and the deployment rules k8s-deploy 1.0.0' },
  spec: {
    type: 'service',
    dependsOn: ['resource:default/pattern-web-service', 'resource:default/bundle-node-service-1.0.0', 'resource:default/bundle-k8s-deploy-1.0.0'],
  },
};
const meta = (name: string, version: string, kind: string) =>
  readBundleMeta({ name, version, kind, patterns: [{ namespace: 'hackathon', patternId: 'web-service' }] });

/** Each bundle version renders files whose content names it; node-service 1.1.0 drops src/old.js. */
const renderInto = async (bundle: string, _arch: string, outDir: string) => {
  const files: Record<string, string> =
    bundle.startsWith('k8s-deploy')
      ? { 'deploy/k8s/workloads.yaml': `# ${bundle}\n`, 'deploy/k8s/kustomization.yaml': 'resources: [workloads.yaml]\n' }
      : bundle === 'node-service@1.0.0'
        ? { 'src/server.js': `// ${bundle}\n`, 'src/old.js': 'old\n', Dockerfile: 'FROM node\n' }
        : { 'src/server.js': `// ${bundle}\n`, Dockerfile: 'FROM node\n' };
  for (const [f, t] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(outDir, f)), { recursive: true });
    await fs.writeFile(path.join(outDir, f), t);
  }
  return { files: Object.keys(files).sort(), ref: `reg/${bundle}`, digest: 'sha256:x' };
};

/** A working copy pushed to a bare remote, as calm:git:publish leaves it, after a deploy. */
async function service(): Promise<{ dir: string; remote: string }> {
  const remote = path.join(remoteBase, 'calm-services', 'orders.git');
  await fs.mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '--bare', '-b', 'main']);
  const dir = path.join(localDir, 'orders');
  await renderInto('node-service@1.0.0', '', dir);
  await renderInto('k8s-deploy@1.0.0', '', dir);
  await fs.writeFile(path.join(dir, 'src', 'mine.js'), 'developer code\n');
  await fs.writeFile(path.join(dir, 'architecture.json'), '{}');
  await fs.writeFile(path.join(dir, 'catalog-info.yaml'), YAML.stringify(entity));
  await fs.mkdir(path.join(dir, 'deploy', 'k8s-overlay'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'deploy', 'k8s-overlay', 'kustomization.yaml'),
    YAML.stringify({ images: [{ name: 'calm-service', newName: 'orders', newTag: 'abc' }] }),
  );
  await gitInit(dir);
  await gitCommitAll(dir, 'create');
  await gitPush(dir, `file://${remote}`, 'main');
  return { dir, remote };
}

const renderAction = (bundles: ReturnType<typeof meta>[]) =>
  createCalmUpgradeRenderAction({
    catalog: { getEntityByRef: async () => entity } as any,
    gitops: gitops(),
    localDir,
    listBundles: async () => bundles,
    renderInto,
  });

describe('calm:upgrade:render', () => {
  it('re-renders deploy/k8s only for a deployment upgrade and keeps src/', async () => {
    const { dir, remote } = await service();
    const before = await git(remote, ['rev-parse', 'main']);
    const c = ctx({ entityRef: 'component:default/orders', upgradeCode: true, upgradeDeploy: true });
    await renderAction([meta('node-service', '1.0.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment'), meta('k8s-deploy', '1.1.0', 'deployment')]).handler(c);
    expect(c.outputs).toMatchObject({
      changed: true,
      codeChanged: false,
      branch: 'upgrade/deploy-k8s-deploy-1.1.0',
      currentImage: 'orders:abc',
      deployBundle: 'k8s-deploy@1.1.0',
      starter: 'node-service@1.0.0',
      summary: 'Deployment rules: k8s-deploy 1.0.0 → 1.1.0',
    });
    expect(await fs.readFile(path.join(dir, 'deploy/k8s/workloads.yaml'), 'utf-8')).toBe('# k8s-deploy@1.1.0\n');
    expect(await fs.readFile(path.join(dir, 'src/server.js'), 'utf-8')).toBe('// node-service@1.0.0\n');
    const info = YAML.parse(await fs.readFile(path.join(dir, 'catalog-info.yaml'), 'utf-8'));
    expect(info.metadata.annotations['calm.finos.org/deploy-bundle-version']).toBe('1.1.0');
    expect(info.spec.dependsOn).toContain('resource:default/bundle-k8s-deploy-1.1.0');
    // Committed on the branch, not pushed: the remote's main is untouched.
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('upgrade/deploy-k8s-deploy-1.1.0');
    expect(await git(remote, ['rev-parse', 'main'])).toBe(before);
    expect(await fs.readFile(path.join(workspace, 'architecture.json'), 'utf-8')).toBe('{}');
  });

  it('replaces the old starter’s files on a code upgrade and keeps files the developer added', async () => {
    const { dir } = await service();
    const c = ctx({ entityRef: 'component:default/orders', upgradeDeploy: false });
    await renderAction([meta('node-service', '1.0.0', 'starter'), meta('node-service', '1.1.0', 'starter'), meta('k8s-deploy', '1.1.0', 'deployment')]).handler(c);
    expect(c.outputs).toMatchObject({ changed: true, codeChanged: true, branch: 'upgrade/code-node-service-1.1.0' });
    expect(await fs.readFile(path.join(dir, 'src/server.js'), 'utf-8')).toBe('// node-service@1.1.0\n');
    await expect(fs.stat(path.join(dir, 'src/old.js'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'src/mine.js'), 'utf-8')).toBe('developer code\n');
    expect(await fs.readFile(path.join(dir, 'deploy/k8s/workloads.yaml'), 'utf-8')).toBe('# k8s-deploy@1.0.0\n');
  });

  it('makes no commit when nothing changes', async () => {
    const { dir } = await service();
    const head = await git(dir, ['rev-parse', 'HEAD']);
    const c = ctx({ entityRef: 'component:default/orders' });
    await renderAction([meta('node-service', '1.0.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment')]).handler(c);
    expect(c.outputs).toMatchObject({ changed: false, codeChanged: false, summary: 'Already up to date.' });
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(dir, ['branch', '--list'])).toBe('* main');
  });
});

describe('calm:upgrade:merge', () => {
  it('a failed build leaves main and the remote untouched (render alone pushes nothing)', async () => {
    const { remote } = await service();
    const before = await git(remote, ['rev-parse', 'main']);
    await renderAction([meta('node-service', '1.0.0', 'starter'), meta('node-service', '1.1.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment')]).handler(
      ctx({ entityRef: 'component:default/orders' }),
    );
    // The build step fails here, so calm:upgrade:merge never runs.
    expect(await git(remote, ['rev-parse', 'main'])).toBe(before);
    expect(await git(remote, ['branch', '--list'])).toBe('* main');
  });

  it('sets the image on the branch, pushes it, opens and merges the pull request and updates main', async () => {
    const { dir, remote } = await service();
    const r = ctx({ entityRef: 'component:default/orders' });
    await renderAction([meta('node-service', '1.0.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment'), meta('k8s-deploy', '1.1.0', 'deployment')]).handler(r);
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
          throw new Error('Gitea POST /merge returned 405: Please try again later');
        }
        calls.push(['merge', n]);
        const sha = await git(remote, ['rev-parse', r.outputs.branch]);
        await git(remote, ['update-ref', 'refs/heads/main', sha]);
      },
    } as any;
    const m = ctx({ dir, name: 'orders', branch: r.outputs.branch, image: 'orders:abc', summary: r.outputs.summary });
    await createCalmUpgradeMergeAction({ gitops: gitops(), localDir, gitea, mergeRetryMs: 1 }).handler(m);
    expect(calls[0][3]).toMatchObject({ head: 'upgrade/deploy-k8s-deploy-1.1.0', base: 'main' });
    expect(calls[0][3].title).toBe('Upgrade orders: Deployment rules: k8s-deploy 1.0.0 → 1.1.0');
    expect(calls[0][3].body).toContain('deploy/k8s/workloads.yaml');
    expect(calls[1]).toEqual(['merge', 7]);
    expect(m.outputs.prUrl).toBe('http://gitea/calm-services/orders/pulls/7');
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(m.outputs.commit).toBe(await git(remote, ['rev-parse', 'main']));
    expect(await git(dir, ['branch', '--list'])).toBe('* main');
    // The overlay on main is what calm:deploy:gitops writes for the same image: it will make no further commit.
    await writeOverlay(dir, { name: 'orders', namespace: 'calm-orders', image: 'orders:abc' }, GITOPS_OVERLAY_HEADER);
    expect(await git(dir, ['status', '--porcelain'])).toBe('');
  });
});

describe('calm:upgrade:render refusals', () => {
  it('refuses uncommitted work on main instead of discarding it', async () => {
    const { dir } = await service();
    await fs.writeFile(path.join(dir, 'src', 'mine.js'), 'unsaved edit\n');
    await expect(
      renderAction([meta('node-service', '1.0.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment'), meta('k8s-deploy', '1.1.0', 'deployment')]).handler(
        ctx({ entityRef: 'component:default/orders' }),
      ),
    ).rejects.toThrow(/uncommitted changes on main/);
    expect(await fs.readFile(path.join(dir, 'src', 'mine.js'), 'utf-8')).toBe('unsaved edit\n');
  });

  it('refuses a service that was never deployed', async () => {
    const { dir, remote } = await service();
    await fs.rm(path.join(dir, 'deploy', 'k8s-overlay'), { recursive: true });
    await gitCommitAll(dir, 'no overlay');
    await gitPush(dir, `file://${remote}`, 'main');
    await expect(
      renderAction([meta('node-service', '1.0.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment'), meta('k8s-deploy', '1.1.0', 'deployment')]).handler(
        ctx({ entityRef: 'component:default/orders' }),
      ),
    ).rejects.toThrow(/never been deployed/);
  });

  it('a second run after a failed merge replaces the upgrade branch on the remote', async () => {
    const { dir, remote } = await service();
    const bundles = [meta('node-service', '1.0.0', 'starter'), meta('k8s-deploy', '1.0.0', 'deployment'), meta('k8s-deploy', '1.1.0', 'deployment')];
    const failing = { findOpenPullRequest: async () => undefined, createPullRequest: async () => { throw new Error('Gitea down'); } } as any;
    const r1 = ctx({ entityRef: 'component:default/orders' });
    await renderAction(bundles).handler(r1);
    await expect(
      createCalmUpgradeMergeAction({ gitops: gitops(), localDir, gitea: failing }).handler(
        ctx({ dir, name: 'orders', branch: r1.outputs.branch, image: 'orders:abc', summary: 's' }),
      ),
    ).rejects.toThrow(/Gitea down/);
    // The working copy is left on the upgrade branch; a new run starts again from main and pushes a new branch.
    const r2 = ctx({ entityRef: 'component:default/orders' });
    await renderAction(bundles).handler(r2);
    const ok = { findOpenPullRequest: async () => ({ number: 3, url: 'u' }), mergePullRequest: async () => {
      await git(remote, ['update-ref', 'refs/heads/main', await git(remote, ['rev-parse', r2.outputs.branch])]);
    } } as any;
    const m = ctx({ dir, name: 'orders', branch: r2.outputs.branch, image: 'orders:abc', summary: 's' });
    await createCalmUpgradeMergeAction({ gitops: gitops(), localDir, gitea: ok }).handler(m);
    expect(m.outputs.prUrl).toBe('u');
    expect(await fs.readFile(path.join(dir, 'deploy/k8s/workloads.yaml'), 'utf-8')).toBe('# k8s-deploy@1.1.0\n');
  });
});

describe('helpers', () => {
  it('names the branch after what changes', () => {
    expect(upgradeBranch({ starter: { name: 's', from: '1', to: '2' }, deploy: { name: 'd', from: '1', to: '3' } })).toBe('upgrade/both-s-2-d-3');
  });

  it('swaps the bundle Resources in dependsOn and the versions in the description', () => {
    const out = YAML.parse(
      withUpgradedBundles(YAML.stringify(entity), {
        starter: { name: 'node-service', from: '1.0.0', to: '1.1.0' },
      }, { ref: 'reg/node-service:1.1.0', digest: 'sha256:y' }),
    );
    expect(out.spec.dependsOn).toEqual([
      'resource:default/pattern-web-service',
      'resource:default/bundle-node-service-1.1.0',
      'resource:default/bundle-k8s-deploy-1.0.0',
    ]);
    expect(out.metadata.annotations['calm.finos.org/bundle-ref']).toBe('reg/node-service:1.1.0');
    expect(out.metadata.description).toContain('node-service 1.1.0');
    expect(pullRequestBody({ summary: 'S', diffStat: 'D', image: 'i:1' })).toContain('`i:1`');
  });
});
