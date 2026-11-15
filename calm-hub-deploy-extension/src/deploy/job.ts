import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { CALM_ANNOTATIONS as ANN, CalmHubError, parsePatternUrl } from '@internal/backstage-plugin-calm-common';
import {
  bundleRef,
  git,
  gitClone,
  gitCommitAll,
  gitHead,
  gitPush,
  gitReset,
  pullBundleCached,
  renderBundle,
  serviceRepository,
  validateArchitecture,
  type ValidateArchitectureResult,
} from '@internal/backstage-plugin-calm-node';
import { HttpError } from '../errors';
import type { HubClaims } from '../identity';
import { decoratorOf, type DeploymentRecord } from '../record';
import { CATALOG_INFO_FILE, bindingProblem, findArchitecture, readService, type ServiceInfo } from '../resolve';
import type { ReadDeps } from '../status';
import { BASE_DIR, labelledNodes, oneLine, readOverlayImage, requestReconcile, waitForKustomization, waitForRollouts } from './kube';

/** One deployment job per service at a time; jobs live in memory (a restart marks unfinished ones failed). */
export class Jobs {
  private readonly running = new Map<string, Promise<void>>();

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  start(key: string, run: () => Promise<void>): void {
    const p = run().finally(() => this.running.delete(key));
    this.running.set(key, p);
  }

  /** Resolves when every running job has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }
}

export type Render = (o: {
  bundle: { name: string; version: string };
  architecturePath: string;
  /** Folder to render in; the files land in `<dir>/rendered`. */
  dir: string;
}) => Promise<string[]>;

export type Validate = (o: { patternUrl: string; architecturePath: string; dir: string }) => Promise<ValidateArchitectureResult>;

export interface DeployDeps extends ReadDeps {
  jobs: Jobs;
  validate?: Validate;
  render?: Render;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Poll interval while waiting for a person to merge the pull request (manual approval). */
  approvalPollMs?: number;
  fluxPollMs?: number;
}

export interface DeployRequest {
  namespace: string;
  /** Name or numeric id of the architecture. */
  architecture: string;
  version: string;
  claims: Pick<HubClaims, 'sub' | 'jti' | 'ns'>;
}

export interface DeployAccepted {
  hubApi: 0;
  deploymentId: string;
  decoratorId: number;
  status: 'pending';
}

const RENDERED = 'rendered';

/** The default renderer: the deployment-rules bundle from the OCI registry, rendered with `calm template`. */
export function registryRender(deps: ReadDeps): Render {
  return async ({ bundle, architecturePath, dir }) => {
    const ref = bundleRef(deps.settings.registry.url, deps.settings.registry.repositoryPrefix, bundle.name, bundle.version);
    const pulled = await pullBundleCached({ ref, cacheDir: deps.settings.bundleCacheDir });
    const r = await renderBundle({ architecturePath, bundleDir: pulled.dir, dir, outputDir: RENDERED, logger: deps.logger });
    return r.files;
  };
}

/** The default controls gate: `calm validate` against the architecture's pattern and the Hub's controls. */
export function cliValidate(deps: ReadDeps): Validate {
  return ({ patternUrl, architecturePath, dir }) =>
    validateArchitecture({
      patternUrl,
      architecturePath,
      hubUrl: deps.settings.hubUrl,
      dir,
      outputPath: path.join(dir, 'validation.json'),
      logger: deps.logger,
    });
}

/**
 * Accepts a deployment: checks it can run, records it in CALM Hub as `pending` and starts the job. Answers within
 * CALM Hub's 10 s limit; the job reports its progress by updating the decorator.
 */
