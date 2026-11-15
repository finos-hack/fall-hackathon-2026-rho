/** Annotation names the CALM plugins put on, and read from, catalog entities. */
export const CALM_ANNOTATIONS = {
  /** CALM Hub namespace of the document, e.g. `hackathon`. */
  namespace: 'calm.finos.org/namespace',
  /** Pattern id (the name in the pattern's `$id`), e.g. `web-service`. */
  pattern: 'calm.finos.org/pattern',
  patternVersion: 'calm.finos.org/pattern-version',
  /** Architecture id (the name in the architecture's `$id`), e.g. `orders-service`. */
  architecture: 'calm.finos.org/architecture',
  architectureVersion: 'calm.finos.org/architecture-version',
  /** Hub namespace of the architecture, when it is not the pattern's (`namespace`). */
  architectureNamespace: 'calm.finos.org/architecture-namespace',
  /** Control requirement URL. */
  control: 'calm.finos.org/control',
  /** Template bundle name, e.g. `web-service`. */
  bundle: 'calm.finos.org/bundle',
  bundleVersion: 'calm.finos.org/bundle-version',
  /** On a bundle Resource: starter, deployment or full. */
  bundleKind: 'calm.finos.org/bundle-kind',
  /** On a starter bundle Resource: what it runs on. */
  bundleRuntime: 'calm.finos.org/bundle-runtime',
  /** OCI reference of a bundle in the bundle registry, e.g. `localhost:5050/calm-bundles/web-service:2.0.0`. */
  bundleRef: 'calm.finos.org/bundle-ref',
  /** Digest of the bundle's OCI manifest (`sha256:…`): the exact content behind `bundle-ref` at the time. */
  bundleDigest: 'calm.finos.org/bundle-digest',
  /** On a service created from a pattern: its architecture file, relative to `catalog-info.yaml`. */
  architectureFile: 'calm.finos.org/architecture-file',
  /** Base URL of the CALM Hub the entity was read from. */
  hubUrl: 'calm.finos.org/hub-url',
  /**
   * On a Template: JSON array of `{ parameter, relationshipId, kind }`, mapping each form parameter to the pattern
   * decision it answers, so a later step can rebuild the `--option-choices` JSON.
   */
  decisions: 'calm.finos.org/decisions',
  /** On a service made from a starter: the deployment-rules bundle that rendered its `deploy/k8s`. */
  deployBundle: 'calm.finos.org/deploy-bundle',
  deployBundleVersion: 'calm.finos.org/deploy-bundle-version',
  /** Web URL of the service's Git repository (output/<name> is its working copy). */
  gitRepo: 'calm.finos.org/git-repo',
  /** `<namespace>/<name>` of the Flux Kustomization that deploys the service from Git. */
  gitops: 'calm.finos.org/gitops',
} as const;

/** Tag on a service that lives in Git and is deployed by Flux (the upgrade Template lists only these). */
export const CALM_GITOPS_TAG = 'calm-gitops';

/** Entity `spec.type` values the CALM catalog provider emits. */
export const CALM_ENTITY_TYPES = {
  architecture: 'calm-architecture',
  pattern: 'calm-pattern',
  control: 'calm-control',
  bundle: 'calm-template-bundle',
} as const;
