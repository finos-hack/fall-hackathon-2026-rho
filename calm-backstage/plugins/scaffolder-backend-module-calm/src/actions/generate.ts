import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { generateArchitecture } from '@internal/backstage-plugin-calm-node';

export function createCalmGenerateAction(options: { hubUrl: string }) {
  return createTemplateAction({
    id: 'calm:generate',
    description:
      'Runs `calm generate` (published @finos/calm-cli) on a CALM Hub pattern with pre-set option choices.',
    // Reads the Hub and writes only inside the workspace, so a dry run can run it for real.
    supportsDryRun: true,
    schema: {
      input: {
        patternUrl: z =>
          z.string().describe('Pattern URL in CALM Hub (the pattern $id)'),
        choices: z =>
          z
            .record(z.any())
            .optional()
            .describe(
              'Decision id -> choice description (oneOf) or list of descriptions (anyOf)',
            ),
        outputPath: z =>
          z
            .string()
            .optional()
            .describe(
              'Architecture file, relative to the workspace. Default architecture.json',
            ),
      },
      output: {
        architecturePath: z =>
          z.string().describe('Architecture file, relative to the workspace'),
        nodeCount: z => z.number(),
        relationshipCount: z => z.number(),
      },
    },
    async handler(ctx) {
      const outputPath = ctx.input.outputPath ?? 'architecture.json';
      const target = resolveSafeChildPath(ctx.workspacePath, outputPath);
      const { nodeCount, relationshipCount } = await generateArchitecture({
        patternUrl: ctx.input.patternUrl,
        hubUrl: options.hubUrl,
        choices: ctx.input.choices ?? {},
        dir: ctx.workspacePath,
        outputPath: target,
        logger: ctx.logger,
        signal: ctx.signal,
      });

      const relative = path.relative(ctx.workspacePath, target);
      ctx.logger.info(
        `Generated ${relative}: ${nodeCount} nodes, ${relationshipCount} relationships`,
      );
      ctx.output('architecturePath', relative);
      ctx.output('nodeCount', nodeCount);
      ctx.output('relationshipCount', relationshipCount);
    },
  });
}