export async function requestDeployment(deps: DeployDeps, req: DeployRequest): Promise<DeployAccepted> {
  const { settings, hub, gitea, jobs } = deps;
  if (req.claims.ns !== undefined && req.claims.ns !== req.namespace) {
    throw new HttpError(403, `CALM Hub checked the namespace ${req.claims.ns}, not ${req.namespace}`);
  }
  const arch = await findArchitecture(hub, req.namespace, req.architecture);
  let doc: any;
  try {
    doc = await hub.architecture(req.namespace, arch.name, req.version);
  } catch (e) {
    if (e instanceof CalmHubError && e.status === 404) {
      throw new HttpError(404, `No version ${req.version} of ${req.namespace}/${arch.name} in CALM Hub`);
    }
    throw e;
  }
  const service = await readService(gitea, settings, arch.name);
  if (!service) {
    throw new HttpError(409, `${arch.name} is not deployed through GitOps: no service repository ${settings.gitops.servicesOrg}/${arch.name}`);
  }
  const problem = bindingProblem(service, req.namespace, arch.name);
  if (problem) throw new HttpError(409, problem);
  if (jobs.isRunning(arch.name)) throw new HttpError(409, `A deployment of ${arch.name} is already running`);

  const now = deps.now ?? Date.now;
  const archNodes: string[] = (Array.isArray(doc?.nodes) ? doc.nodes : []).map((n: any) => n?.['unique-id']).filter(Boolean);
  const record: DeploymentRecord = {
    uniqueId: `${arch.name}-${req.version}-${req.claims.jti.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`,
    namespace: req.namespace,
    architecture: arch.name,
    version: req.version,
    ...(arch.numericId !== undefined ? { numericId: arch.numericId } : {}),
    appliesTo: service.nodes.length ? service.nodes : archNodes,
    status: 'pending',
    startTime: new Date(now()).toISOString(),
    notes: `Requested by ${req.claims.sub} through CALM Hub; ${settings.environment} runs ${service.deployedVersion ?? 'an unknown version'}`,
    environment: settings.environment,
    requestedBy: req.claims.sub,
    hubAuditId: req.claims.jti,
    details: service.webUrl,
  };
  const decoratorId = await hub.createDecorator(req.namespace, decoratorOf(record));
  deps.logger.info(`Deployment ${record.uniqueId} accepted (decorator ${decoratorId})`);
  jobs.start(arch.name, () => runDeployment(deps, { record, decoratorId, service, doc }));
  return { hubApi: 0, deploymentId: record.uniqueId, decoratorId, status: 'pending' };
}

async function copyInto(fromDir: string, files: string[], toDir: string): Promise<void> {
  for (const f of files) {
    const dest = path.resolve(toDir, f);
    if (!dest.startsWith(path.resolve(toDir) + path.sep)) throw new Error(`Rendered file ${f} is outside the repository`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(fromDir, f), dest);
  }
}

/** catalog-info.yaml naming the new architecture version (annotation and the link to it in CALM Hub). */
export function withArchitectureVersion(catalogInfo: string, version: string): string {
  const docs = YAML.parseAllDocuments(catalogInfo).map(d => d.toJS());
  const out = docs.map((e: any) => {
    if (e?.kind !== 'Component') return e;
    const a = (e.metadata.annotations = e.metadata.annotations ?? {});
    const old = a[ANN.architectureVersion];
    a[ANN.architectureVersion] = version;
    for (const l of e.metadata.links ?? []) {
      if (old && typeof l?.url === 'string' && l.url.endsWith(`/versions/${old}`)) {
        l.url = `${l.url.slice(0, -old.length)}${version}`;
      }
    }
    return e;
  });
  return out.map(d => YAML.stringify(d)).join('---\n');
}

/** Clones the service repository once, then resets it to the remote `main` before each job. */
async function prepareWorkingCopy(deps: DeployDeps, name: string): Promise<string> {
  const { gitops } = deps.settings;
  const repo = serviceRepository(gitops, name);
  const dir = path.join(deps.settings.workDir, 'repos', name);
  const opts = { logger: deps.logger };
  const exists = await fs
    .stat(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await fs.rm(dir, { recursive: true, force: true });
    await gitClone(repo.pushUrl, dir, gitops.branch, gitops.auth, opts);
    return dir;
  }
  await gitReset(dir, opts);
  await git(dir, ['fetch', '-q', repo.pushUrl, gitops.branch], { ...opts, auth: gitops.auth });
  await git(dir, ['checkout', '-q', '-B', gitops.branch, 'FETCH_HEAD'], opts);
  return dir;
}

