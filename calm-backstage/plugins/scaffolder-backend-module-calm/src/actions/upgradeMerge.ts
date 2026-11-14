import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  GiteaClient,
  deployNamespace,
} from '@internal/backstage-plugin-calm-common';
import {
  GitopsSettings,
  KubernetesDeploySettings,
  DEFAULT_NAMESPACE_PREFIX,
  gitCheckoutBranch,
  gitCommitAll,
  gitCurrentBranch,
  gitDeleteBranch,
  gitDiffStat,
  gitHead,
  gitPull,
  gitPush,
  serviceRepository,
} from '@internal/backstage-plugin-calm-node';
import { GITOPS_OVERLAY_HEADER, OVERLAY_DIR, writeOverlay } from './deployK8s';

/** The pull request body: what changes, the files, and what happens after the merge. */
export function pullRequestBody(o: {
  summary: string;
  diffStat: string;
  image: string;
}): string {
  return [
    o.summary,
    '',
    `The image deployed after the merge: \`${o.image}\` (set in \`${OVERLAY_DIR}\`). Flux applies the merge commit.`,
    '',
    'Files:',
    '',
    '```',
    o.diffStat,
    '```',
    '',
    'Opened by Backstage (calm:upgrade:merge).',
  ].join('\n');
}

/**
 * `calm:upgrade:merge`: finishes an upgrade prepared by calm:upgrade:render. Sets the image in the overlay on the
 * branch, pushes the branch, opens a pull request in the Git server, merges it and fast-forwards main, so main only
 * ever holds a complete upgrade and its merge commit is the one Flux applies.
 */
export function createCalmUpgradeMergeAction(options: {
  gitops?: GitopsSettings;
  settings?: KubernetesDeploySettings;
  localDir: string;
  /** For tests. */
  gitea?: GiteaClient;
  mergeAttempts?: number;
  mergeRetryMs?: number;
}) {
  return createTemplateAction({
    id: 'calm:upgrade:merge',
    description:
      'Sets the image on an upgrade branch, pushes it, opens a pull request on the Git server, merges it and brings main up to date.',
    schema: {
      input: {
        dir: z =>
          z
            .string()
            .describe('The working copy (calm:upgrade:render output dir)'),
        name: z => z.string().describe('Service name: the repository'),
        branch: z => z.string().describe('The upgrade branch'),
        image: z => z.string().describe('The image to deploy after the merge'),
        summary: z =>
          z
            .string()
            .optional()
            .describe('What changes (calm:upgrade:render output summary)'),
      },
      output: {
        prUrl: z => z.string(),
        prNumber: z => z.number(),
        commit: z => z.string().describe('main after the merge'),
      },
    },
    async handler(ctx) {
      const gitops = options.gitops;
      if (!gitops) {
        throw new Error('calm.gitops is not configured');
      }
      const { name, branch, image } = ctx.input;
      const dir = resolveSafeChildPath(
        options.localDir,
        path.relative(options.localDir, path.resolve(ctx.input.dir)),
      );
      const git = { logger: ctx.logger, signal: ctx.signal };
      if ((await gitCurrentBranch(dir, git)) !== branch) {
        throw new Error(`${dir} is not on the branch ${branch}`);
      }
      const prefix =
        options.settings?.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX;
      await writeOverlay(
        dir,
        { name, namespace: deployNamespace(prefix, name), image },
        GITOPS_OVERLAY_HEADER,
      );
      await gitCommitAll(dir, `Deploy ${image}`, git);
      const diffStat = await gitDiffStat(dir, gitops.branch, git);
      const repo = serviceRepository(gitops, name);
      // The upgrade branch is this action's own: a run that failed after pushing it left an older one there.
      await gitPush(dir, repo.pushUrl, branch, gitops.auth, {
        ...git,
        force: true,
      });

      const gitea =
        options.gitea ?? new GiteaClient(gitops.gitUrl, gitops.auth);
      const summary = ctx.input.summary ?? 'Upgrade';
      const title = `Upgrade ${name}: ${summary.split('\n').join('; ')}`;
      const pr =
        (await gitea.findOpenPullRequest(
          gitops.servicesOrg,
          name,
          branch,
          gitops.branch,
        )) ??
        (await gitea.createPullRequest(gitops.servicesOrg, name, {
          head: branch,
          base: gitops.branch,
          title,
          body: pullRequestBody({ summary, diffStat, image }),
        }));
      ctx.logger.info(`Pull request ${pr.url}`);
      // Gitea checks whether a new pull request can be merged in the background, and refuses until it knows.
      for (let attempt = 1; ; attempt++) {
        try {
          await gitea.mergePullRequest(
            gitops.servicesOrg,
            name,
            pr.number,
            title,
          );
          break;
        } catch (e) {
          if (
            attempt >= (options.mergeAttempts ?? 6) ||
            !/returned 405/.test(String(e))
          ) {
            throw e;
          }
          ctx.logger.info(`Gitea cannot merge #${pr.number} yet; trying again`);
          await new Promise(r => setTimeout(r, options.mergeRetryMs ?? 2000));
        }
      }
      ctx.logger.info(`Merged pull request #${pr.number}`);

      await gitCheckoutBranch(dir, gitops.branch, false, git);
      await gitPull(dir, repo.pushUrl, gitops.branch, gitops.auth, git);
      await gitDeleteBranch(dir, branch, git);
      const commit = await gitHead(dir, git);
      ctx.logger.info(`main is now ${commit}`);
      ctx.output('prUrl', pr.url);
      ctx.output('prNumber', pr.number);
      ctx.output('commit', commit);
    },
  });
}
