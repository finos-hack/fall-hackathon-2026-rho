import { convertC4 } from '@internal/calm-import';
import { createImportAction, type ImportActionOptions } from './importUpload';

/** `calm:import:c4`: converts an uploaded C4 model (Mermaid C4 or C4-PlantUML) into a CALM architecture in the workspace. */
export function createCalmImportC4Action(options: ImportActionOptions) {
  return createImportAction('c4', 'calm:import:c4', convertC4, options);
}