async function mergeWithRetry(deps: DeployDeps, owner: string, repo: string, number: number, title: string): Promise<void> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.gitea.mergePullRequest(owner, repo, number, title);
      return;
    } catch (e) {
      // Gitea answers 405 until it has worked out that the pull request can be merged.
      if (attempt >= 6 || !/returned 405/.test((e as Error).message)) throw e;
      await sleep(2_000);
    }
  }
}

async function waitForMerge(deps: DeployDeps, owner: string, repo: string, number: number): Promise<void> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + deps.settings.approvalTimeoutMs;
  for (;;) {
    const pr = await deps.gitea.pullRequest(owner, repo, number);
    if (pr.merged) return;
    if (pr.state === 'closed') throw new Error(`Pull request #${number} was closed without merging: deployment not approved`);
    if (now() >= deadline) {
      throw new Error(`Pull request #${number} was not merged within ${Math.round(deps.settings.approvalTimeoutMs / 1000)} s`);
    }
    await sleep(deps.approvalPollMs ?? 5_000);
  }
}

/** The job: validate, render, pull request, approval, Flux, rollouts. Never throws; failures are recorded. */
export async function runDeployment(
  deps: DeployDeps,
  ctx: { record: DeploymentRecord; decoratorId: number; service: ServiceInfo; doc: unknown },
): Promise<void> {
  const { settings, hub, gitea, kubectl, logger } = deps;
  const { record, decoratorId, service } = ctx;
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const update = async (patch: Partial<DeploymentRecord>) => {
    Object.assign(record, patch);
    logger.info(`${record.uniqueId}: ${record.status}: ${record.notes}`);
    try {
      await hub.updateDecorator(record.namespace, decoratorId, decoratorOf(record));
    } catch (e) {
      logger.warn(`Could not update decorator ${decoratorId}: ${oneLine(e)}`);
    }
  };
  const bundle = service.deployBundle!;
  const owner = service.owner;
  const name = record.architecture;
  const gitOpts = { logger };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitops-deploy-'));
  try {
    const architecturePath = path.join(tmp, 'architecture.json');
    await fs.writeFile(architecturePath, `${JSON.stringify(ctx.doc, null, 2)}\n`);

    // The controls gate: nothing reaches Git unless the version passes its pattern and controls.
    const schema = (ctx.doc as any)?.$schema;
    if (typeof schema === 'string' && parsePatternUrl(schema)) {
      await update({ status: 'in-progress', notes: `Validating ${record.version} against its pattern and controls` });
      const result = await (deps.validate ?? cliValidate(deps))({ patternUrl: schema, architecturePath, dir: tmp });
      if (result.hasErrors) {
        const first = result.errors
          .slice(0, 3)
          .map(e => e.message)
          .join('; ');
        throw new Error(`calm validate found ${result.errors.length} error(s): ${first}`);
      }
    } else {
      await update({ status: 'in-progress', notes: `${record.version} names no pattern in CALM Hub: validation skipped` });
    }

    await update({ notes: `Rendering ${bundle.name}@${bundle.version} against ${record.version}` });
    const dir = await prepareWorkingCopy(deps, name);
    const image = await readOverlayImage(dir);
    if (!image) throw new Error(`${owner}/${name} has no deploy/k8s-overlay image: deploy it once from Backstage first`);
    const branch = `deploy/${record.version}-${record.uniqueId.split('-').pop()}`;
    await git(dir, ['checkout', '-q', '-B', branch], gitOpts);
    const files = await (deps.render ?? registryRender(deps))({ bundle, architecturePath, dir: tmp });
    await fs.rm(path.join(dir, BASE_DIR), { recursive: true, force: true });
    await copyInto(path.join(tmp, RENDERED), files, dir);
    const catalogInfo = path.join(dir, CATALOG_INFO_FILE);
    await fs.writeFile(catalogInfo, withArchitectureVersion(await fs.readFile(catalogInfo, 'utf-8'), record.version));
    const title = `Deploy ${name} architecture ${record.version}`;
    const message = [
      title,
      '',
      `Re-rendered ${BASE_DIR} with ${bundle.name}@${bundle.version} against ${record.namespace}/${name} ${record.version}.`,
      '',
      `Requested-by: ${record.requestedBy} via CALM Hub (audit ${record.hubAuditId})`,
    ].join('\n');
    const commit = await gitCommitAll(dir, message, gitOpts);
    if (!commit) {
      const head = await gitHead(dir, gitOpts);
      await git(dir, ['checkout', '-q', settings.gitops.branch], gitOpts);
      await git(dir, ['branch', '-q', '-D', branch], gitOpts);
      await update({
        status: 'completed',
        endTime: iso(),
        commit: head,
        details: gitea.commitWebUrl(owner, name, head),
        notes: `Already deployed: ${record.version} renders the same manifests as ${head.slice(0, 12)} on ${settings.gitops.branch}`,
      });
      return;
    }

    const repo = serviceRepository(settings.gitops, name);
    await gitPush(dir, repo.pushUrl, branch, settings.gitops.auth, { ...gitOpts, force: true });
    const pr = await gitea.createPullRequest(owner, name, {
      head: branch,
      base: settings.gitops.branch,
      title,
      body: `${message}\n\nOpened by the CALM Hub extension gitops-deploy for ${settings.environment}.`,
    });
    if (settings.approval === 'auto') {
      await update({ pullRequest: pr.url, details: pr.url, notes: `Merging pull request #${pr.number}` });
      await mergeWithRetry(deps, owner, name, pr.number, title);
    } else {
      await update({ pullRequest: pr.url, details: pr.url, notes: `Waiting for approval: merge pull request #${pr.number} in Gitea` });
      await waitForMerge(deps, owner, name, pr.number);
    }

    await git(dir, ['fetch', '-q', repo.pushUrl, settings.gitops.branch], { ...gitOpts, auth: settings.gitops.auth });
    await git(dir, ['checkout', '-q', '-B', settings.gitops.branch, 'FETCH_HEAD'], gitOpts);
    await git(dir, ['branch', '-q', '-D', branch], gitOpts).catch(() => undefined);
    const sha = await gitHead(dir, gitOpts);
    await update({ commit: sha, notes: `Flux applying ${sha.slice(0, 12)}` });
    await requestReconcile(kubectl, name, iso());
    await waitForKustomization(kubectl, name, sha, {
      timeoutMs: settings.fluxTimeoutMs,
      ...(deps.fluxPollMs ? { pollMs: deps.fluxPollMs } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    await update({ notes: `Flux applied ${sha.slice(0, 12)}; waiting for rollouts in ${service.kubernetesNamespace}` });
    await waitForRollouts(kubectl, service.kubernetesNamespace);
    const nodes = await labelledNodes(path.join(dir, BASE_DIR));
    await update({
      status: 'completed',
      endTime: iso(),
      ...(nodes.length ? { appliesTo: nodes } : {}),
      details: gitea.commitWebUrl(owner, name, sha),
      notes: `Deployed ${record.version} to ${settings.environment}: Flux applied ${sha.slice(0, 12)} from pull request #${pr.number}`,
    });
  } catch (e) {
    logger.error(`${record.uniqueId} failed: ${oneLine(e)}`);
    await update({ status: 'failed', endTime: iso(), notes: `Deployment failed: ${oneLine(e)}` });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
