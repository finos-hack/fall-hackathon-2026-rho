import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  BundleMeta,
  CALM_ANNOTATIONS as ANN,
  CalmHubClient,
  UpgradeTargets,
  bundleEntityName,
  serviceBundles,
  upgradeTargets,
} from '@internal/backstage-plugin-calm-common';
import {
  GitopsSettings,
  gitCheckoutBranch,
  gitCommitAll,
  gitCurrentBranch,
  gitDeleteBranch,
  gitPull,
  gitReset,
  git as gitRun,
  renderBundle,
  serviceRepository,
} from '@internal/backstage-plugin-calm-node';
import YAML from 'yaml';
import { CATALOG_INFO_FILE, LEGACY_ARCHITECTURE_FILE } from './publishLocal';
import { readOverlayImage, BASE_DIR } from './deployK8s';
import { CalmTemplateActionOptions, resolveBundle } from './template';

/** Renders `<name>@<version>` against an architecture into a new folder under `tmp`; returns the files it wrote. */
export type RenderInto = (
  bundle: string,
  architecturePath: string,
  outDir: string,
  logger: LoggerService,
) => Promise<{ files: string[]; ref?: string; digest?: string }>;

export function defaultRenderInto(
  options: CalmTemplateActionOptions,
): RenderInto {
  return async (bundle, architecturePath, outDir, logger) => {
    const resolved = await resolveBundle(bundle, options);
    const r = await renderBundle({
      architecturePath,
      bundleDir: resolved.dir,
      dir: path.dirname(outDir),
      outputDir: path.basename(outDir),
      logger,
    });
    return { files: r.files, ref: resolved.ref, digest: resolved.digest };
  };
}

/** The branch an upgrade is prepared on. */
export function upgradeBranch(t: UpgradeTargets): string {
  const code = t.starter?.to;
  const deploy = t.deploy?.to;
  if (code && deploy) {
    return `upgrade/both-${t.starter!.name}-${code}-${
      t.deploy!.name
    }-${deploy}`;
  }
  return code
    ? `upgrade/code-${t.starter!.name}-${code}`
    : `upgrade/deploy-${t.deploy!.name}-${deploy}`;
}

/** Where the upgrade writes the architecture it reads from CALM Hub, in the task workspace (the calm CLI needs a file). */
export const WORKSPACE_ARCHITECTURE = 'architecture.json';

/** The summary line of an upgrade that also removes a service's old architecture copy. */
export const LEGACY_COPY_REMOVED = `Removes ${LEGACY_ARCHITECTURE_FILE}: the architecture lives only in CALM Hub`;

/** One line per side that changes, for the commit message and the pull request. */
export function upgradeSummary(t: UpgradeTargets): string[] {
  return [
    ...(t.starter?.to
      ? [`Code: starter ${t.starter.name} ${t.starter.from} → ${t.starter.to}`]
      : []),
    ...(t.deploy?.to
      ? [`Deployment rules: ${t.deploy.name} ${t.deploy.from} → ${t.deploy.to}`]
      : []),
  ];
}

/**
 * catalog-info.yaml with the new bundle versions (annotations, dependsOn, the starter's OCI reference), and without
 * the legacy architecture-file annotation: CALM Hub holds the architecture.
 */
