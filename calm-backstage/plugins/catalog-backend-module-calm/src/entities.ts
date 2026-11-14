/*
 * Pure mapping from what the provider read (Hub documents, bundle metadata) to catalog entities.
 */
import type { Entity } from '@backstage/catalog-model';
import {
  CALM_ANNOTATIONS as ANN,
  CALM_ENTITY_TYPES as TYPES,
  PatternDecision,
  TemplateDecisionParameter,
  bundleEntityName,
  compareVersions,
  controlEntityName,
  entityName,
  parsePatternUrl,
  parseRequirementUrl,
  patternEntityName,
  readPatternDecisions,
  requirementUrls,
  templateEntityName,
} from '@internal/backstage-plugin-calm-common';

export const OWNER = 'group:default/guests';

export interface HubDocument {
  namespace: string;
  id: string;
  version: string;
  doc: any;
}

export interface ControlDocument {
  url: string;
  domain: string;
  control: string;
  version: string;
  doc: any;
}

/** A bundle from config plus its calm-backstage.json. */
export interface BundleInfo {
  name: string;
  version: string;
  path: string;
  description?: string;
  pattern?: {
    namespace?: string;
    patternId?: string;
    version?: string;
    url?: string;
  };
}

export interface CalmSnapshot {
  hubUrl: string;
  patterns: HubDocument[];
  architectures: HubDocument[];
  controls: ControlDocument[];
  bundles: BundleInfo[];
}

const resourceRef = (name: string) => `resource:default/${name}`;
const unique = <T>(xs: T[]) => [...new Set(xs)];

function controlRefs(doc: unknown): string[] {
  return unique(
    requirementUrls(doc)
      .map(parseRequirementUrl)
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map(r => resourceRef(controlEntityName(r.domain, r.control))),
  );
}

function patternEntity(p: HubDocument, hubUrl: string): Entity {
  const deps = controlRefs(p.doc);
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: {
      name: patternEntityName(p.id),
      title: p.doc?.title ?? p.id,
      description: p.doc?.description ?? `CALM pattern ${p.namespace}/${p.id}`,
      annotations: {
        [ANN.namespace]: p.namespace,
        [ANN.pattern]: p.id,
        [ANN.patternVersion]: p.version,
        [ANN.hubUrl]: hubUrl,
      },
      tags: ['calm', 'calm-pattern'],
      links: p.doc?.$id
        ? [{ url: p.doc.$id, title: 'Pattern in CALM Hub (JSON)' }]
        : [],
    },
    spec: {
      type: TYPES.pattern,
      owner: OWNER,
      ...(deps.length ? { dependsOn: deps } : {}),
    },
  };
}

function architectureEntity(a: HubDocument, hubUrl: string): Entity {
  const pattern = parsePatternUrl(a.doc?.$schema);
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: entityName(a.id),
      title: a.doc?.title ?? a.id,
      description:
        a.doc?.description ?? `CALM architecture ${a.namespace}/${a.id}`,
      annotations: {
        [ANN.namespace]: a.namespace,
        [ANN.architecture]: a.id,
        [ANN.architectureVersion]: a.version,
        [ANN.hubUrl]: hubUrl,
        ...(pattern
          ? { [ANN.pattern]: pattern.id, [ANN.patternVersion]: pattern.version }
          : {}),
      },
      tags: ['calm', 'calm-architecture'],
      links: a.doc?.$id
        ? [{ url: a.doc.$id, title: 'Architecture in CALM Hub (JSON)' }]
        : [],
    },
    spec: {
      type: TYPES.architecture,
      lifecycle: 'experimental',
      owner: OWNER,
      ...(pattern
        ? { dependsOn: [resourceRef(patternEntityName(pattern.id))] }
        : {}),
    },
  };
}

