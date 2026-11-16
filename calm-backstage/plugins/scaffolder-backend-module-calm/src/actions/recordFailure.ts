import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LoggerService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import {
  CalmHubWriteClient,
  workloadNode,
} from '@internal/backstage-plugin-calm-common';
import YAML from 'yaml';
import { deployedNodes, recordDeployment } from './decorateDeployment';

/** How long recording a failed deployment may take before it is given up, so a hanging Hub cannot hold back the deploy error. */
export const RECORD_FAILURE_TIMEOUT_MS = 30_000;

/** The workload kinds that name the architecture node they run (see `workloadNode`). */
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'];
const MAX_NOTE_ERROR = 300;

/** Where a failed deployment is recorded: the architecture version the service was registered as. */
export interface FailureRecordTarget {
  hubNamespace: string;
  architecture: string;
  version: string;
  architecturePath?: string;
}

/**
 * The architecture nodes the bundle rendered: for each workload in the YAML files of `baseDir`, its
 * `calm.finos.org/unique-id` annotation, else its `calm.finos.org/node` label. Empty when the folder or the labels are
 * missing.
 */
export async function labelledNodes(baseDir: string): Promise<string[]> {
  const files = (await fs.readdir(baseDir).catch(() => [])).filter(f =>
    /\.ya?ml$/.test(f),
  );
  const nodes = new Set<string>();
  for (const f of files) {
    const text = await fs.readFile(path.join(baseDir, f), 'utf-8');
    for (const doc of YAML.parseAllDocuments(text).map(d => d.toJS())) {
      if (!WORKLOAD_KINDS.includes(doc?.kind)) {
        continue;
      }
      const node = workloadNode(doc);
      if (node !== undefined) {
        nodes.add(node);
      }
    }
  }
  return [...nodes].sort();
}

/** The error message on one line and at most a few hundred characters, for a decorator's notes. */
export function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_NOTE_ERROR
    ? `${text.slice(0, MAX_NOTE_ERROR - 1)}…`
    : text;
}

/**
 * Records a failed deployment in CALM Hub as a deployment decorator with the status `failed`: it applies to the
 * architecture nodes the rendered workloads name (all the architecture's nodes when none of them names one) and says
 * what failed. Its unique-id ends in `-failed`, so a retry that succeeds does not reuse it. Never
 * throws: a problem recording it is logged as a warning, so the caller's own error is the one that surfaces. Nothing
 * is recorded for a task that was cancelled, and the recording gives up after `timeoutMs`.
 */
export async function recordFailedDeployment(opts: {
  hub?: CalmHubWriteClient;
  appBaseUrl?: string;
  record: FailureRecordTarget;
  /** The published folder, whose `deploy/k8s` is the rendered base. */
  baseDir: string;
  workspacePath: string;
  taskId?: string;
  name: string;
  cluster: string;
  namespace: string;
  startTime: string;
  error: unknown;
  logger: LoggerService;
  /** The task's signal: a cancelled task is not recorded as failed. */
  signal?: AbortSignal;
  /** Default `RECORD_FAILURE_TIMEOUT_MS`. */
  timeoutMs?: number;
}): Promise<void> {
  const { record, logger, signal } = opts;
  if (signal?.aborted) {
    logger.info(
      'The task was cancelled, so the cancelled deployment is not recorded as failed in CALM Hub',
    );
    return;
  }
  const timeoutMs = opts.timeoutMs ?? RECORD_FAILURE_TIMEOUT_MS;
  let timeout: AbortSignal | undefined;
  try {
    timeout = AbortSignal.timeout(timeoutMs);
    const hub = opts.hub?.withSignal(
      AbortSignal.any([...(signal ? [signal] : []), timeout]),
    );
    if (!hub) {
      throw new Error('the action has no CALM Hub client');
    }
    if (opts.appBaseUrl === undefined) {
      throw new Error(
        "the action has no app.baseUrl, which the decorator's deployment-details links to",
      );
    }
    const file = resolveSafeChildPath(
      opts.workspacePath,
      record.architecturePath ?? 'architecture.json',
    );
    const architecture = JSON.parse(await fs.readFile(file, 'utf-8'));
    const labelled = await labelledNodes(opts.baseDir);
    let workloads = deployedNodes(labelled, architecture);
    const notNodes = labelled.filter(w => !workloads.includes(w));
    if (notNodes.length) {
      logger.warn(
        `Not nodes of the architecture, so left out of applies-to: ${notNodes.join(
          ', ',
        )}`,
      );
    }
    if (!workloads.length) {
      workloads = (Array.isArray(architecture?.nodes) ? architecture.nodes : [])
        .map((n: any) => n?.['unique-id'])
        .filter((id: unknown): id is string => typeof id === 'string');
    }
    await recordDeployment(
      hub,
      opts.appBaseUrl,
      {
        ...record,
        name: opts.name,
        cluster: opts.cluster,
        namespace: opts.namespace,
        workloads,
        startTime: opts.startTime,
        endTime: new Date().toISOString(),
        status: 'failed',
        notes: `Deployment failed: ${oneLine(opts.error)} (cluster ${
          opts.cluster
        }, namespace ${opts.namespace}).`,
        workspacePath: opts.workspacePath,
        taskId: opts.taskId,
        // A retry of the task that succeeds records its own decorator: the two must not share a unique-id.
        uniqueIdSuffix: '-failed',
      },
      logger,
    );
  } catch (e) {
    const why =
      timeout?.aborted && !signal?.aborted
        ? `CALM Hub did not answer within ${timeoutMs / 1000} s`
        : oneLine(e);
    logger.warn(`Could not record the failed deployment in CALM Hub: ${why}`);
  }
}
