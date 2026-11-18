import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type AuthService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  type CalmHubClient,
  IMPORT_FORMAT_LABELS,
  type ImportFormat,
} from '@internal/backstage-plugin-calm-common';
import { type ConvertResult, kindsIn } from '@internal/calm-import';
import { assertImportName, importNameClash } from './importName';

/** The largest diagram accepted, in decoded bytes. */
export const MAX_DIAGRAM_BYTES = 2 * 1024 * 1024;

export type UploadKind = ImportFormat;

const KINDS: Record<
  UploadKind,
  { name: string; files: string; extensions: string[] }
> = {
  drawio: {
    name: 'draw.io diagram',
    files: '.drawio, .xml or a draw.io .svg export',
    extensions: ['.drawio', '.xml', '.svg'],
  },
  c4: {
    name: 'C4 model',
    files: '.md, .mmd, .puml, .plantuml or .txt',
    extensions: ['.md', '.mmd', '.puml', '.plantuml', '.txt'],
  },
  mermaid: {
    name: 'Mermaid flowchart',
    files: '.md, .mmd or .txt',
    extensions: ['.md', '.mmd', '.txt'],
  },
};

const DRAWIO_MARKERS = ['<mxfile', '<mxGraphModel', '<svg'];

/** What the upload is not: `The file is not a draw.io diagram (.drawio, .xml or a draw.io .svg export)`. */
function notA(kind: UploadKind) {
  return `The file is not a ${KINDS[kind].name} (${KINDS[kind].files})`;
}

/**
 * The bytes and file name of a data-url from the form's file widget: `data:<mime>;name=<file>;base64,<data>`. The
 * `name=` part may be absent, the mime empty or generic; a data-url without `;base64` is percent-encoded text.
 */
export function parseDataUrl(
  dataUrl: string,
  kind: UploadKind = 'drawio',
): { bytes: Buffer; fileName?: string } {
  const match = /^data:([^,]*),(.*)$/s.exec(
    typeof dataUrl === 'string' ? dataUrl : '',
  );
  if (!match) {
    throw new Error(`${notA(kind)}: the upload is not a file`);
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
    throw new Error(`${notA(kind)}: the upload could not be decoded`);
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

/**
 * The format the text is clearly in when `kind` is found nowhere in it: PlantUML counts as C4. A Markdown file that
 * holds a diagram of the chosen kind anywhere (after a diagram of another kind, say) is accepted.
 */
function otherKind(text: string, kind: UploadKind): UploadKind | undefined {
  if (kind === 'drawio' && DRAWIO_MARKERS.some(m => text.includes(m))) {
    return undefined;
  }
  const found = kindsIn(text).map(k => (k === 'plantuml' ? 'c4' : k));
  return found.includes(kind) ? undefined : found[0];
}

/**
 * The diagram text of an upload; throws for an empty, too large or other kind of file, naming the format the text is
 * in when it is clearly another one.
 */
export function uploadText(dataUrl: string, kind: UploadKind): string {
  const { bytes, fileName } = parseDataUrl(dataUrl, kind);
  if (bytes.length === 0) {
    throw new Error(
      `The file is empty; upload a ${KINDS[kind].name} (${KINDS[kind].files})`,
    );
  }
  assertSize(bytes.length);
  const text = bytes.toString('utf-8');
  const other = otherKind(text, kind);
  if (other) {
    const label = IMPORT_FORMAT_LABELS[other];
    throw new Error(
      `The file does not match the chosen format "${IMPORT_FORMAT_LABELS[kind]}"; it looks like ${label}: choose "${label}" as the format`,
    );
  }
  if (
    fileName !== undefined &&
    !KINDS[kind].extensions.includes(path.extname(fileName).toLowerCase())
  ) {
    throw new Error(`${notA(kind)}, got ${JSON.stringify(fileName)}`);
  }
  if (kind === 'drawio' && !DRAWIO_MARKERS.some(m => text.includes(m))) {
    throw new Error(notA(kind));
  }
  return text;
}

/** What every import action needs: CALM Hub and the catalog, for the name check. */
export interface ImportActionOptions {
  hub: Pick<CalmHubClient, 'architectures'>;
  /** `calm.publish.hubNamespace`: the Hub namespace whose architecture names are taken. */
  namespace: string;
  catalog: Pick<CatalogService, 'getEntityByRef'>;
  auth: Pick<AuthService, 'getOwnServiceCredentials'>;
}

/**
 * An import action: converts an uploaded diagram of `kind` into a CALM architecture in the workspace, after checking
 * that the name is free in CALM Hub and the catalog. Every unsure decision of the converter keeps its guess; the
 * guesses are an output, and the converter's report is logged. A dry run does the same: it writes only the workspace.
 */
export function createImportAction(
  kind: UploadKind,
  id: string,
  convert: (text: string) => Promise<ConvertResult>,
  options: ImportActionOptions,
) {
  return createTemplateAction({
    id,
    description: `Converts an uploaded ${KINDS[kind].name} (${KINDS[kind].files}, at most 2 MB) into a CALM architecture in the workspace. Fails when the name is taken in CALM Hub (namespace calm.publish.hubNamespace) or the catalog. Unsure decisions keep the converter's guess; the guesses and what was left out or changed are outputs, and the report is logged.`,
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
        leftOut: z =>
          z
            .array(z.string())
            .describe(
              'One line per thing left out of the architecture (a legend, a note) or changed on the way',
            ),
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
      const text = uploadText(diagram, kind);
      const file = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const result = await convert(text);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        `${JSON.stringify(result.architecture, null, 2)}\n`,
      );
      result.report.split('\n').forEach(l => ctx.logger.info(l));

      ctx.output('nodes', result.nodes);
      ctx.output('relationships', result.relationships);
      ctx.output('guesses', result.guesses);
      ctx.output('leftOut', result.leftOut);
      ctx.output('architecturePath', path.relative(ctx.workspacePath, file));
    },
  });
}