export function withUpgradedBundles(
  catalogInfo: string,
  t: UpgradeTargets,
  starterRef?: { ref?: string; digest?: string },
): string {
  const e = YAML.parse(catalogInfo);
  const a = (e.metadata.annotations = e.metadata.annotations ?? {});
  delete a[ANN.architectureFile];
  const deps: string[] = e.spec?.dependsOn ?? [];
  const swap = (name: string, from: string, to: string) => {
    const old = `resource:default/${bundleEntityName(name, from)}`;
    const now = `resource:default/${bundleEntityName(name, to)}`;
    const i = deps.indexOf(old);
    if (i >= 0) {
      deps[i] = now;
    } else if (!deps.includes(now)) {
      deps.push(now);
    }
  };
  if (t.starter?.to) {
    a[ANN.bundleVersion] = t.starter.to;
    swap(t.starter.name, t.starter.from, t.starter.to);
    if (starterRef?.ref) {
      a[ANN.bundleRef] = starterRef.ref;
    }
    if (starterRef?.digest) {
      a[ANN.bundleDigest] = starterRef.digest;
    }
  }
  if (t.deploy?.to) {
    a[ANN.deployBundleVersion] = t.deploy.to;
    swap(t.deploy.name, t.deploy.from, t.deploy.to);
  }
  if (e.spec) {
    e.spec.dependsOn = deps;
  }
  if (typeof e.metadata.description === 'string' && t.starter?.to) {
    e.metadata.description = e.metadata.description.replace(
      `${t.starter.name} ${t.starter.from}`,
      `${t.starter.name} ${t.starter.to}`,
    );
  }
  if (typeof e.metadata.description === 'string' && t.deploy?.to) {
    e.metadata.description = e.metadata.description.replace(
      `${t.deploy.name} ${t.deploy.from}`,
      `${t.deploy.name} ${t.deploy.to}`,
    );
  }
  return YAML.stringify(e);
}

async function copyFiles(from: string, files: string[], to: string) {
  for (const f of files) {
    const dest = resolveSafeChildPath(to, f);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(from, f), dest);
  }
}

/**
 * `calm:upgrade:render`: prepares an upgrade of a service in its working copy, on a new branch, without pushing.
 * Starts from a clean main (a branch left by a failed run is deleted). A code upgrade replaces the files the old
 * starter rendered with those the new one renders (files the developer added stay); a deployment upgrade replaces
 * deploy/k8s. catalog-info.yaml gets the new versions. Nothing changes when neither side has a newer version.
 */
