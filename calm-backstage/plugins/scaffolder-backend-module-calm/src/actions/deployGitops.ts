import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  FLUX_NAMESPACE,
  FLUX_RECONCILE_ANNOTATION,
  FluxStatus,
  deployNamespace,
  fluxObjectName,
  fluxObjects,
  fluxTenantObjects,
  readFluxStatus,
  revisionHasCommit,
} from '@internal/backstage-plugin-calm-common';
import {
  GitopsSettings,
  KubernetesDeploySettings,
  gitCommitAll,
  gitCurrentBranch,
  gitHead,
  gitPush,
  kubectlCommand,
  requireKubernetesDeploy,
  serviceRepository,
} from '@internal/backstage-plugin-calm-node';
import {
  Kubectl,
  GITOPS_OVERLAY_HEADER,
  applyObjects,
  checkNamespace,
  clusterKubectl,
  listAndWaitForRollouts,
  requireBase,
  writeOverlay,
} from './deployK8s';
import { CATALOG_INFO_FILE } from './publishLocal';
import { withGitopsAnnotations } from './gitPublish';

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 2_000;

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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const name = fluxObjectName(service);
  const deadline = now() + timeoutMs;
  let last: FluxStatus = { ready: false, message: 'not read yet' };
  let lastMessage = '';
  for (;;) {
    const text = await kubectl(
      [
        '-n',
        FLUX_NAMESPACE,
        'get',
        'kustomization',
        name,
        '--ignore-not-found',
        '-o',
        'json',
      ],
      true,
    );
    last = text.trim()
      ? readFluxStatus(JSON.parse(text))
      : { ready: false, message: `Kustomization ${name} not found` };
    if (last.message !== lastMessage) {
      opts.onStatus?.(last);
      lastMessage = last.message;
    }
    if (last.ready && revisionHasCommit(last.appliedRevision, sha)) {
      return last;
    }
    if (now() >= deadline) {
      throw new Error(
        `Flux did not apply ${sha.slice(0, 12)} within ${Math.round(
          timeoutMs / 1000,
        )} s: Kustomization ${FLUX_NAMESPACE}/${name} is ${
          last.ready ? 'Ready' : 'not Ready'
        }, applied ${last.appliedRevision ?? 'nothing'}: ${last.message}`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * `calm:deploy:gitops`: deploys a service through Git. Writes the overlay (the image over the bundle's base, into the
 * service's namespace) in the working copy, commits it when it changed, applies the Namespace and the service account
 * Flux applies the overlay as (`fluxTenantObjects`), pushes, makes sure Flux has a GitRepository and Kustomization
 * for the service, asks them to reconcile now, waits until Flux has applied that commit, then waits for the rollouts.
 */
export function createCalmDeployGitopsAction(options: {
  settings?: KubernetesDeploySettings;
  gitops?: GitopsSettings;
  localDir: string;
  /** For tests: kubectl, and the Flux wait's timing. */
  kubectl?: (settings: KubernetesDeploySettings, cwd: string) => Kubectl;
  wait?: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}) {
  return createTemplateAction({
    id: 'calm:deploy:gitops',
    description:
      'Deploys a published service through Git and Flux: commits deploy/k8s-overlay with the image, pushes it, points a Flux Kustomization at the repository and waits until Flux has applied the commit and the pods are rolled out.',
    schema: {
      input: {
        dir: z =>
          z
            .string()
            .describe(
              'The service working copy (calm:publish:local output path), inside calm.publish.localDir',
            ),
        name: z =>
          z
            .string()
            .describe('Service name: names the namespace and the Flux objects'),
        image: z =>
          z.string().describe('Image for the service, as <name>:<tag>'),
      },
      output: {
        namespace: z => z.string(),
        deployments: z => z.array(z.string()),
        networkPolicies: z => z.array(z.string()),
        services: z => z.array(z.string()),
        kubectl: z => z.string(),
        cluster: z => z.string(),
        startTime: z => z.string(),
        endTime: z => z.string(),
        repoUrl: z => z.string().describe('Web URL of the repository'),
        commit: z => z.string().describe('The commit Flux applied'),
        kustomization: z =>
          z.string().describe('<namespace>/<name> of the Flux Kustomization'),
      },
    },
    async handler(ctx) {
      const settings = await requireKubernetesDeploy(options.settings);
      const gitops = options.gitops;
      if (!gitops) {
        throw new Error('calm.gitops is not configured');
      }
      const { name, image } = ctx.input;
      const namespace = deployNamespace(settings.namespacePrefix, name);
      const dir = resolveSafeChildPath(
        options.localDir,
        path.relative(options.localDir, path.resolve(ctx.input.dir)),
      );
      await requireBase(dir);
      const kubectl: Kubectl = options.kubectl
        ? options.kubectl(settings, dir)
        : clusterKubectl(settings, {
            cwd: dir,
            logger: ctx.logger,
            signal: ctx.signal,
          });
      await checkNamespace(kubectl, namespace, name);

      const startTime = new Date().toISOString();
      const git = { logger: ctx.logger, signal: ctx.signal };
      const branch = await gitCurrentBranch(dir, git);
      if (branch !== gitops.branch) {
        throw new Error(
          `${dir} is on the branch ${branch}, not ${gitops.branch}: Flux deploys ${gitops.branch}`,
        );
      }
      await writeOverlay(
        dir,
        { name, namespace, image },
        GITOPS_OVERLAY_HEADER,
        { withNamespace: false },
      );
      // From now on the service is deployed from Git: the catalog and the upgrade Template find it by this.
      const catalogInfo = path.join(dir, CATALOG_INFO_FILE);
      const info = await fs
        .readFile(catalogInfo, 'utf-8')
        .catch(() => undefined);
      if (info !== undefined) {
        await fs.writeFile(catalogInfo, withGitopsAnnotations(info, name));
      }
      const made = await gitCommitAll(dir, `Deploy ${image}`, git);
      const commit = made ?? (await gitHead(dir, git));
      ctx.logger.info(
        made
          ? `Committed the overlay for ${image}: ${commit}`
          : `The overlay already deploys ${image}; deploying ${commit}`,
      );
      // Before the push: the pushed overlay no longer holds the Namespace, and for a service deployed before that
      // change, Flux would prune it unless it is already marked prune-disabled.
      await applyObjects(kubectl, fluxTenantObjects({ name, namespace }));
      const repo = serviceRepository(gitops, name);
      await gitPush(dir, repo.pushUrl, gitops.branch, gitops.auth, git);

      await applyObjects(
        kubectl,
        fluxObjects({
          name,
          namespace,
          repoUrl: repo.clusterUrl,
          branch: gitops.branch,
        }),
      );
      const fluxName = fluxObjectName(name);
      await kubectl([
        '-n',
        FLUX_NAMESPACE,
        'annotate',
        '--overwrite',
        `gitrepository/${fluxName}`,
        `kustomization/${fluxName}`,
        `${FLUX_RECONCILE_ANNOTATION}=${new Date().toISOString()}`,
      ]);
      ctx.logger.info(
        `Waiting for Flux to apply ${commit.slice(
          0,
          12,
        )} (${FLUX_NAMESPACE}/${fluxName})`,
      );
      await waitForKustomization(kubectl, name, commit, {
        ...options.wait,
        onStatus: s => ctx.logger.info(`Flux: ${s.message}`),
      });

      const deployed = await listAndWaitForRollouts(kubectl, namespace);
      ctx.logger.info(
        `Flux deployed ${name} at ${commit.slice(0, 12)} to ${
          settings.context
        } / ${namespace}: ${deployed.deployments.join(', ')}`,
      );
      ctx.output('namespace', namespace);
      ctx.output('deployments', deployed.deployments);
      ctx.output('networkPolicies', deployed.networkPolicies);
      ctx.output('services', deployed.services);
      ctx.output('kubectl', kubectlCommand(settings, ['-n', namespace]));
      ctx.output('cluster', settings.context);
      ctx.output('startTime', startTime);
      ctx.output('endTime', new Date().toISOString());
      ctx.output('repoUrl', repo.webUrl);
      ctx.output('commit', commit);
      ctx.output('kustomization', `${FLUX_NAMESPACE}/${fluxName}`);
    },
  });
}
