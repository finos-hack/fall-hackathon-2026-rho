/**
 * Node helpers shared by the CALM backend plugins: resolve and run the published `@finos/calm-cli` (generate,
 * validate, template).
 *
 * @packageDocumentation
 */

export { calmBin, runCalm, CalmCliError } from './cli';
export {
  CHOICES_FILE,
  generateArchitecture,
  normaliseChoices,
  type GenerateArchitectureOptions,
  type GenerateArchitectureResult,
} from './generate';
export {
  validateArchitecture,
  type ValidateArchitectureOptions,
  type ValidateArchitectureResult,
  type ValidationMessage,
} from './validate';
export {
  checkTemplateOutputDir,
  renderBundle,
  type RenderBundleOptions,
} from './template';
export { listFiles } from './files';
