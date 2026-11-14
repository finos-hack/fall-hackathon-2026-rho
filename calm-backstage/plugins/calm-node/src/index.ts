/**
 * Node helpers shared by the CALM backend plugins: resolve and run the published `@finos/calm-cli` (generate,
 * validate, template), and push and pull template bundles as OCI artifacts.
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
export {
  BUNDLE_ARTIFACT_TYPE,
  BUNDLE_CONFIG_FILE,
  BUNDLE_CONFIG_MEDIA_TYPE,
  BUNDLE_LAYER_TITLE,
  OCI_LAYER_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  OciError,
  bundleRef,
  extractBundle,
  listRepositories,
  listTags,
  packBundle,
  parseRef,
  pullBundle,
  pullBundleCached,
  pushBundle,
  readBundleConfig,
  resolveBundleDigest,
  sha256Digest,
  type OciDescriptor,
  type OciManifest,
  type OciRef,
} from './oci';
