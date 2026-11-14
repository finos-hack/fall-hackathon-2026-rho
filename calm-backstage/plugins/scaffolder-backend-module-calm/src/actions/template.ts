import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { parseBundleValue } from '@internal/backstage-plugin-calm-common';
import {
  bundleRef,
  pullBundleCached,
  renderBundle,
} from '@internal/backstage-plugin-calm-node';

/** A template bundle from `calm.bundles`; `path` is absolute. */
export interface BundleLocation {
  name: string;
  version: string;
  path: string;
}

export interface CalmTemplateActionOptions {
  /** Local bundle folders from `calm.bundles` (authoring). */
  bundles: BundleLocation[];
  /** The OCI bundle registry from `calm.bundleRegistry`. */
  registry?: { url: string; repositoryPrefix: string };
  /** Folder registry bundles are pulled into, one folder per manifest digest. */
  cacheDir: string;
  /** The pull; the default is `pullBundleCached` from calm-node. */
  pull?: typeof pullBundleCached;
}

export interface ResolvedBundle {
  name: string;
  version: string;
  /** Absolute path of the bundle folder. */
  dir: string;
  /** OCI reference and manifest digest, when the bundle came from the registry. */
  ref?: string;
  digest?: string;
  /** True when the registry bundle was already in the cache. */
  cached?: boolean;
}

/**
 * Finds the folder of `<name>@<version>`: a local folder in `calm.bundles` first, else the bundle in the registry,
 * pulled into `<cacheDir>/<digest>` (once per digest).
 */
export async function resolveBundle(
  value: string,
  options: CalmTemplateActionOptions,
): Promise<ResolvedBundle> {
  const parsed = parseBundleValue(value);
  if (!parsed) {
    throw new Error(
      `Template bundle must be <name>@<version>, got ${JSON.stringify(value)}`,
    );
  }
  const local = options.bundles.find(
    b => b.name === parsed.name && b.version === parsed.version,
  );
  if (local) {
    return { ...parsed, dir: local.path };
  }
  if (!options.registry) {
    throw new Error(
      `Unknown template bundle ${JSON.stringify(value)}; calm.bundles has ${
        options.bundles.map(b => `${b.name}@${b.version}`).join(', ') ||
        'no bundles'
      } and no calm.bundleRegistry is configured`,
    );
  }
  const ref = bundleRef(
    options.registry.url,
    options.registry.repositoryPrefix,
    parsed.name,
    parsed.version,
  );
  try {
    const pulled = await (options.pull ?? pullBundleCached)({
      ref,
      cacheDir: options.cacheDir,
    });
    return {
      ...parsed,
      dir: pulled.dir,
      ref,
      digest: pulled.digest,
      cached: pulled.cached,
    };
  } catch (e) {
    throw new Error(
      `Template bundle ${JSON.stringify(
        value,
      )} could not be pulled from ${ref}: ${(e as Error).message ?? e}`,
    );
  }
}

/** `calm:template`: renders the architecture with the chosen template bundle into a folder of the workspace. */
export function createCalmTemplateAction(options: CalmTemplateActionOptions) {
  return createTemplateAction({
    id: 'calm:template',
    description:
      'Runs `calm template` (published @finos/calm-cli) with a template bundle (`<name>@<version>`) from a local folder in calm.bundles or, failing that, pulled from the OCI registry in calm.bundleRegistry, rendering into a folder of the workspace.',
    // Reads the bundle (a registry bundle is pulled into the backend's bundle cache) and renders only inside the
    // workspace.
    supportsDryRun: true,
    schema: {
      input: {
        architecturePath: z =>
          z
            .string()
            .optional()
            .describe(
              'Architecture file, relative to the workspace. Default architecture.json',
            ),
        bundle: z =>
          z
            .string()
            .describe(
              'Template bundle as `<name>@<version>`: in calm.bundles or in the bundle registry',
            ),
        outputDir: z =>
          z
            .string()
            .optional()
            .describe(
              'Output folder relative to the workspace, without dots. Default rendered',
            ),
      },
      output: {
        outputDir: z =>
          z.string().describe('Output folder, relative to the workspace'),
        files: z =>
          z
            .array(z.string())
            .describe('Rendered files, relative to the output folder'),
        bundleName: z => z.string(),
        bundleVersion: z => z.string(),
        bundleRef: z =>
          z
            .string()
            .describe(
              'OCI reference the bundle was pulled from; empty for a local folder',
            ),
        bundleDigest: z =>
          z
            .string()
            .describe(
              'Manifest digest of the pulled bundle (sha256:…); empty for a local folder',
            ),
      },
    },
    async handler(ctx) {
      const bundle = await resolveBundle(ctx.input.bundle, options);
      ctx.logger.info(
        bundle.ref
          ? `Bundle ${bundle.name}@${bundle.version}: ${bundle.ref} ${
              bundle.digest
            } (${bundle.cached ? 'already pulled' : 'pulled'}) in ${bundle.dir}`
          : `Bundle ${bundle.name}@${bundle.version}: local folder ${bundle.dir}`,
      );
      const architecturePath = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      // Inside the workspace (resolveSafeChildPath); renderBundle also refuses dotted segments.
      resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.outputDir ?? 'rendered',
      );

      const { outputDir, files } = await renderBundle({
        architecturePath,
        bundleDir: bundle.dir,
        dir: ctx.workspacePath,
        outputDir: ctx.input.outputDir ?? 'rendered',
        logger: ctx.logger,
        signal: ctx.signal,
      });
      ctx.logger.info(
        `Rendered ${files.length} files with ${bundle.name}@${
          bundle.version
        } into ${outputDir}: ${files.join(', ')}`,
      );
      ctx.output('outputDir', outputDir.split(path.sep).join('/'));
      ctx.output('files', files);
      ctx.output('bundleName', bundle.name);
      ctx.output('bundleVersion', bundle.version);
      ctx.output('bundleRef', bundle.ref ?? '');
      ctx.output('bundleDigest', bundle.digest ?? '');
    },
  });
}