function controlEntity(c: ControlDocument, hubUrl: string): Entity {
  const props = c.doc?.properties ?? {};
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: {
      name: controlEntityName(c.domain, c.control),
      title: c.doc?.title ?? props.name?.const ?? c.control,
      description:
        c.doc?.description ??
        props.description?.const ??
        `CALM control ${c.url}`,
      annotations: {
        [ANN.control]: c.url,
        [ANN.hubUrl]: hubUrl,
      },
      tags: ['calm', 'calm-control', entityName(c.domain).toLowerCase()],
      links: [{ url: c.url, title: 'Control requirement in CALM Hub (JSON)' }],
    },
    spec: {
      type: TYPES.control,
      owner: OWNER,
    },
  };
}

function bundleEntity(b: BundleInfo, hubUrl: string): Entity {
  const p = b.pattern;
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: {
      name: bundleEntityName(b.name, b.version),
      title: `${b.name} ${b.version}`,
      description:
        b.description ?? `CALM template bundle ${b.name} ${b.version}`,
      annotations: {
        [ANN.bundle]: b.name,
        [ANN.bundleVersion]: b.version,
        [ANN.hubUrl]: hubUrl,
        ...(p?.namespace ? { [ANN.namespace]: p.namespace } : {}),
        ...(p?.patternId ? { [ANN.pattern]: p.patternId } : {}),
        ...(p?.version ? { [ANN.patternVersion]: p.version } : {}),
      },
      tags: ['calm', 'calm-template-bundle'],
    },
    spec: {
      type: TYPES.bundle,
      owner: OWNER,
      ...(p?.patternId
        ? { dependsOn: [resourceRef(patternEntityName(p.patternId))] }
        : {}),
    },
  };
}

