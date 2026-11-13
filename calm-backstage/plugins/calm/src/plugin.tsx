import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha';
import {
  CALM_ANNOTATIONS as ANN,
  CALM_ENTITY_TYPES as TYPES,
} from '@internal/backstage-plugin-calm-common';

/** Scaffolder form field `CalmPlaceholders`: asks calm-backend for the placeholders of the chosen pattern options. */
export const calmPlaceholdersFormField = FormFieldBlueprint.make({
  name: 'calm-placeholders',
  params: {
    field: () =>
      import('./components/CalmPlaceholdersField').then(
        m => m.CalmPlaceholdersFormField,
      ),
  },
});

/** A Hub architecture, or a service published from a pattern (with its architecture file). */
export const hasCalmArchitecture = (entity: Entity) => {
  const a = entity.metadata.annotations ?? {};
  return Boolean(
    a[ANN.architecture] ||
      a[ANN.architectureFile] ||
      entity.spec?.type === TYPES.architecture,
  );
};

export const isCalmPattern = (entity: Entity) =>
  entity.spec?.type === TYPES.pattern;

/** Entity overview card: pattern, controls, counts and the Mermaid diagram of the entity's CALM architecture. */
export const calmArchitectureCard = EntityCardBlueprint.make({
  name: 'calm-architecture',
  params: {
    type: 'content',
    filter: hasCalmArchitecture,
    loader: () =>
      import('./components/CalmArchitectureCard').then(m => (
        <m.CalmArchitectureCard />
      )),
  },
});

/** Entity overview card: the pattern's decisions and choices, the bundles that fit and a link to its Template. */
export const calmPatternCard = EntityCardBlueprint.make({
  name: 'calm-pattern',
  params: {
    type: 'content',
    filter: isCalmPattern,
    loader: () =>
      import('./components/CalmPatternCard').then(m => <m.CalmPatternCard />),
  },
});

export const calmPlugin = createFrontendPlugin({
  pluginId: 'calm',
  extensions: [
    calmPlaceholdersFormField,
    calmArchitectureCard,
    calmPatternCard,
  ],
});
