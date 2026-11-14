import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { parseBundleValue } from '@internal/backstage-plugin-calm-common';
import { renderBundle } from '@internal/backstage-plugin-calm-node';

/** A template bundle from `calm.bundles`; `path` is absolute. */
export interface BundleLocation {
  name: string;
  version: string;
  path: string;
}

/** `calm:template`: renders the architecture with the chosen template bundle into a folder of the workspace. */
export function createCalmTemplateAction(options: {
  bundles: BundleLocation[];
}) {
  return createTemplateAction({
    id: 'calm:template',
    description:
      'Runs `calm template` (published @finos/calm-cli) with a template bundle from calm.bundles (`<name>@<version>`), rendering into a folder of the workspace.',
    // Reads the bundle and writes only inside the workspace.
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
              'Template bundle as `<name>@<version>`, one of calm.bundles',
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
      },
    },
    async handler(ctx) {
      const parsed = parseBundleValue(ctx.input.bundle);
      const bundle = parsed
        ? options.bundles.find(
            b => b.name === parsed.name && b.version === parsed.version,
          )
        : undefined;
      if (!parsed || !bundle) {
        throw new Error(
          `Unknown template bundle ${JSON.stringify(
            ctx.input.bundle,
          )}; calm.bundles has ${options.bundles
            .map(b => `${b.name}@${b.version}`)
            .join(', ')}`,
        );
      }
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
        bundleDir: bundle.path,
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
    },
  });
}
