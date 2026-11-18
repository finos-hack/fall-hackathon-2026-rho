import { convertMermaid } from '@internal/calm-import';
import { createImportAction, type ImportActionOptions } from './importUpload';

/** `calm:import:mermaid`: converts an uploaded Mermaid flowchart into a CALM architecture in the workspace. */
export function createCalmImportMermaidAction(options: ImportActionOptions) {
  return createImportAction(
    'mermaid',
    'calm:import:mermaid',
    convertMermaid,
    options,
  );
}
