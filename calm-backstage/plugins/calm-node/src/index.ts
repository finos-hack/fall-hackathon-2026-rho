/**
 * Node helpers shared by the CALM backend plugins: resolve and run the published `@finos/calm-cli` (generate,
 * validate, template), push and pull template bundles as OCI artifacts, and run `kubectl` and `minikube` against the
 * one cluster in `calm.deploy.kubernetes`.
 *
 * @packageDocumentation
 */

export { calmBin, runCalm, CalmCliError } from './cli';
export { ProcessError, runProcess, type RunProcessOptions } from './process';
export {
  DEFAULT_NAMESPACE_PREFIX,
  kubectlArgs,
  kubectlCommand,
  minikubeArgs,
  readKubernetesDeploySettings,
  requireKubernetesDeploy,
  runKubectl,
  runMinikube,
  type KubernetesDeploySettings,
  type KubernetesRunOptions,
} from './kubernetes';
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
  DEFAULT_REPOSITORY_PREFIX,
  readBundleRegistrySettings,
  readPublishLocalDir,
  type BundleRegistrySettings,
} from './settings';
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
  readBundleManifest,
  resolveBundleDigest,
  sha256Digest,
  type OciDescriptor,
  type OciManifest,
  type OciRef,
} from './oci';
export {
  GIT_AUTHOR,
  git,
  gitCheckoutBranch,
  gitClone,
  gitCommitAll,
  gitCurrentBranch,
  gitDeleteBranch,
  gitDiffStat,
  gitHead,
  gitInit,
  gitPull,
  gitPush,
  gitReset,
  type GitAuth,
  type GitOptions,
} from './git';
export {
  readGitopsSettings,
  serviceRepository,
  type GitopsSettings,
} from './gitops';
