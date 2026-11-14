import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  CALM_ANNOTATIONS as ANN,
  CALM_GITOPS_TAG,
  gitopsAnnotationValue,
} from '@internal/backstage-plugin-calm-common';
import {
  GitopsSettings,
  git as gitRun,
  gitCommitAll,
  gitHead,
  gitInit,
  gitPush,
  serviceRepository,
} from '@internal/backstage-plugin-calm-node';
import YAML from 'yaml';
import { CATALOG_INFO_FILE } from './publishLocal';

/** Adds the Git repository, the Flux Kustomization and the `calm-gitops` tag to a catalog-info.yaml text. */
export function withGitAnnotations(
  catalogInfo: string,
  o: { name: string; repoUrl: string },
): string {
  const entity = YAML.parse(catalogInfo);
  entity.metadata.annotations = {
    ...(entity.metadata.annotations ?? {}),
    [ANN.gitRepo]: o.repoUrl,
    [ANN.gitops]: gitopsAnnotationValue(o.name),
  };
  const tags: string[] = entity.metadata.tags ?? [];
  entity.metadata.tags = tags.includes(CALM_GITOPS_TAG)
    ? tags
    : [...tags, CALM_GITOPS_TAG];
  const links: { url: string; title: string }[] = entity.metadata.links ?? [];
  if (!links.some(l => l.url === o.repoUrl)) {
    entity.metadata.links = [
      ...links,
      { url: o.repoUrl, title: 'Git repository' },
    ];
  }
  return YAML.stringify(entity);
}

/**
 * `calm:git:publish`: makes the published folder a Git working copy, records the repository in its
 * catalog-info.yaml, commits and pushes it to `<calm.gitops.gitUrl>/<servicesOrg>/<name>` (the push creates the
 * repository). Never forced: a repository left by an earlier service of the same name refuses the push.
 */
export function createCalmGitPublishAction(options: {
  settings?: GitopsSettings;
  /** Absolute path of `calm.publish.localDir`: only folders inside it are published. */
  localDir: string;
}) {
  return createTemplateAction({
    id: 'calm:git:publish',
    description:
      'Commits a published service folder and pushes it to its repository on the Git server in calm.gitops (output/<name> becomes the working copy).',
    schema: {
      input: {
        dir: z =>
          z
            .string()
            .describe(
              'The published folder (calm:publish:local output path), inside calm.publish.localDir',
            ),
        name: z => z.string().describe('Service name: the repository name'),
        message: z =>
          z.string().optional().describe('Commit message'),
      },
      output: {
        repoUrl: z => z.string().describe('Web URL of the repository'),
        commit: z => z.string().describe('The commit pushed'),
        shortCommit: z =>
          z.string().describe('Its first 12 characters (image tags)'),
      },
    },
    async handler(ctx) {
      const settings = options.settings;
      if (!settings) {
        throw new Error(
          'calm.gitops is not configured, so there is no Git server to publish to',
        );
      }
      const { name } = ctx.input;
      const dir = resolveSafeChildPath(
        options.localDir,
        path.relative(options.localDir, path.resolve(ctx.input.dir)),
      );
      const repo = serviceRepository(settings, name);

      const catalogInfo = path.join(dir, CATALOG_INFO_FILE);
      const text = await fs.readFile(catalogInfo, 'utf-8').catch(() => undefined);
      if (text !== undefined) {
        await fs.writeFile(
          catalogInfo,
          withGitAnnotations(text, { name, repoUrl: repo.webUrl }),
        );
      }

      const git = { logger: ctx.logger, signal: ctx.signal };
      await gitInit(dir, settings.branch, git);
      // A named remote for whoever works in the folder later (no credentials in it; pushes pass them per call).
      const remotes = await gitRun(dir, ['remote'], git);
      if (!remotes.split('\n').includes('origin')) {
        await gitRun(dir, ['remote', 'add', 'origin', repo.pushUrl], git);
      }
      const message =
        ctx.input.message ?? `Create ${name} from its CALM pattern`;
      await gitCommitAll(dir, message, git);
      const commit = await gitHead(dir, git);
      ctx.logger.info(`Pushing ${commit} to ${repo.pushUrl}`);
      await gitPush(dir, repo.pushUrl, settings.branch, settings.auth, git);
      ctx.logger.info(`Published ${name} to ${repo.webUrl}`);
      ctx.output('repoUrl', repo.webUrl);
      ctx.output('commit', commit);
      ctx.output('shortCommit', commit.slice(0, 12));
    },
  });
}
