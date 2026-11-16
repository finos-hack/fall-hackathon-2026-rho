import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CalmHubWriteClient,
  type FetchLike,
} from '@internal/backstage-plugin-calm-common';
import { createCalmDecorateDeploymentAction } from './decorateDeployment';
import { createCalmDeployGitopsAction } from './deployGitops';
import { createCalmGitPublishAction } from './gitPublish';
import { createCalmImageBuildAction } from './imageBuild';
import { createCalmPublishLocalAction } from './publishLocal';
import { createCalmRegisterHubAction } from './registerHub';
import { createCalmRegisterLocalAction } from './registerLocal';

const base = 'http://hub:8090';
const architecture = {
  $schema: `${base}/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0`,
  nodes: [{ 'unique-id': 'web-service', 'node-type': 'service' }],
  relationships: [],
};

let root: string;
let localDir: string;
let remoteBase: string;
let hubCalls: { method: string; url: string }[];
let kubectl: jest.Mock;
let pathBefore: string | undefined;

/** A Hub holding nothing: it records every request, and a dry run may only read. */
const fetchLike: FetchLike = async (url, init) => {
  hubCalls.push({ method: init?.method ?? 'GET', url });
  const listed = new URL(url).pathname.endsWith('/architectures');
  const body = listed ? { values: [] } : 'Resource not found';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: listed,
    status: listed ? 200 : 404,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as any;
};

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-dry-chain-'));
  localDir = path.join(root, 'output');
  remoteBase = path.join(root, 'git');
  hubCalls = [];
  kubectl = jest.fn(async () => '');
  await fs.mkdir(path.join(remoteBase, 'calm-services'), { recursive: true });
  await fs.mkdir(localDir);
  await fs.writeFile(path.join(localDir, 'keep.txt'), 'keep');
  await fs.writeFile(path.join(root, 'kubeconfig'), '');
  await write('architecture.json', JSON.stringify(architecture));
  await write('rendered/Dockerfile', 'FROM scratch\n');
  await write(
    'rendered-deploy/deploy/k8s/kustomization.yaml',
    'resources: []\n',
  );
  await write(
    'rendered-deploy/deploy/k8s/workloads.yaml',
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
      '',
    ].join('\n'),
  );
  // A docker or git binary would be found on the PATH: with none, any process the chain spawns fails the run.
  pathBefore = process.env.PATH;
  process.env.PATH = '';
});
afterEach(async () => {
  process.env.PATH = pathBefore;
  await fs.rm(root, { recursive: true, force: true });
});

/** The context of a dry-run step, with its outputs collected. */
const step = (input: object) => {
  const outputs: Record<string, any> = {};
  return {
    input,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: (k: string, v: unknown) => {
      outputs[k] = v;
    },
    outputs,
    workspacePath: root,
    task: { id: 'task-1' },
    isDryRun: true,
    getInitiatorCredentials: jest.fn(async () => ({})),
  } as any;
};

