import type { PatternDecision } from '@internal/backstage-plugin-calm-common';
import {
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