/** A bundle fits a pattern when its calm-backstage.json names the same namespace and pattern id. */
export function bundlesFor(
  pattern: HubDocument,
  bundles: BundleInfo[],
): BundleInfo[] {
  return bundles
    .filter(
      b =>
        b.pattern?.patternId === pattern.id &&
        (b.pattern?.namespace ?? pattern.namespace) === pattern.namespace,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}

/** The Template's own parameters (Service step `name`, Choices step `bundle`, Details step `placeholders`). */
const RESERVED_PARAMETERS = new Set(['name', 'bundle', 'placeholders']);

/** The parameter name for a decision: its relationship id, unless that clashes with a fixed field. */
export function decisionParameter(d: PatternDecision): string {
  return RESERVED_PARAMETERS.has(d.relationshipId)
    ? `choice-${d.relationshipId}`
    : d.relationshipId;
}

function decisionProperty(d: PatternDecision): object {
  const descriptions = d.choices.map(c => c.description);
  const title = d.prompt ?? d.relationshipId;
  if (d.kind === 'oneOf') {
    return { title, type: 'string', enum: descriptions, 'ui:widget': 'radio' };
  }
  return {
    title,
    description: 'Pick any.',
    type: 'array',
    items: { type: 'string', enum: descriptions },
    uniqueItems: true,
    'ui:widget': 'checkboxes',
  };
}

export function templateEntity(
  p: HubDocument,
  bundles: BundleInfo[],
  hubUrl: string,
): Entity {
  const decisions = readPatternDecisions(p.doc);
  const fitting = bundlesFor(p, bundles);
  const map: TemplateDecisionParameter[] = decisions.map(d => ({
    parameter: decisionParameter(d),
    relationshipId: d.relationshipId,
    kind: d.kind,
  }));

  const choiceProperties: Record<string, object> = {};
  for (const d of decisions) {
    choiceProperties[decisionParameter(d)] = decisionProperty(d);
  }
  const bundleValues = fitting.map(b => `${b.name}@${b.version}`);
  if (bundleValues.length) {
    choiceProperties.bundle = {
      title: 'Template bundle',
      description: 'Which bundle renders the code for the new service.',
      type: 'string',
      enum: bundleValues,
      default: bundleValues[bundleValues.length - 1],
      'ui:widget': 'radio',
    };
  }
  const required = [
    ...decisions.filter(d => d.kind === 'oneOf').map(decisionParameter),
    ...(bundleValues.length ? ['bundle'] : []),
  ];

  const title = p.doc?.title ?? p.id;
  const url = patternUrl(p, hubUrl);
  return {
    apiVersion: 'scaffolder.backstage.io/v1beta3',
    kind: 'Template',
    metadata: {
      name: templateEntityName(p.id),
      title: `${title} (CALM pattern)`,
      description: `Create a service from the CALM pattern ${p.namespace}/${
        p.id
      } ${p.version}. ${p.doc?.description ?? ''}`.trim(),
      annotations: {
        [ANN.namespace]: p.namespace,
        [ANN.pattern]: p.id,
        [ANN.patternVersion]: p.version,
        [ANN.hubUrl]: hubUrl,
        [ANN.decisions]: JSON.stringify(map),
      },
      tags: ['calm', 'calm-pattern'],
    },
    spec: {
      owner: OWNER,
      type: 'service',
      parameters: [
        {
          title: 'Service',
          required: ['name'],
          properties: {
            name: {
              title: 'Name',
              type: 'string',
              description:
                'Name of the new service: lower-case letters, digits and hyphens. It names the output folder and the catalog Component.',
              pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
              maxLength: 63,
              'ui:autofocus': true,
            },
          },
        },
        {
          title: 'Choices',
          ...(required.length ? { required } : {}),
          properties: choiceProperties,
        },
        {
          title: 'Details',
          required: ['placeholders'],
          properties: {
            placeholders: {
              title: 'Architecture details',
              description:
                'Values for the placeholders calm generate leaves in the architecture for these choices.',
              type: 'object',
              'ui:field': 'CalmPlaceholders',
              'ui:options': {
                patternUrl: url,
                decisions: map,
              },
            },
          },
        },
      ],
      steps: [
        {
          id: 'generate',
          name: 'Generate the architecture (calm generate)',
          action: 'calm:generate',
          input: {
            patternUrl: url,
            choices: choicesInput(map),
            outputPath: 'architecture.json',
          },
        },
        {
          id: 'fill',
          name: 'Fill the placeholders',
          action: 'calm:fill',
          input: {
            architecturePath: '${{ steps.generate.output.architecturePath }}',
            values: '${{ parameters.placeholders }}',
          },
        },
        {
          id: 'validate',
          name: 'Validate against the pattern (calm validate)',
          action: 'calm:validate',
          input: {
            architecturePath: '${{ steps.fill.output.architecturePath }}',
            patternUrl: url,
          },
        },
        ...(bundleValues.length ? publishSteps(p) : []),
      ],
      output: bundleValues.length
        ? {
            links: [
              {
                title: 'Open the new service in the catalog',
                icon: 'catalog',
                entityRef: '${{ steps.register.output.entityRef }}',
              },
            ],
            text: [
              {
                title: 'Published locally',
                content: [
                  'Folder: `${{ steps.publish.output.path }}`',
                  '',
                  'Rendered with `${{ parameters.bundle }}`: ${{ steps.template.output.files | join(", ") }}.',
                  '',
                  'Architecture: **${{ steps.generate.output.nodeCount }} nodes**, **${{ steps.generate.output.relationshipCount }} relationships**, ${{ steps.fill.output.filledCount }} placeholders filled. `calm validate`: ${{ steps.validate.output.errorCount }} errors, ${{ steps.validate.output.warningCount }} warnings.',
                ].join('\n'),
              },
            ],
          }
        : {
            text: [
              {
                title: 'Architecture',
                content:
                  'Generated `${{ steps.fill.output.architecturePath }}` from the pattern: **${{ steps.generate.output.nodeCount }} nodes**, **${{ steps.generate.output.relationshipCount }} relationships**, ${{ steps.fill.output.filledCount }} placeholders filled. `calm validate`: ${{ steps.validate.output.errorCount }} errors, ${{ steps.validate.output.warningCount }} warnings. No template bundle fits this pattern, so nothing was rendered.',
              },
            ],
          },
    },
  };
}

/** Render with the chosen bundle, publish to the local output folder and register the new service. */
function publishSteps(p: HubDocument): object[] {
  return [
    {
      id: 'template',
      name: 'Render with the template bundle (calm template)',
      action: 'calm:template',
      input: {
        architecturePath: '${{ steps.fill.output.architecturePath }}',
        bundle: '${{ parameters.bundle }}',
        outputDir: 'rendered',
      },
    },
    {
      id: 'publish',
      name: 'Publish to the local output folder',
      action: 'calm:publish:local',
      input: {
        name: '${{ parameters.name }}',
        sourceDir: '${{ steps.template.output.outputDir }}',
        architecturePath: '${{ steps.fill.output.architecturePath }}',
        namespace: p.namespace,
        patternId: p.id,
        patternVersion: p.version,
        bundle: '${{ parameters.bundle }}',
      },
    },
    {
      id: 'register',
      name: 'Register the new service in the catalog',
      action: 'calm:register:local',
      input: {
        catalogInfoPath: '${{ steps.publish.output.catalogInfoPath }}',
      },
    },
  ];
}

/** The pattern's `$id` (a Hub URL `calm generate -p` reads), or the name-based Hub URL built from its coordinates. */
function patternUrl(p: HubDocument, hubUrl: string): string {
  if (typeof p.doc?.$id === 'string' && p.doc.$id) {
    return p.doc.$id;
  }
  const enc = encodeURIComponent;
  return `${hubUrl.replace(/\/+$/, '')}/calm/namespaces/${enc(
    p.namespace,
  )}/patterns/${enc(p.id)}/versions/${enc(p.version)}`;
}

/**
 * The `calm:generate` `choices` input: one expression per decision, keyed by the decision (relationship) id and reading
 * the form parameter that answers it. A sole `${{ }}` expression keeps the value's type, so an `anyOf` stays a list.
 */
function choicesInput(
  map: TemplateDecisionParameter[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of map) {
    out[m.relationshipId] = `\${{ parameters[${JSON.stringify(
      m.parameter,
    )}] }}`;
  }
  return out;
}

/** All entities for one snapshot. Later duplicates of an entity name are dropped and reported. */
export function buildEntities(s: CalmSnapshot): {
  entities: Entity[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const out = new Map<string, Entity>();
  const add = (e: Entity) => {
    const key = `${e.kind}:${e.metadata.name}`.toLowerCase();
    if (out.has(key)) {
      warnings.push(`duplicate entity ${key} skipped`);
      return;
    }
    out.set(key, e);
  };

  for (const p of s.patterns) {
    add(patternEntity(p, s.hubUrl));
    add(templateEntity(p, s.bundles, s.hubUrl));
  }
  for (const a of s.architectures) {
    add(architectureEntity(a, s.hubUrl));
  }
  for (const c of s.controls) {
    add(controlEntity(c, s.hubUrl));
  }
  for (const b of s.bundles) {
    add(bundleEntity(b, s.hubUrl));
  }
  return { entities: [...out.values()], warnings };
}

/** The control requirement URLs a set of documents references, de-duplicated by domain and control. */
export function referencedRequirements(
  docs: unknown[],
): { url: string; domain: string; control: string; version: string }[] {
  const byKey = new Map<
    string,
    { url: string; domain: string; control: string; version: string }
  >();
  for (const url of unique(docs.flatMap(d => requirementUrls(d)))) {
    const r = parseRequirementUrl(url);
    if (!r) {
      continue;
    }
    const key = `${r.domain}/${r.control}`;
    const prev = byKey.get(key);
    if (!prev || compareVersions(r.version, prev.version) > 0) {
      byKey.set(key, { url, ...r });
    }
  }
  return [...byKey.values()];
}