describe('the publish to deploy chain in a dry run', () => {
  it('runs every step in Template order, feeding outputs on, and changes nothing outside the workspace', async () => {
    const hub = new CalmHubWriteClient(base, fetchLike);
    const catalog = {
      getEntityByRef: jest.fn(async () => undefined),
      addLocation: jest.fn(),
    } as any;
    const auth = { getOwnServiceCredentials: jest.fn(async () => ({})) } as any;
    const settings = {
      kubeconfig: path.join(root, 'kubeconfig'),
      context: 'calm-backstage',
      minikubeProfile: 'calm-backstage',
      namespacePrefix: 'calm-',
    };
    const gitops = {
      gitUrl: `file://${remoteBase}`,
      clusterGitUrl: 'http://host.minikube.internal:3300',
      servicesOrg: 'calm-services',
      templatesRepo: 'calm-templates/bundles',
      branch: 'main',
      auth: { username: 'calm', password: 'pw' },
    };
    const run = async (action: any, input: object) => {
      expect(action.supportsDryRun).toBe(true);
      const c = step(input);
      await action.handler(c);
      return c;
    };

    // register-hub (prepare): checks the name and writes the file in the workspace.
    const prepare = await run(
      createCalmRegisterHubAction({
        hub,
        namespace: 'hackathon',
        catalog,
        auth,
        localDir,
      }),
      { name: 'orders', mode: 'prepare' },
    );
    const registered = prepare.outputs;

    const publish = await run(
      createCalmPublishLocalAction({
        catalog,
        auth,
        localDir,
        namespacePrefix: 'calm-',
      }),
      {
        name: 'orders',
        deploySourceDir: 'rendered-deploy',
        namespace: 'hackathon',
        patternId: 'web-service',
        patternVersion: '1.0.0',
        bundle: 'node-service@1.0.0',
        hubNamespace: registered.namespace,
        hubArchitecture: registered.architecture,
        hubArchitectureVersion: registered.version,
        hubArchitectureUrl: registered.url,
        deployable: true,
      },
    );
    const dir = path.join(root, 'dry-run-output', 'orders');
    expect(publish.outputs.path).toBe(dir);

    await run(
      createCalmRegisterHubAction({
        hub,
        namespace: 'hackathon',
        catalog,
        auth,
        localDir,
      }),
      { name: 'orders', mode: 'store', publishedDir: publish.outputs.path },
    );

    const git = await run(
      createCalmGitPublishAction({ settings: gitops, localDir }),
      {
        dir: publish.outputs.path,
        name: 'orders',
        message: 'Create orders',
      },
    );
    expect(git.outputs.shortCommit).toBe('dry-run');

    const build = await run(
      createCalmImageBuildAction({ settings, localDir }),
      {
        dir: publish.outputs.path,
        name: 'orders',
        tag: git.outputs.shortCommit,
      },
    );
    expect(build.outputs.image).toBe('orders:dry-run');

    const deploy = await run(
      createCalmDeployGitopsAction({
        settings,
        gitops,
        localDir,
        kubectl: () => kubectl,
      }),
      {
        dir: publish.outputs.path,
        name: 'orders',
        image: build.outputs.image,
      },
    );
    expect(deploy.outputs).toMatchObject({
      namespace: 'calm-orders',
      nodes: ['web-service'],
      commit: 'dry-run',
    });

    // The decorate step's inputs are the deploy step's outputs, as in the Template.
    const decorateInput = {
      hubNamespace: registered.namespace,
      architecture: registered.architecture,
      version: registered.version,
      name: 'orders',
      cluster: deploy.outputs.cluster,
      namespace: deploy.outputs.namespace,
      workloads: deploy.outputs.nodes,
      startTime: deploy.outputs.startTime,
      endTime: deploy.outputs.endTime,
      status: 'completed' as const,
      gitRepo: deploy.outputs.repoUrl,
      gitCommit: deploy.outputs.commit,
    };
    const decorate = await run(
      createCalmDecorateDeploymentAction({
        hub,
        appBaseUrl: 'http://backstage',
      }),
      decorateInput,
    );
    expect(decorate.outputs).toMatchObject({
      id: 'dry-run',
      uniqueId: 'orders-task-1',
    });
    expect(decorate.logger.info).toHaveBeenCalledWith(
      'Dry run: would store the decorator orders-task-1',
    );

    const local = await run(
      createCalmRegisterLocalAction({ catalog, auth, localDir }),
      { catalogInfoPath: publish.outputs.catalogInfoPath },
    );
    expect(local.outputs.entityRef).toBe('component:default/orders');
    expect(local.outputs.locationTarget).toBe(
      `file:${publish.outputs.catalogInfoPath}`,
    );

    // Nothing outside the workspace changed, and nothing was written to the Hub, Git, the catalog or the cluster.
    expect(await fs.readdir(localDir)).toEqual(['keep.txt']);
    expect(await fs.readFile(path.join(localDir, 'keep.txt'), 'utf-8')).toBe(
      'keep',
    );
    expect(hubCalls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(await fs.readdir(path.join(remoteBase, 'calm-services'))).toEqual(
      [],
    );
    expect(await fs.readdir(dir)).not.toContain('.git');
    expect(kubectl).not.toHaveBeenCalled();
    expect(catalog.addLocation).not.toHaveBeenCalled();
  });
});
