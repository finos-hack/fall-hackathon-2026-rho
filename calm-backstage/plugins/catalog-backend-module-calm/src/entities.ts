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
  serviceEntityOf,
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

/**
 * A template bundle and its calm-backstage.json: from the OCI bundle registry (`ref` and `digest`) or from a local
 * folder in `calm.bundles` (`path`).
 */
export interface BundleInfo {
  name: string;
  version: string;
  /** Absolute path of a local bundle folder. */
  path?: string;
  /** OCI reference of a registry bundle, e.g. `localhost:5050/calm-bundles/web-service:2.0.0`. */
  ref?: string;
  /** Digest of the registry bundle's manifest (`sha256:…`). */
  digest?: string;
  description?: string;
  /** Where the rendered service can be deployed (`deploy` in calm-backstage.json): `kubernetes`, or nothing. */
  deploy?: string;
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

/** The control Resources a document depends on, limited to the controls the snapshot emits (a skipped one is left out). */
function controlRefs(doc: unknown, emitted: Set<string>): string[] {
  return unique(
    requirementUrls(doc)
      .map(parseRequirementUrl)
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map(r => controlEntityName(r.domain, r.control))
      .filter(name => emitted.has(name))
      .map(resourceRef),
  );
}

function patternEntity(
  p: HubDocument,
  hubUrl: string,
  emittedControls: Set<string>,
): Entity {
  const deps = controlRefs(p.doc, emittedControls);
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
      description: `${
        b.description ?? `CALM template bundle ${b.name} ${b.version}`
      }${b.ref ? `\n\nStored in the OCI bundle registry as ${b.ref}.` : ''}`,
      annotations: {
        [ANN.bundle]: b.name,
        [ANN.bundleVersion]: b.version,
        ...(b.ref ? { [ANN.bundleRef]: b.ref } : {}),
        ...(b.digest ? { [ANN.bundleDigest]: b.digest } : {}),
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

/** The `deploy` value of a bundle whose rendered service the Template can build and deploy to Kubernetes. */
export const DEPLOY_KUBERNETES = 'kubernetes';

/**
 * The parameter name for a decision: its relationship id under a `choice-` prefix. The Template's own parameters
 * (`name`, `bundle`, `deploy`, `placeholders`) never start with `choice-`, and distinct relationship ids give distinct
 * names, so no decision can overwrite a fixed field or another decision.
 */
export function decisionParameter(d: PatternDecision): string {
  return `choice-${d.relationshipId}`;
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

/**
 * The output text about the deployment. The build and deploy steps are skipped for a bundle that renders nothing to
 * deploy and when the box is not ticked; a skipped step has no output, so each line is one expression that tests it.
 */
const DEPLOYED_TEXT = {
  title: 'Local Kubernetes cluster',
  content: [
    '${{ ("Deployed to the namespace `" + steps.deploy.output.namespace + "` as the image `" + steps.build.output.image + "`: " + (steps.deploy.output.deployments | length) + " deployments (" + (steps.deploy.output.deployments | join(", ")) + ") and " + (steps.deploy.output.networkPolicies | length) + " network policies.") if steps.deploy.output.namespace else "Not deployed: the build and deploy steps run only when the box is ticked and the bundle renders Kubernetes manifests." }}',
    '',
    '${{ ("Pods: `" + steps.deploy.output.kubectl + " get pods`") if steps.deploy.output.namespace else "" }}',
    '',
    '${{ ("Reach a service (" + (steps.deploy.output.services | join(", ")) + "): `" + steps.deploy.output.kubectl + " port-forward svc/<service> 8080:<port>`") if steps.deploy.output.namespace else "" }}',
  ].join('\n'),
};

/**
 * The output text about CALM Hub: the architecture version and, in a Template that can deploy, the deployment
 * decorator when one was posted.
 */
const hubText = (canDeploy: boolean) => ({
  title: 'CALM Hub',
  content: [
    'Architecture: `${{ steps["register-hub"].output.namespace }}/${{ steps["register-hub"].output.architecture }}` version ${{ steps["register-hub"].output.version }}, at ${{ steps["register-hub"].output.url }} (the `$id` of the published `architecture.json`).',
    ...(canDeploy
      ? [
          '',
          '${{ ("Deployment recorded as the decorator " + steps.decorate.output.id + " (`" + steps.decorate.output.uniqueId + "`): " + steps.decorate.output.url) if steps.decorate.output.id else "No deployment recorded: nothing was deployed." }}',
        ]
      : []),
  ].join('\n'),
});

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
  decisions.forEach((d, i) => {
    choiceProperties[map[i].parameter] = decisionProperty(d);
  });
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
  // The bundles that render Kubernetes manifests, as the `bundle` parameter names them. Whether the chosen bundle
  // is one of them is only known at run time, so the steps that need it test this list.
  const deployable = fitting
    .filter(b => b.deploy === DEPLOY_KUBERNETES)
    .map(b => `${b.name}@${b.version}`);
  const isDeployable = `(parameters.bundle in ${JSON.stringify(deployable)})`;
  if (deployable.length) {
    choiceProperties.deploy = {
      title: 'Deploy to the local Kubernetes cluster',
      description: `Builds the service's image and deploys it with its network policies (cluster from \`yarn k8s:up\`). Only for ${deployable.join(
        ', ',
      )}; other bundles render nothing to deploy.`,
      type: 'boolean',
      default: true,
    };
  }
  const required = [
    ...map.filter(m => m.kind === 'oneOf').map(m => m.parameter),
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
                'Name of the new service: it must start with a lower-case letter, followed by lower-case letters, digits and single hyphens (for example billing-api). It names the output folder, the catalog Component, the architecture in CALM Hub and the Kubernetes namespace.',
              // A letter first: CALM Hub refuses other architecture names. Still a DNS label for the namespace.
              pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
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
        // First, so a run that will deploy stops before it stores anything in CALM Hub or publishes files.
        ...(deployable.length
          ? [
              {
                id: 'check-cluster',
                name: 'Check the local Kubernetes cluster answers',
                action: 'calm:cluster:check',
                if: `\${{ parameters.deploy and ${isDeployable} }}`,
                input: { name: '${{ parameters.name }}' },
              },
            ]
          : []),
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
        ...(bundleValues.length
          ? publishSteps(p, deployable.length ? isDeployable : undefined)
          : []),
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
              ...(deployable.length ? [DEPLOYED_TEXT] : []),
              hubText(deployable.length > 0),
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

/**
 * Store the architecture in CALM Hub (which gives it its `$id`), render with the chosen bundle (pulled from the
 * bundle registry, or a local folder), publish to the local output folder, then, for a bundle that renders
 * Kubernetes manifests (`isDeployable`, an expression over the parameters) and with the `deploy` box ticked, build
 * the image, deploy it and record the deployment in the Hub; last, register the new service.
 */
function publishSteps(p: HubDocument, isDeployable?: string): object[] {
  return [
    {
      // Before the render, so the rendered files and the published architecture.json carry the $id.
      id: 'register-hub',
      name: 'Store the architecture in CALM Hub',
      action: 'calm:register:hub',
      input: {
        architecturePath: '${{ steps.fill.output.architecturePath }}',
        name: '${{ parameters.name }}',
      },
    },
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
        // Set when calm:template pulled the bundle from the registry; empty for a local folder.
        bundleRef: '${{ steps.template.output.bundleRef }}',
        bundleDigest: '${{ steps.template.output.bundleDigest }}',
        // The Hub annotations, next to architecture-file: the card reads the Hub and falls back to the file.
        hubNamespace: '${{ steps["register-hub"].output.namespace }}',
        hubArchitecture: '${{ steps["register-hub"].output.architecture }}',
        hubArchitectureVersion: '${{ steps["register-hub"].output.version }}',
        hubArchitectureUrl: '${{ steps["register-hub"].output.url }}',
        // Adds the Kubernetes annotations to catalog-info.yaml, whether or not the service is then deployed.
        ...(isDeployable ? { deployable: `\${{ ${isDeployable} }}` } : {}),
      },
    },
    ...(isDeployable
      ? [
          {
            id: 'build',
            name: 'Build the image in the local cluster (minikube image build)',
            if: `\${{ parameters.deploy and ${isDeployable} }}`,
            action: 'calm:image:build',
            input: {
              dir: '${{ steps.publish.output.path }}',
              name: '${{ parameters.name }}',
              // Unique per run, so a rerun rolls out the new image.
              tag: '${{ context.task.id }}',
            },
          },
          {
            id: 'deploy',
            name: 'Deploy to the local Kubernetes cluster (kubectl apply)',
            if: `\${{ parameters.deploy and ${isDeployable} }}`,
            action: 'calm:deploy:k8s',
            input: {
              dir: '${{ steps.publish.output.path }}',
              name: '${{ parameters.name }}',
              image: '${{ steps.build.output.image }}',
            },
          },
          {
            id: 'decorate',
            name: 'Record the deployment in CALM Hub (deployment decorator)',
            if: `\${{ parameters.deploy and ${isDeployable} }}`,
            action: 'calm:decorate:deployment',
            input: {
              hubNamespace: '${{ steps["register-hub"].output.namespace }}',
              architecture: '${{ steps["register-hub"].output.architecture }}',
              version: '${{ steps["register-hub"].output.version }}',
              name: '${{ parameters.name }}',
              cluster: '${{ steps.deploy.output.cluster }}',
              namespace: '${{ steps.deploy.output.namespace }}',
              workloads: '${{ steps.deploy.output.deployments }}',
              architecturePath: '${{ steps.fill.output.architecturePath }}',
              startTime: '${{ steps.deploy.output.startTime }}',
              endTime: '${{ steps.deploy.output.endTime }}',
              status: 'completed',
            },
          },
        ]
      : []),
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

/**
 * All entities for one snapshot. Later duplicates of an entity name are dropped and reported. A Hub architecture
 * that `calm:register:hub` stored for a service (its metadata names the service's entity) gets no Component here:
 * the service's own `catalog-info.yaml` is its one entity, and it points at the Hub architecture.
 */
export function buildEntities(s: CalmSnapshot): {
  entities: Entity[];
  warnings: string[];
  /** Hub architectures left out because they belong to a published service. */
  serviceArchitectures: string[];
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

  const emittedControls = new Set(
    s.controls.map(c => controlEntityName(c.domain, c.control)),
  );
  for (const p of s.patterns) {
    add(patternEntity(p, s.hubUrl, emittedControls));
    add(templateEntity(p, s.bundles, s.hubUrl));
  }
  const serviceArchitectures: string[] = [];
  for (const a of s.architectures) {
    if (serviceEntityOf(a.doc)) {
      serviceArchitectures.push(`${a.namespace}/${a.id}`);
      continue;
    }
    add(architectureEntity(a, s.hubUrl));
  }
  for (const c of s.controls) {
    add(controlEntity(c, s.hubUrl));
  }
  for (const b of s.bundles) {
    add(bundleEntity(b, s.hubUrl));
  }
  return { entities: [...out.values()], warnings, serviceArchitectures };
}

export interface RequirementRef {
  url: string;
  domain: string;
  control: string;
  version: string;
}

/**
 * The control requirements a set of documents references: every distinct domain, control and version, so a version
 * the Hub no longer holds can fall back to another referenced one (see `readControls`).
 */
export function referencedRequirements(docs: unknown[]): RequirementRef[] {
  const byKey = new Map<string, RequirementRef>();
  for (const url of unique(docs.flatMap(d => requirementUrls(d)))) {
    const r = parseRequirementUrl(url);
    if (!r) {
      continue;
    }
    const key = `${r.domain}/${r.control}@${r.version}`;
    if (!byKey.has(key)) {
      byKey.set(key, { url, ...r });
    }
  }
  return [...byKey.values()];
}
