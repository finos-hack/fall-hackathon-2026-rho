import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ValidationMessage,
  validateArchitecture,
} from '@internal/backstage-plugin-calm-node';

const SHOWN = 5;
const line = (m: ValidationMessage) =>
  `  [${m.severity}] ${m.code ?? ''} ${m.path ?? ''}: ${m.message}`;

/** `calm:validate`: `calm validate` of the architecture against its pattern. Fails when the report has errors. */
export function createCalmValidateAction(options: { hubUrl: string }) {
  return createTemplateAction({
    id: 'calm:validate',
    description:
      'Runs `calm validate` (published @finos/calm-cli) on an architecture against its CALM Hub pattern. Fails on errors; warnings are logged.',
    // Reads the Hub and writes only the report inside the workspace.
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
        patternUrl: z =>
          z.string().describe('Pattern URL in CALM Hub (the pattern $id)'),
        reportPath: z =>
          z
            .string()
            .optional()
            .describe(
              'Where the JSON report goes, relative to the workspace. Default calm-validation.json',
            ),
      },
      output: {
        hasWarnings: z => z.boolean(),
        errorCount: z => z.number(),
        warningCount: z => z.number(),
        reportPath: z =>
          z.string().describe('JSON report, relative to the workspace'),
      },
    },
    async handler(ctx) {
      const architecturePath = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const reportPath = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.reportPath ?? 'calm-validation.json',
      );
      const result = await validateArchitecture({
        patternUrl: ctx.input.patternUrl,
        architecturePath,
        hubUrl: options.hubUrl,
        dir: ctx.workspacePath,
        outputPath: reportPath,
        logger: ctx.logger,
        signal: ctx.signal,
      });

      const summary = [
        `calm validate: ${result.errors.length} errors, ${result.warnings.length} warnings`,
        ...result.errors.slice(0, SHOWN).map(line),
        ...result.warnings.slice(0, SHOWN).map(line),
      ];
      const more =
        Math.max(0, result.errors.length - SHOWN) +
        Math.max(0, result.warnings.length - SHOWN);
      if (more) {
        summary.push(`  … and ${more} more in the report`);
      }
      summary.forEach(l => ctx.logger.info(l));

      if (result.hasErrors) {
        throw new Error(summary.join('\n'));
      }
      ctx.output('hasWarnings', result.hasWarnings);
      ctx.output('errorCount', result.errors.length);
      ctx.output('warningCount', result.warnings.length);
      ctx.output('reportPath', path.relative(ctx.workspacePath, reportPath));
    },
  });
}
