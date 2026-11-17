import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type AuthService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { CalmHubClient } from '@internal/backstage-plugin-calm-common';
import { convertDrawio } from '@internal/calm-import';
import { assertImportName, importNameClash } from './importName';

/** The largest diagram accepted, in decoded bytes. */
export const MAX_DIAGRAM_BYTES = 2 * 1024 * 1024;

const KINDS = '.drawio, .xml or a draw.io .svg export';
const NOT_DRAWIO = `The file is not a draw.io diagram (${KINDS})`;
const EXTENSIONS = ['.drawio', '.xml', '.svg'];
const MARKERS = ['<mxfile', '<mxGraphModel', '<svg'];

/**
 * The bytes and file name of a data-url from the form's file widget: `data:<mime>;name=<file>;base64,<data>`. The
 * `name=` part may be absent, the mime empty or generic; a data-url without `;base64` is percent-encoded text.
 */
export function parseDataUrl(dataUrl: string): {
  bytes: Buffer;
  fileName?: string;
} {
  const match = /^data:([^,]*),(.*)$/s.exec(
    typeof dataUrl === 'string' ? dataUrl : '',
  );
  if (!match) {
    throw new Error(`${NOT_DRAWIO}: the upload is not a file`);
  }
  const params = match[1].split(';');
  const base64 = params[params.length - 1] === 'base64';
  const nameParam = params.find(p => p.startsWith('name='))?.slice(5);
  let fileName = nameParam;
  try {
    fileName =
      nameParam !== undefined ? decodeURIComponent(nameParam) : undefined;
  } catch {
    // keep it as sent
  }
  if (base64) {
    // Refused from the length, before decoding: every 4 characters are 3 bytes, less the padding.
    const data = match[2];
    const padding = /={0,2}$/.exec(data)![0].length;
    assertSize(Math.floor((data.length * 3) / 4) - padding);
  }
  let bytes: Buffer;
  try {
    bytes = base64
      ? Buffer.from(match[2], 'base64')
      : Buffer.from(decodeURIComponent(match[2]), 'utf-8');
  } catch {
    throw new Error(`${NOT_DRAWIO}: the upload could not be decoded`);
  }
  return { bytes, fileName };
}

function assertSize(bytes: number) {
  if (bytes > MAX_DIAGRAM_BYTES) {
    throw new Error(
      `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 2 MB`,
    );
  }
}

/** The diagram text of an upload; throws for an empty, too large or other kind of file. */
export function diagramText(dataUrl: string): string {
  const { bytes, fileName } = parseDataUrl(dataUrl);
  if (bytes.length === 0) {
    throw new Error(`The file is empty; upload a draw.io diagram (${KINDS})`);
  }
  assertSize(bytes.length);
  if (
    fileName !== undefined &&
    !EXTENSIONS.includes(path.extname(fileName).toLowerCase())
  ) {
    throw new Error(`${NOT_DRAWIO}, got ${JSON.stringify(fileName)}`);
  }
  const text = bytes.toString('utf-8');
  if (!MARKERS.some(m => text.includes(m))) {
    throw new Error(NOT_DRAWIO);
  }
  return text;
}

/**
 * `calm:import:drawio`: converts an uploaded draw.io diagram into a CALM architecture in the workspace, after checking
 * that the name is free in CALM Hub and the catalog. Every unsure decision of the converter keeps its guess; the
 * guesses are an output, and the converter's report is logged. A dry run does the same: it writes only the workspace.
 */
export function createCalmImportDrawioAction(options: {
  hub: Pick<CalmHubClient, 'architectures'>;
  /** `calm.publish.hubNamespace`: the Hub namespace whose architecture names are taken. */
  namespace: string;
  catalog: Pick<CatalogService, 'getEntityByRef'>;
  auth: Pick<AuthService, 'getOwnServiceCredentials'>;
}) {
  return createTemplateAction({
    id: 'calm:import:drawio',
    description: `Converts an uploaded draw.io diagram (${KINDS}, at most 2 MB) into a CALM architecture in the workspace. Fails when the name is taken in CALM Hub (namespace calm.publish.hubNamespace) or the catalog. Unsure decisions keep the converter's guess; the guesses are an output and the report is logged.`,
    // Reads the Hub and the catalog, and writes only inside the workspace.
    supportsDryRun: true,
    schema: {
      input: {
        name: z =>
          z
            .string()
            .describe(
              'Name of the architecture: a lower-case letter first, then lower-case letters, digits and single hyphens, at most 63 characters',
            ),
        diagram: z =>
          z
            .string()
            .describe(
              'The diagram as a data-url (data:<mime>;name=<file>;base64,<data>), as the form file widget sends it',
            ),
        architecturePath: z =>
          z
            .string()
            .optional()
            .describe(
              'Where the architecture is written, relative to the workspace. Default architecture.json',
            ),
      },
      output: {
        nodes: z => z.number().describe('Nodes in the architecture'),
        relationships: z =>
          z.number().describe('Relationships in the architecture'),
        guesses: z =>
          z
            .array(z.string())
            .describe('One line per decision the converter guessed'),
        architecturePath: z =>
          z.string().describe('The architecture, relative to the workspace'),
      },
    },
    async handler(ctx) {
      const { name, diagram } = ctx.input;
      assertImportName(name);
      const clash = await importNameClash(name, options);
      if (clash) {
        throw new Error(clash);
      }
      const text = diagramText(diagram);
      const file = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const result = await convertDrawio(text);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        `${JSON.stringify(result.architecture, null, 2)}\n`,
      );
      result.report.split('\n').forEach(l => ctx.logger.info(l));

      ctx.output('nodes', result.nodes);
      ctx.output('relationships', result.relationships);
      ctx.output('guesses', result.guesses);
      ctx.output('architecturePath', path.relative(ctx.workspacePath, file));
    },
  });
}
