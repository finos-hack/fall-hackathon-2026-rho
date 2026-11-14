import type { PatternDecision } from '@internal/backstage-plugin-calm-common';
import {
  BundleInfo,
  HubDocument,
  buildEntities,
  decisionParameter,
  referencedRequirements,
  templateEntity,
} from './entities';

const hub = 'http://localhost:8090';
const requirementUrl = (control: string, version: string) =>
  `${hub}/calm/domains/sec/controls/${control}/requirement/versions/${version}`;

const decision = (relationshipId: string): PatternDecision => ({
  relationshipId,
  kind: 'oneOf',
  choices: [],
});

describe('decisionParameter', () => {
  it.each(['datastore-choice', 'name', 'bundle', 'placeholders'])(
    'prefixes %s, so it cannot clash with a fixed field',
    id => {
      expect(decisionParameter(decision(id))).toBe(`choice-${id}`);
    },
  );

  it('keeps distinct decisions distinct, even when one id is another prefixed', () => {
    expect(decisionParameter(decision('name'))).not.toBe(
      decisionParameter(decision('choice-name')),
    );
  });
});

/** A pattern with one oneOf decision per relationship id, shaped as readPatternDecisions reads it. */
function patternWithDecisions(...ids: string[]): HubDocument {
  return {
    namespace: 'hackathon',
    id: 'web-service',
    version: '1.0.0',
    doc: {
      properties: {
        relationships: {
          prefixItems: ids.map(id => ({
            properties: {
              'unique-id': { const: id },
              'relationship-type': {
                properties: {
                  options: {
                    prefixItems: [
                      {
                        oneOf: ['a', 'b'].map(c => ({
                          properties: { description: { const: `${id} ${c}` } },
                        })),
                      },
                    ],
                  },
                },
              },
            },
          })),
        },
      },
    },
  };
}

describe('templateEntity', () => {
  it('gives every decision its own form field, with no clash with the fixed ones', () => {
    const t = templateEntity(
      patternWithDecisions('name', 'choice-name', 'bundle'),
      [],
      hub,
    );
    const [service, choices, details] = (t.spec as any).parameters;

    expect(Object.keys(service.properties)).toEqual(['name']);
    expect(Object.keys(details.properties)).toEqual(['placeholders']);
    expect(Object.keys(choices.properties).sort()).toEqual([
      'choice-bundle',
      'choice-choice-name',
      'choice-name',
    ]);
    expect(choices.required.sort()).toEqual(
      Object.keys(choices.properties).sort(),
    );

    const map = JSON.parse(
      t.metadata.annotations!['calm.finos.org/decisions'] ?? '[]',
    );
    expect(new Set(map.map((m: any) => m.parameter)).size).toBe(3);
  });
});

describe('referencedRequirements', () => {
  it('keeps every referenced version of a control', () => {
    const refs = referencedRequirements([
      {
        controls: {
          tls: { 'requirement-url': requirementUrl('tls', '1.0.0') },
        },
      },
      {
        controls: {
          tls: { 'requirement-url': requirementUrl('tls', '1.1.0') },
        },
      },
    ]);
    expect(refs.map(r => r.version).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});

describe('buildEntities', () => {
  it('leaves a skipped control out of the pattern dependsOn', () => {
    const pattern: HubDocument = {
      namespace: 'hackathon',
      id: 'web-service',
      version: '1.0.0',
      doc: {
        controls: {
          kept: { 'requirement-url': requirementUrl('kept', '1.0.0') },
          gone: { 'requirement-url': requirementUrl('gone', '1.0.0') },
        },
      },
    };
    const { entities } = buildEntities({
      hubUrl: hub,
      patterns: [pattern],
      architectures: [],
      controls: [
        {
          url: requirementUrl('kept', '1.0.0'),
          domain: 'sec',
          control: 'kept',
          version: '1.0.0',
          doc: {},
        },
      ],
      bundles: [],
    });

    const resource = entities.find(
      e => e.kind === 'Resource' && e.spec?.type === 'calm-pattern',
    );
    const deps = resource?.spec?.dependsOn as string[];
    expect(deps).toHaveLength(1);
    expect(deps[0]).toContain('kept');
  });
});

const pattern = {
  namespace: 'hackathon',
  id: 'web-service',
  version: '1.0.0',
  doc: { title: 'Web Service' },
};
const fits = { namespace: 'hackathon', patternId: 'web-service' };
const bundle = (version: string, deploy?: string): BundleInfo => ({
  name: 'web-service',
  version,
  deploy,
  pattern: fits,
});
const hubUrl = 'http://localhost:8090';

function template(bundles: BundleInfo[]) {
  const spec = templateEntity(pattern, bundles, hubUrl).spec as any;
  const steps: any[] = spec.steps;
  return {
    spec,
    stepIds: steps.map(s => s.id),
    step: (id: string) => steps.find(s => s.id === id),
    choices: spec.parameters[1].properties,
  };
}

describe('templateEntity: build and deploy', () => {
  it('adds the deploy box and the build and deploy steps when a fitting bundle is deployable', () => {
    const t = template([
      bundle('2.0.0'),
      bundle('3.0.0', 'kubernetes'),
      bundle('3.1.0', 'kubernetes'),
    ]);
    expect(t.choices.deploy).toMatchObject({ type: 'boolean', default: true });
    expect(t.stepIds).toEqual([
      'generate',
      'fill',
      'validate',
      'template',
      'publish',
      'build',
      'deploy',
      'register',
    ]);
    // True only with the box ticked and one of the deployable bundles chosen.
    const condition =
      '${{ parameters.deploy and (parameters.bundle in ["web-service@3.0.0","web-service@3.1.0"]) }}';
    expect(t.step('build').if).toBe(condition);
    expect(t.step('deploy').if).toBe(condition);
    expect(t.step('publish').input.deployable).toBe(
      '${{ (parameters.bundle in ["web-service@3.0.0","web-service@3.1.0"]) }}',
    );
    expect(t.step('build').input).toEqual({
      dir: '${{ steps.publish.output.path }}',
      name: '${{ parameters.name }}',
      tag: '${{ context.task.id }}',
    });
    expect(t.step('deploy').input.image).toBe(
      '${{ steps.build.output.image }}',
    );
    expect(t.spec.output.text.map((x: any) => x.title)).toEqual([
      'Published locally',
      'Local Kubernetes cluster',
    ]);
  });

  it('leaves them out when no fitting bundle is deployable', () => {
    const t = template([bundle('1.0.0'), bundle('2.0.0', 'compose')]);
    expect(t.choices.deploy).toBeUndefined();
    expect(t.stepIds).toEqual([
      'generate',
      'fill',
      'validate',
      'template',
      'publish',
      'register',
    ]);
    expect(t.step('publish').input.deployable).toBeUndefined();
    expect(t.spec.output.text).toHaveLength(1);
  });
});
