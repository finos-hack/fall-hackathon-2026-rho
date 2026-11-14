import type { PatternDecision } from '@internal/backstage-plugin-calm-common';
import { decisionParameter } from './entities';

const decision = (relationshipId: string): PatternDecision => ({
  relationshipId,
  kind: 'oneOf',
  choices: [],
});

describe('decisionParameter', () => {
  it('uses the relationship id', () => {
    expect(decisionParameter(decision('datastore-choice'))).toBe(
      'datastore-choice',
    );
  });

  it.each(['name', 'bundle', 'placeholders'])(
    'prefixes %s, which the Template uses for its own field',
    id => {
      expect(decisionParameter(decision(id))).toBe(`choice-${id}`);
    },
  );
});
