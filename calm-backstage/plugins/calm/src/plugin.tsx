import {
  createFrontendPlugin,
  createRouteRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import ExploreIcon from '@material-ui/icons/LayersOutlined';
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

/** A Hub architecture, or a service published from a pattern: both name their architecture in CALM Hub. */
export const hasCalmArchitecture = (entity: Entity) => {
  const a = entity.metadata.annotations ?? {};
  return Boolean(
    a[ANN.architecture] || entity.spec?.type === TYPES.architecture,
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

export const templateExplorerRouteRef = createRouteRef();

/** The Template Explorer page (and its sidebar item): bundles, their files, their Git source and who uses them. */
export const templateExplorerPage = PageBlueprint.make({
  params: {
    path: '/calm-templates',
    routeRef: templateExplorerRouteRef,
    title: 'Template Explorer',
    icon: <ExploreIcon />,
    noHeader: true,
    loader: () =>
      import('./components/TemplateExplorerPage').then(m => (
        <m.TemplateExplorerPage />
      )),
  },
});

export const calmPlugin = createFrontendPlugin({
  pluginId: 'calm',
  title: 'Template Explorer',
  icon: <ExploreIcon />,
  routes: { templateExplorer: templateExplorerRouteRef },
  extensions: [
    templateExplorerPage,
    calmPlaceholdersFormField,
    calmArchitectureCard,
    calmPatternCard,
  ],
});
