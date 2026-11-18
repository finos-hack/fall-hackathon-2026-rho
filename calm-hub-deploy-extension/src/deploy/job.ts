import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
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
  type ValidationMessage,
} from '@internal/backstage-plugin-calm-node';
import { HttpError } from '../errors';
import { firstError, recordRefusal, refusalNotes } from '../evaluation';
import { DecoratorRejected } from '../hub';
import type { HubClaims } from '../identity';
import { CONNECTOR, decoratorOf, type DeploymentRecord, type HistoryEntry } from '../record';
import { CATALOG_INFO_FILE, bindingProblem, findArchitecture, readService, type ServiceInfo } from '../resolve';
import type { ReadDeps } from '../status';
import { BASE_DIR, labelledNodes, oneLine, readOverlayImage, requestReconcile, waitForKustomization, waitForRollouts } from './kube';

/** What memory knows of a service's latest job; the status and history routes show it until CALM Hub records it. */
export interface JobState {
  deploymentId: string;
  version: string;
  /** `validating` at the controls gate, then the deployment's status; `refused` when the gate refused it. */
  status: string;
  startTime: string;
  endTime?: string;
  notes: string;
  requestedBy: string;
  environment: string;
  /** The deployment decorator, once the version passed the controls gate and CALM Hub recorded it. */
  decoratorId?: number;
  /** The control-evaluation decorator that records the refusal, when the controls gate refused the version. */
  evaluationId?: number;
  /** The pull request the job waits for a person to merge (manual approval), while it waits. */
  pendingApproval?: { number: number; url: string };
  /**
   * CALM Hub did not take the job's final update (`completed` or `failed`): its decorator still shows an earlier
   * status, so memory holds the outcome (`status`, `endTime`, `notes`) and history shows it in the decorator's place.
   */
  outcomeUnrecorded?: boolean;
}

/** One deployment job per service at a time; jobs live in memory (a restart marks unfinished ones failed). */
export class Jobs {
  private readonly running = new Map<string, Promise<void>>();
  private readonly reserved = new Set<string>();
  private readonly latest = new Map<string, JobState>();

  isRunning(key: string): boolean {
    return this.running.has(key) || this.reserved.has(key);
  }

  /**
   * Claims `key` synchronously, so a second request cannot pass the check while the first is still awaiting CALM
   * Hub. Gives false when the key is taken. Follow with `start` (which takes over the claim) or `release`.
   */
  reserve(key: string): boolean {
    if (this.isRunning(key)) return false;
    this.reserved.add(key);
    return true;
  }

  release(key: string): void {
    this.reserved.delete(key);
  }

  /** The state of the job running for `key`; undefined when none runs. */
  current(key: string): JobState | undefined {
    return this.running.has(key) ? this.latest.get(key) : undefined;
  }

  /** Runs the job for `key`; `state` is what the job reports as it goes. */
  start(key: string, state: JobState, run: () => Promise<void>): void {
    this.latest.set(key, state);
    const p = run().finally(() => this.running.delete(key));
    this.running.set(key, p);
    this.reserved.delete(key);
  }

