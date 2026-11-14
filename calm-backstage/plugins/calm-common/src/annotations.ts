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
  /** Control requirement URL. */
  control: 'calm.finos.org/control',
  /** Template bundle name, e.g. `web-service`. */
  bundle: 'calm.finos.org/bundle',
  bundleVersion: 'calm.finos.org/bundle-version',
  /** On a service created from a pattern: its architecture file, relative to `catalog-info.yaml`. */
  architectureFile: 'calm.finos.org/architecture-file',
  /** Base URL of the CALM Hub the entity was read from. */
  hubUrl: 'calm.finos.org/hub-url',
  /**
   * On a Template: JSON array of `{ parameter, relationshipId, kind }`, mapping each form parameter to the pattern
   * decision it answers, so a later step can rebuild the `--option-choices` JSON.
   */
  decisions: 'calm.finos.org/decisions',
} as const;

/** Entity `spec.type` values the CALM catalog provider emits. */
export const CALM_ENTITY_TYPES = {
  architecture: 'calm-architecture',
  pattern: 'calm-pattern',
  control: 'calm-control',
  bundle: 'calm-template-bundle',
} as const;
