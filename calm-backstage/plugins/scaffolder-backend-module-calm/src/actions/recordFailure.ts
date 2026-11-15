import fs from 'node:fs/promises';
import path from 'node:path';
import { LoggerService } from '@backstage/backend-plugin-api';
import { CalmHubWriteClient } from '@internal/backstage-plugin-calm-common';
import YAML from 'yaml';
import { recordDeployment } from './decorateDeployment';

/** The label the bundles put on a workload: the `unique-id` of the architecture node it was rendered from. */
const NODE_LABEL = 'calm.finos.org/node';
/** The workload kinds whose `calm.finos.org/node` label names the architecture node they run. */
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
 * The `calm.finos.org/node` labels of the workloads in the YAML files of `baseDir`: the architecture nodes the
 * bundle rendered. Empty when the folder or the labels are missing.
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
      const label =
        doc.metadata?.labels?.[NODE_LABEL] ??
        doc.spec?.template?.metadata?.labels?.[NODE_LABEL];
      if (typeof label === 'string') {
        nodes.add(label);
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
 * nodes the rendered base labels (all the architecture's nodes when none is labelled) and says what failed. Never
 * throws: a problem recording it is logged as a warning, so the caller's own error is the one that surfaces.
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
}): Promise<void> {
  const { hub, record, logger } = opts;
  try {
    if (!hub || opts.appBaseUrl === undefined) {
      throw new Error('the action has no CALM Hub client');
    }
    let workloads = await labelledNodes(opts.baseDir);
    if (!workloads.length) {
      const file = path.resolve(
        opts.workspacePath,
        record.architecturePath ?? 'architecture.json',
      );
      const doc = JSON.parse(await fs.readFile(file, 'utf-8'));
      workloads = (Array.isArray(doc?.nodes) ? doc.nodes : [])
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
      },
      logger,
    );
  } catch (e) {
    logger.warn(
      `Could not record the failed deployment in CALM Hub: ${oneLine(e)}`,
    );
  }
}
