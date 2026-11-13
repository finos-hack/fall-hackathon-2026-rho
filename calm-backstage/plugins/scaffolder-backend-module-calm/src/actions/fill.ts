import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  Placeholder,
  PlaceholderValues,
  fillPlaceholders,
  scanPlaceholders,
} from '@internal/backstage-plugin-calm-common';

const describe = (p: Placeholder) => `${p.path} (${p.label}; ${p.name})`;

/**
 * `calm:fill`: sets the placeholder values (keyed by JSON Pointer, as the CalmPlaceholders field gives them) in the
 * generated architecture. This is the real completeness check: a task sent through the API skips the form field's
 * validator. Fails on a value for a path that is not a placeholder, and on any placeholder still open after the fill.
 */
export function createCalmFillAction() {
  return createTemplateAction({
    id: 'calm:fill',
    description:
      'Fills the placeholders calm generate left in an architecture with the values from the form (keyed by JSON Pointer). Fails while any placeholder is still open.',
    // Reads and writes only inside the workspace.
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
        values: z =>
          z
            .record(z.union([z.string(), z.number(), z.null()]))
            .optional()
            .describe(
              'JSON Pointer -> value (the CalmPlaceholders form value). Empty strings and nulls count as not given',
            ),
        outputPath: z =>
          z
            .string()
            .optional()
            .describe(
              'Where to write the filled architecture, relative to the workspace. Default: over architecturePath',
            ),
      },
      output: {
        architecturePath: z =>
          z.string().describe('Filled architecture, relative to the workspace'),
        filledCount: z => z.number(),
      },
    },
    async handler(ctx) {
      const source = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const target = ctx.input.outputPath
        ? resolveSafeChildPath(ctx.workspacePath, ctx.input.outputPath)
        : source;
      const doc = JSON.parse(await fs.readFile(source, 'utf8'));
      const before = scanPlaceholders(doc);
      const known = new Set(before.map(p => p.path));

      // The form seeds every path with ''; an empty answer leaves the placeholder open.
      const values: PlaceholderValues = {};
      for (const [pointer, value] of Object.entries(ctx.input.values ?? {})) {
        if (
          value === null ||
          value === undefined ||
          String(value).trim() === ''
        ) {
          continue;
        }
        values[pointer] = value;
      }
      const unknown = Object.keys(values).filter(k => !known.has(k));
      if (unknown.length) {
        throw new Error(
          `Values for paths that are not placeholders in ${path.basename(
            source,
          )}: ${unknown.join(', ')}. Placeholders: ${[...known].join(', ')}`,
        );
      }

      const filled = fillPlaceholders(doc, values);
      const open = scanPlaceholders(filled);
      if (open.length) {
        throw new Error(
          `${open.length} of ${
            before.length
          } placeholders still need a value: ${open.map(describe).join('; ')}`,
        );
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(filled, null, 2)}\n`);
      const relative = path.relative(ctx.workspacePath, target);
      ctx.logger.info(
        `Filled ${
          Object.keys(values).length
        } placeholders in ${relative}; none left open`,
      );
      ctx.output('architecturePath', relative);
      ctx.output('filledCount', Object.keys(values).length);
    },
  });
}
