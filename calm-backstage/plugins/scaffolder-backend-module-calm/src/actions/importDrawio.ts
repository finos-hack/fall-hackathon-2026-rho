import { convertDrawio } from '@internal/calm-import';
import {
  createImportAction,
  type ImportActionOptions,
  MAX_DIAGRAM_BYTES,
  parseDataUrl,
  uploadText,
} from './importUpload';

export { MAX_DIAGRAM_BYTES, parseDataUrl };

/** The diagram text of an upload; throws for an empty, too large or other kind of file. */
export function diagramText(dataUrl: string): string {
  return uploadText(dataUrl, 'drawio');
}

/** `calm:import:drawio`: converts an uploaded draw.io diagram into a CALM architecture in the workspace. */
export function createCalmImportDrawioAction(options: ImportActionOptions) {
  return createImportAction(
    'drawio',
    'calm:import:drawio',
    convertDrawio,
    options,
  );
}