  /**
   * The latest job of `key` as a history entry while CALM Hub holds no record of it: at the controls gate, or ended
   * before a record could be written. Once CALM Hub has its decorator or evaluation, history reads that instead,
   * unless CALM Hub did not take the final update: then the entry carries the decorator's id and replaces it.
   */
  unrecorded(key: string): HistoryEntry[] {
    const s = this.latest.get(key);
    if (!s || s.evaluationId !== undefined) return [];
    if (s.decoratorId !== undefined && !s.outcomeUnrecorded) return [];
    return [
      {
        ...(s.outcomeUnrecorded ? { id: s.decoratorId } : {}),
        deploymentId: s.deploymentId,
        version: s.version,
        status: s.status,
        startTime: s.startTime,
        ...(s.endTime ? { endTime: s.endTime } : {}),
        environment: s.environment,
        requestedBy: s.requestedBy,
        notes: s.notes,
        deployedBy: CONNECTOR,
      },
    ];
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

/** The reply to a deploy request. No decorator exists yet: the job writes one only once the version passes the gate. */
export interface DeployAccepted {
  hubApi: 0;
  deploymentId: string;
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

/**
 * The version of the `calm` CLI that `cliValidate` runs (`@finos/calm-cli`, a dependency of calm-node); undefined when
 * it cannot be found.
 */
export function calmCliVersion(): string | undefined {
  try {
    const here = createRequire(path.join(__dirname, 'job.ts'));
    const calmNode = createRequire(here.resolve('@internal/backstage-plugin-calm-node/package.json'));
    const version = calmNode('@finos/calm-cli/package.json')?.version;
    return typeof version === 'string' && version ? version : undefined;
  } catch {
    return undefined;
  }
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
 * Accepts a deployment: checks it can run and starts the job. Answers within CALM Hub's 10 s limit; the job validates
 * first and records the deployment in CALM Hub only when the version passes the controls gate.
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
  if (!jobs.reserve(arch.name)) throw new HttpError(409, `A deployment of ${arch.name} is already running`);
  try {
    return await accept(deps, req, arch, doc, service);
  } finally {
    // start() has taken the claim over when the deployment was accepted; otherwise give it back.
    jobs.release(arch.name);
  }
}

async function accept(
  deps: DeployDeps,
  req: DeployRequest,
  arch: { name: string; numericId?: number },
  doc: any,
  service: ServiceInfo,
): Promise<DeployAccepted> {
  const { settings, jobs } = deps;
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
    kubernetes: { cluster: settings.kubernetes.context, namespace: service.kubernetesNamespace },
    environment: settings.environment,
    repository: service.webUrl,
    requestedBy: req.claims.sub,
    hubAuditId: req.claims.jti,
    details: service.webUrl,
  };
  const state: JobState = {
    deploymentId: record.uniqueId,
    version: record.version,
    status: 'pending',
    startTime: record.startTime,
    notes: record.notes,
    requestedBy: record.requestedBy,
    environment: record.environment,
  };
  deps.logger.info(`Deployment ${record.uniqueId} accepted`);
  jobs.start(arch.name, state, () => runDeployment(deps, { record, state, service, doc }));
  return { hubApi: 0, deploymentId: record.uniqueId, status: 'pending' };
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

/** Records a version refused at the controls gate as one control evaluation in CALM Hub; the job ends `refused`. */
async function refuse(
  deps: DeployDeps,
  ctx: { record: DeploymentRecord; state: JobState; service: ServiceInfo; doc: unknown },
  errors: ValidationMessage[],
  evaluatedAt: string,
): Promise<void> {
  const { record, state, service } = ctx;
  const notes = refusalNotes(firstError(errors));
  const engineVersion = deps.validate ? undefined : calmCliVersion();
  let evaluationId: number | undefined;
  try {
    evaluationId = await recordRefusal(deps, {
      namespace: record.namespace,
      architecture: record.architecture,
      version: record.version,
      ...(record.numericId !== undefined ? { numericId: record.numericId } : {}),
      shortId: record.uniqueId.split('-').pop()!,
      refused: ctx.doc,
      ...(service.deployedVersion ? { deployedVersion: service.deployedVersion } : {}),
      errors,
      requestedBy: record.requestedBy,
      hubAuditId: record.hubAuditId,
      evaluatedAt,
      // The CLI's version when the default gate ran it; an injected gate says nothing about its engine.
      ...(engineVersion ? { engineVersion } : {}),
    });
  } catch (e) {
    deps.logger.error(`Could not record that ${record.uniqueId} was refused at the controls gate: ${oneLine(e)}`);
  }
  Object.assign(state, { status: 'refused', endTime: evaluatedAt, notes, ...(evaluationId !== undefined ? { evaluationId } : {}) });
  deps.logger.warn(`${record.uniqueId}: refused: ${notes}${evaluationId !== undefined ? ` (control evaluation ${evaluationId})` : ''}`);
}

/**
 * The job: the controls gate, then (only for a version that passes) the deployment record, render, pull request,
 * approval, Flux, rollouts. A refused version gets a control evaluation instead, and nothing reaches Git. Never
 * throws; failures are recorded (in memory when CALM Hub holds no record of the job yet).
 */
export async function runDeployment(
  deps: DeployDeps,
  ctx: { record: DeploymentRecord; state: JobState; service: ServiceInfo; doc: unknown },
): Promise<void> {
  const { settings, hub, gitea, kubectl, logger } = deps;
  const { record, state, service } = ctx;
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  /** Where the job is, before CALM Hub holds a record of it. */
  const report = (patch: Partial<JobState>) => {
    Object.assign(state, patch);
    logger.info(`${record.uniqueId}: ${state.status}: ${state.notes}`);
  };
  let decoratorId: number | undefined;
  /** Moves the deployment decorator on (from then on CALM Hub holds the job's record, not memory). */
  const update = async (patch: Partial<DeploymentRecord>) => {
    Object.assign(record, patch);
    logger.info(`${record.uniqueId}: ${record.status}: ${record.notes}`);
    if (decoratorId === undefined) return;
    try {
      await hub.updateDecorator(record.namespace, decoratorId, decoratorOf(record));
      delete state.outcomeUnrecorded;
    } catch (e) {
      if (record.status === 'completed' || record.status === 'failed') {
        // The outcome would be invisible (the decorator still says in progress): memory holds it.
        Object.assign(state, {
          status: record.status,
          endTime: record.endTime,
          notes: `${record.notes} (CALM Hub did not record this: ${oneLine(e)})`,
          outcomeUnrecorded: true,
        });
      }
      // CALM Hub refused the record itself: the step fails (with its reason) rather than going on unrecorded.
      if (e instanceof DecoratorRejected) throw e;
      logger.warn(`Could not update decorator ${decoratorId}: ${oneLine(e)}`);
    }
  };
  const bundle = service.deployBundle!;
  const owner = service.owner;
  const name = record.architecture;
  const gitOpts = { logger };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-connector-'));
  try {
    const architecturePath = path.join(tmp, 'architecture.json');
    await fs.writeFile(architecturePath, `${JSON.stringify(ctx.doc, null, 2)}\n`);

    // The controls gate, before any deployment record: nothing reaches Git, nor a deployment decorator, unless the
    // version passes its pattern and controls. A refusal is recorded as a control evaluation.
    // A version that names no pattern cannot be checked, so it is refused (fails closed), not deployed unchecked.
    const schema = (ctx.doc as any)?.$schema;
    if (typeof schema !== 'string' || !parsePatternUrl(schema)) {
      const message = `${record.version} names no pattern in CALM Hub ($schema ${typeof schema === 'string' ? schema : 'missing'}): the controls gate cannot validate it`;
      await refuse(deps, ctx, [{ severity: 'error', message }], iso());
      return;
    }
    report({ status: 'validating', notes: `Validating ${record.version} against its pattern and controls` });
    const result = await (deps.validate ?? cliValidate(deps))({ patternUrl: schema, architecturePath, dir: tmp });
    if (result.hasErrors) {
      await refuse(deps, ctx, result.errors, iso());
      return;
    }

    record.notes = `${record.version} passed its pattern and controls. ${record.notes}`;
    decoratorId = await hub.createDecorator(record.namespace, decoratorOf(record));
    report({ status: record.status, notes: record.notes, decoratorId });
    await update({ status: 'in-progress', notes: `Rendering ${bundle.name}@${bundle.version} against ${record.version}` });
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
      body: `${message}\n\nOpened by the CALM Hub extension platform-connector for ${settings.environment}.`,
    });
    if (settings.approval === 'auto') {
      await update({ pullRequest: pr.url, details: pr.url, notes: `Merging pull request #${pr.number}` });
      await mergeWithRetry(deps, owner, name, pr.number, title);
    } else {
      await update({ pullRequest: pr.url, details: pr.url, notes: `Waiting for approval: merge pull request #${pr.number} in Gitea` });
      state.pendingApproval = { number: pr.number, url: pr.url };
      try {
        await waitForMerge(deps, owner, name, pr.number);
      } finally {
        delete state.pendingApproval;
      }
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
    if (decoratorId === undefined) {
      // CALM Hub holds no record of the job (the gate could not run, or CALM Hub refused the record): memory does.
      report({ status: 'failed', endTime: iso(), notes: `Deployment failed: ${oneLine(e)}` });
      return;
    }
    await update({ status: 'failed', endTime: iso(), notes: `Deployment failed: ${oneLine(e)}` }).catch(e2 =>
      logger.error(`Could not record that ${record.uniqueId} failed: ${oneLine(e2)}`),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