export function createCalmUpgradeRenderAction(options: {
  catalog: CatalogService;
  gitops?: GitopsSettings;
  localDir: string;
  /** Bundles in the registry (and local folders) to choose upgrades from. */
  listBundles: () => Promise<BundleMeta[]>;
  renderInto: RenderInto;
  /** Where the architecture is read from: the exact version the service's annotations name. */
  hub: Pick<CalmHubClient, 'architecture'>;
}) {
  return createTemplateAction({
    id: 'calm:upgrade:render',
    description:
      "Prepares an upgrade of a CALM service's starter (code) and/or deployment rules on a branch of its working copy: re-renders with the newest fitting versions and commits, without pushing.",
    schema: {
      input: {
        entityRef: z => z.string().describe('The service Component'),
        upgradeCode: z =>
          z.boolean().optional().describe('Upgrade the starter. Default true'),
        upgradeDeploy: z =>
          z
            .boolean()
            .optional()
            .describe('Upgrade the deployment rules. Default true'),
      },
      output: {
        changed: z => z.boolean().describe('Something was upgraded'),
        codeChanged: z =>
          z.boolean().describe('The starter was upgraded: build a new image'),
        name: z => z.string(),
        dir: z => z.string().describe('The working copy'),
        branch: z => z.string(),
        commit: z => z.string(),
        shortCommit: z => z.string(),
        currentImage: z =>
          z.string().describe('The image the overlay deploys now'),
        summary: z => z.string().describe('What changes, one line per side'),
        starter: z => z.string().describe('<name>@<version> after the upgrade'),
        deployBundle: z =>
          z.string().describe('<name>@<version> after the upgrade, or empty'),
        architecturePath: z =>
          z
            .string()
            .describe(
              'The architecture, read from CALM Hub into the workspace',
            ),
        hubNamespace: z => z.string(),
        architecture: z => z.string(),
        architectureVersion: z => z.string(),
      },
    },
    async handler(ctx) {
      if (!options.gitops) {
        throw new Error(
          'calm.gitops is not configured: only services in Git can be upgraded',
        );
      }
      const ref = stringifyEntityRef(parseEntityRef(ctx.input.entityRef));
      const entity = await options.catalog.getEntityByRef(ref, {
        credentials: await ctx.getInitiatorCredentials(),
      });
      if (!entity) {
        throw new Error(`${ref} is not in the catalog`);
      }
      const name = entity.metadata.name;
      const a = entity.metadata.annotations ?? {};
      const current = serviceBundles(a);
      if (!a[ANN.gitops] || !current.pattern || !current.starter) {
        throw new Error(
          `${ref} is not a CALM service in Git (it needs ${ANN.gitops}, ${ANN.pattern} and ${ANN.bundle}); create it again with a starter to upgrade it`,
        );
      }
      if (!current.deploy) {
        throw new Error(
          `${ref} was made with the full bundle ${current.starter.name} ${current.starter.version}, which has no separate deployment rules; create it again with a starter to upgrade it`,
        );
      }
      const dir = resolveSafeChildPath(options.localDir, name);
      const targets = upgradeTargets(
        current,
        await options.listBundles(),
        current.pattern,
      );
      const wanted: UpgradeTargets = {
        ...(ctx.input.upgradeCode !== false && targets.starter?.to
          ? { starter: targets.starter }
          : {}),
        ...(ctx.input.upgradeDeploy !== false && targets.deploy?.to
          ? { deploy: targets.deploy }
          : {}),
      };
      const hubNamespace =
        a[ANN.architectureNamespace] ?? a[ANN.namespace] ?? '';
      const git = { logger: ctx.logger, signal: ctx.signal };
      const base = {
        name,
        dir,
        hubNamespace,
        architecture: a[ANN.architecture] ?? '',
        architectureVersion: a[ANN.architectureVersion] ?? '',
        currentImage: '',
      };
      for (const [k, v] of Object.entries(base)) {
        ctx.output(k as any, v);
      }
      // CALM Hub holds the only copy of the architecture: read the exact version the service was made from.
      if (!hubNamespace || !base.architecture || !base.architectureVersion) {
        throw new Error(
          `${ref} does not name its architecture in CALM Hub (it needs ${ANN.architecture}, ${ANN.architectureVersion} and a namespace); create it again to upgrade it`,
        );
      }
      let architectureDoc: unknown;
      try {
        architectureDoc = await options.hub.architecture(
          hubNamespace,
          base.architecture,
          base.architectureVersion,
        );
      } catch (e) {
        throw new Error(
          `CALM Hub did not give the architecture ${hubNamespace}/${
            base.architecture
          } ${base.architectureVersion} of ${ref}: ${
            (e as Error).message ?? e
          }`,
        );
      }
      const workspaceArchitecture = resolveSafeChildPath(
        ctx.workspacePath,
        WORKSPACE_ARCHITECTURE,
      );
      await fs.writeFile(
        workspaceArchitecture,
        `${JSON.stringify(architectureDoc, null, 2)}\n`,
      );
      ctx.output('architecturePath', WORKSPACE_ARCHITECTURE);

      const summary = upgradeSummary(wanted);
      if (!summary.length) {
        ctx.logger.info(
          `${name} is up to date: starter ${current.starter.name} ${current.starter.version}, deployment rules ${current.deploy.name} ${current.deploy.version}`,
        );
        ctx.output('changed', false);
        ctx.output('codeChanged', false);
        ctx.output('branch', '');
        ctx.output('commit', '');
        ctx.output('shortCommit', '');
        ctx.output('summary', 'Already up to date.');
        ctx.output(
          'starter',
          `${current.starter.name}@${current.starter.version}`,
        );
        ctx.output(
          'deployBundle',
          `${current.deploy.name}@${current.deploy.version}`,
        );
        return;
      }

      // A clean main, up to date with the repository. Uncommitted work on main is the developer's: refuse rather
      // than discard it. A half-done upgrade branch from a failed run is discarded.
      const branchNow = await gitCurrentBranch(dir, git);
      const dirty = Boolean(await gitRun(dir, ['status', '--porcelain'], git));
      if (dirty && !branchNow.startsWith('upgrade/')) {
        throw new Error(
          `${dir} has uncommitted changes on ${branchNow}; commit or remove them before upgrading`,
        );
      }
      await gitReset(dir, git);
      if (branchNow !== options.gitops.branch) {
        await gitCheckoutBranch(dir, options.gitops.branch, false, git);
      }
      const repo = serviceRepository(options.gitops, name);
      await gitPull(
        dir,
        repo.pushUrl,
        options.gitops.branch,
        options.gitops.auth,
        git,
      );
      const currentImage = await readOverlayImage(dir);
      if (!currentImage) {
        throw new Error(
          `${name} has never been deployed (no image in deploy/k8s-overlay); deploy it before upgrading`,
        );
      }
      ctx.output('currentImage', currentImage);
      const branch = upgradeBranch(wanted);
      await gitDeleteBranch(dir, branch, git);
      await gitCheckoutBranch(dir, branch, true, git);

      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-upgrade-'));
      let starterRef: { ref?: string; digest?: string } | undefined;
      try {
        const arch = workspaceArchitecture;
        if (wanted.starter?.to) {
          const old = await options.renderInto(
            `${wanted.starter.name}@${wanted.starter.from}`,
            arch,
            path.join(tmp, 'old'),
            ctx.logger,
          );
          const now = await options.renderInto(
            `${wanted.starter.name}@${wanted.starter.to}`,
            arch,
            path.join(tmp, 'new'),
            ctx.logger,
          );
          starterRef = now;
          for (const f of old.files.filter(x => !now.files.includes(x))) {
            await fs.rm(resolveSafeChildPath(dir, f), { force: true });
          }
          await copyFiles(path.join(tmp, 'new'), now.files, dir);
          ctx.logger.info(
            `Re-rendered the code with ${wanted.starter.name} ${
              wanted.starter.to
            }: ${now.files.join(', ')}`,
          );
        }
        if (wanted.deploy?.to) {
          const now = await options.renderInto(
            `${wanted.deploy.name}@${wanted.deploy.to}`,
            arch,
            path.join(tmp, 'deploy'),
            ctx.logger,
          );
          await fs.rm(path.join(dir, BASE_DIR), {
            recursive: true,
            force: true,
          });
          await copyFiles(path.join(tmp, 'deploy'), now.files, dir);
          ctx.logger.info(
            `Re-rendered ${BASE_DIR} with ${wanted.deploy.name} ${wanted.deploy.to}`,
          );
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }

      // A service made before CALM Hub became the only store carries a copy; the upgrade removes it.
      const legacyCopy = resolveSafeChildPath(dir, LEGACY_ARCHITECTURE_FILE);
      const hadLegacyCopy = await fs
        .stat(legacyCopy)
        .then(() => true)
        .catch(() => false);
      if (hadLegacyCopy) {
        await fs.rm(legacyCopy);
        ctx.logger.info(LEGACY_COPY_REMOVED);
      }
      const lines = [
        ...summary,
        ...(hadLegacyCopy ? [LEGACY_COPY_REMOVED] : []),
      ];

      const catalogInfo = path.join(dir, CATALOG_INFO_FILE);
      await fs.writeFile(
        catalogInfo,
        withUpgradedBundles(
          await fs.readFile(catalogInfo, 'utf-8'),
          wanted,
          starterRef,
        ),
      );
      const commit = await gitCommitAll(
        dir,
        [`Upgrade ${name}`, '', ...lines].join('\n'),
        git,
      );
      if (!commit) {
        // The new versions render the same files: nothing to merge.
        await gitCheckoutBranch(dir, options.gitops.branch, false, git);
        await gitDeleteBranch(dir, branch, git);
        ctx.logger.info(
          'The new versions render the same files; nothing to upgrade',
        );
        ctx.output('changed', false);
        ctx.output('codeChanged', false);
        ctx.output('branch', '');
        ctx.output('commit', '');
        ctx.output('shortCommit', '');
        ctx.output('summary', 'The newer versions render the same files.');
      } else {
        ctx.output('changed', true);
        ctx.output('codeChanged', Boolean(wanted.starter?.to));
        ctx.output('branch', branch);
        ctx.output('commit', commit);
        ctx.output('shortCommit', commit.slice(0, 12));
        ctx.output('summary', lines.join('\n'));
      }
      const s = wanted.starter?.to ?? current.starter.version;
      const d = wanted.deploy?.to ?? current.deploy.version;
      ctx.output('starter', `${current.starter.name}@${s}`);
      ctx.output('deployBundle', `${current.deploy.name}@${d}`);
    },
  });
}
