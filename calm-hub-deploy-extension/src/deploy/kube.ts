// Ported from calm-backstage/plugins/scaffolder-backend-module-calm/src/actions (deployK8s.ts, deployGitops.ts,
// recordFailure.ts): those modules import Backstage's scaffolder at load time, so the small pure helpers are copied
// here rather than imported. Behaviour is unchanged unless a comment says otherwise.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  FLUX_NAMESPACE,
  fluxObjectName,
  readFluxStatus,
  revisionHasCommit,
  type FluxStatus,
} from '@internal/backstage-plugin-calm-common';

/** The bundle's kustomize base and the overlay Flux applies, relative to the repository root. */
export const BASE_DIR = 'deploy/k8s';
export const OVERLAY_DIR = 'deploy/k8s-overlay';
const PLACEHOLDER_IMAGE = 'calm-service';
const ROLLOUT_TIMEOUT = '300s';
const NODE_LABEL = 'calm.finos.org/node';
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'];
const MAX_NOTE = 300;

/** Runs kubectl and returns stdout. `quiet` keeps stdout out of the log; `timeoutMs` aborts a slow call. */
export type Kubectl = (args: string[], quiet?: boolean, timeoutMs?: number) => Promise<string>;

/** The image the overlay deploys (`<newName>:<newTag>` of its `calm-service` entry), or undefined without one. */
export async function readOverlayImage(dir: string): Promise<string | undefined> {
  const text = await fs.readFile(path.join(dir, OVERLAY_DIR, 'kustomization.yaml'), 'utf-8').catch(() => undefined);
  const entry = text ? (YAML.parse(text)?.images ?? []).find((i: any) => i?.name === PLACEHOLDER_IMAGE) : undefined;
  return entry?.newName && entry?.newTag ? `${entry.newName}:${entry.newTag}` : undefined;
}

/**
 * The `calm.finos.org/node` labels of the workloads in some YAML texts: the architecture nodes the bundle rendered.
 * (recordFailure.ts reads a folder; this takes the texts, so the read side can pass files fetched from Gitea.)
 */
export function nodesInManifests(texts: string[]): string[] {
  const nodes = new Set<string>();
  for (const text of texts) {
    for (const doc of YAML.parseAllDocuments(text).map(d => d.toJS())) {
      if (!WORKLOAD_KINDS.includes(doc?.kind)) continue;
      const label = doc.metadata?.labels?.[NODE_LABEL] ?? doc.spec?.template?.metadata?.labels?.[NODE_LABEL];
      if (typeof label === 'string') nodes.add(label);
    }
  }
  return [...nodes].sort();
}

/** `nodesInManifests` over the YAML files of a folder. */
export async function labelledNodes(baseDir: string): Promise<string[]> {
  const files = (await fs.readdir(baseDir).catch(() => [] as string[])).filter(f => /\.ya?ml$/.test(f));
  return nodesInManifests(await Promise.all(files.map(f => fs.readFile(path.join(baseDir, f), 'utf-8'))));
}

/** The error message on one line and at most a few hundred characters, for a decorator's notes. */
export function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text;
}

/** Reads the service's Flux Kustomization; undefined when it does not exist. */
export async function readKustomization(kubectl: Kubectl, service: string, timeoutMs?: number): Promise<any | undefined> {
  const text = await kubectl(
    ['-n', FLUX_NAMESPACE, 'get', 'kustomization', fluxObjectName(service), '--ignore-not-found', '-o', 'json'],
    true,
    timeoutMs,
  );
  return text.trim() ? JSON.parse(text) : undefined;
}

/**
 * Polls the service's Kustomization until it is Ready with `sha` applied. Throws with Flux's own Ready message when
 * it is not there after `timeoutMs`.
 */
export async function waitForKustomization(
  kubectl: Kubectl,
  service: string,
  sha: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onStatus?: (s: FluxStatus) => void;
  } = {},
): Promise<FluxStatus> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 2_000;
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const name = fluxObjectName(service);
  const deadline = now() + timeoutMs;
  let lastMessage = '';
  for (;;) {
    const obj = await readKustomization(kubectl, service);
    const last: FluxStatus = obj ? readFluxStatus(obj) : { ready: false, message: `Kustomization ${name} not found` };
    if (last.message !== lastMessage) {
      opts.onStatus?.(last);
      lastMessage = last.message;
    }
    if (last.ready && revisionHasCommit(last.appliedRevision, sha)) return last;
    if (now() >= deadline) {
      throw new Error(
        `Flux did not apply ${sha.slice(0, 12)} within ${Math.round(timeoutMs / 1000)} s: Kustomization ${FLUX_NAMESPACE}/${name} is ${
          last.ready ? 'Ready' : 'not Ready'
        }, applied ${last.appliedRevision ?? 'nothing'}: ${last.message}`,
      );
    }
    await sleep(pollMs);
  }
}

/** Asks Flux to fetch and apply now instead of at its next interval. */
export async function requestReconcile(kubectl: Kubectl, service: string, at: string): Promise<void> {
  const name = fluxObjectName(service);
  await kubectl([
    '-n',
    FLUX_NAMESPACE,
    'annotate',
    '--overwrite',
    `gitrepository/${name}`,
    `kustomization/${name}`,
    `reconcile.fluxcd.io/requestedAt=${at}`,
  ]);
}

/** Waits for every Deployment in `namespace` to roll out; gives their names. */
export async function waitForRollouts(kubectl: Kubectl, namespace: string): Promise<string[]> {
  const listed = JSON.parse(await kubectl(['-n', namespace, 'get', 'deployments', '-o', 'json'], true));
  const names: string[] = (listed.items ?? []).map((d: any) => d?.metadata?.name).filter(Boolean);
  for (const d of names) {
    await kubectl(['-n', namespace, 'rollout', 'status', `deployment/${d}`, `--timeout=${ROLLOUT_TIMEOUT}`]);
  }
  return names;
}
