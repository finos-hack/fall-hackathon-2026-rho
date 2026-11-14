/**
 * The calm backend module for the scaffolder plugin: `calm:generate`, `calm:fill`, `calm:validate`, `calm:template`
 * (run by the published `@finos/calm-cli`), `calm:publish:local` and `calm:register:local`.
 *
 * @packageDocumentation
 */

export { scaffolderModuleCalm as default } from './module';
export { createCalmGenerateAction } from './actions/generate';
export { createCalmFillAction } from './actions/fill';
export { createCalmValidateAction } from './actions/validate';
export {
  createCalmTemplateAction,
  type BundleLocation,
} from './actions/template';
export {
  createCalmPublishLocalAction,
  serviceEntity,
} from './actions/publishLocal';
export { createCalmRegisterLocalAction } from './actions/registerLocal';
export {
  calmBin,
  runCalm,
  CalmCliError,
} from '@internal/backstage-plugin-calm-node';
