import { readFileSync } from 'fs';
import { resolve } from 'path';
import { readPatternDecisions, toOptionChoices } from './options';

// `__fixtures__/cli-options-pattern.json` is an unmodified copy of
// `shared/test_fixtures/command/validate/options/pattern.json` from https://github.com/finos/architecture-as-code
// (local checkout at commit c7ce7fe1a, 2026-11-02).
const cliFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '__fixtures__/cli-options-pattern.json'),
    'utf-8',
  ),
);
const seedPattern = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../seed/patterns/web-service.pattern.json'),
    'utf-8',
  ),
);

describe('readPatternDecisions', () => {
  it('reads the CLI fixture as the CLI would offer it', () => {
    expect(readPatternDecisions(cliFixture)).toEqual([
      {
        relationshipId: 'options',
        kind: 'oneOf',
        prompt: 'Which databases does your application connect to?',
        choices: [
          { description: 'No Nodes', nodes: [], relationships: [] },
          {
            description: 'Both Nodes',
            nodes: ['node-1', 'node-2'],
            relationships: [],
          },
        ],
      },
    ]);
  });

  it('reads the seed pattern: one oneOf and one anyOf decision', () => {
    expect(readPatternDecisions(seedPattern)).toEqual([
      {
        relationshipId: 'datastore-choice',
        kind: 'oneOf',
        prompt: 'Which data store does the service use?',
        choices: [
          {
            description: 'PostgreSQL',
            nodes: ['postgres-database'],
            relationships: ['web-service-postgres'],
          },
          {
            description: 'MongoDB',
            nodes: ['mongodb-database'],
            relationships: ['web-service-mongodb'],
          },
        ],
      },
      {
        relationshipId: 'add-ons',
        kind: 'anyOf',
        prompt: 'Which add-ons does the service need?',
        choices: [
          {
            description: 'Cache (Redis)',
            nodes: ['cache'],
            relationships: ['web-service-cache'],
          },
          {
            description: 'Message queue (RabbitMQ)',
            nodes: ['message-queue'],
            relationships: ['web-service-message-queue'],
          },
          {
            description: 'Observability (OpenTelemetry)',
            nodes: ['observability'],
            relationships: ['web-service-observability'],
          },
        ],
      },
    ]);
  });

  it('reads relationships under allOf, puts oneOf before anyOf, and keeps the first of a repeated id', () => {
    const decision = (description: string) => ({
      properties: {
        description: { const: description },
        nodes: { const: [] },
        relationships: { const: [] },
      },
    });
    const pattern = {
      allOf: [
        { $ref: 'https://calm.finos.org/release/1.3/meta/calm.json' },
        {
          properties: {
            relationships: {
              prefixItems: [
                { properties: { 'unique-id': { const: 'plain' } } },
                {
                  properties: {
                    'unique-id': { const: 'both' },
                    'relationship-type': {
                      properties: {
                        options: {
                          prefixItems: [
                            { anyOf: [decision('a1'), decision('a2')] },
                            { oneOf: [decision('o1'), decision('o2')] },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    };
    const decisions = readPatternDecisions(pattern);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe('oneOf');
    expect(decisions[0].choices.map(c => c.description)).toEqual(['o1', 'o2']);
  });

  it('returns no decisions for a pattern without options', () => {
    expect(readPatternDecisions({ properties: {} })).toEqual([]);
    expect(readPatternDecisions(undefined)).toEqual([]);
  });
});

describe('toOptionChoices', () => {
  const decisions = readPatternDecisions(seedPattern);

  it('builds the --option-choices JSON from the descriptions read', () => {
    expect(
      toOptionChoices(decisions, {
        'datastore-choice': 'PostgreSQL',
        'add-ons': ['Cache (Redis)', 'Message queue (RabbitMQ)'],
      }),
    ).toEqual({
      'datastore-choice': 'PostgreSQL',
      'add-ons': ['Cache (Redis)', 'Message queue (RabbitMQ)'],
    });
    expect(
      toOptionChoices(decisions, {
        'datastore-choice': 'MongoDB',
        'add-ons': [],
      }),
    ).toEqual({ 'datastore-choice': 'MongoDB' });
  });

  it('rejects what the CLI rejects', () => {
    expect(() => toOptionChoices(decisions, { 'add-ons': [] })).toThrow(
      'The option [datastore-choice] is a oneOf option and needs exactly one choice.',
    );
    expect(() =>
      toOptionChoices(decisions, { 'datastore-choice': ['PostgreSQL'] }),
    ).toThrow('only accepts a single choice');
    expect(() =>
      toOptionChoices(decisions, { 'datastore-choice': 'postgresql' }),
    ).toThrow('The choice of [postgresql] is not a valid choice');
    expect(() =>
      toOptionChoices(decisions, { 'datastore-choice': 'MongoDB', cache: 'x' }),
    ).toThrow('The option id [cache] is not a valid option');
  });
});
