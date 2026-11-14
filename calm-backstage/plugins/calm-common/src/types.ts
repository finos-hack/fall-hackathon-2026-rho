/** One choice of a pattern decision (a `core.json#/defs/decision` object). */
export interface PatternChoice {
  /** The string `calm generate --option-choices` matches on (exact, case-sensitive). */
  description: string;
  nodes: string[];
  relationships: string[];
}

/**
 * A decision in a pattern: a relationship whose `relationship-type.properties.options.prefixItems[]` holds a `oneOf`
 * or `anyOf` list of choices.
 */
export interface PatternDecision {
  /** The relationship's `unique-id`; the key in the `--option-choices` JSON. */
  relationshipId: string;
  kind: 'oneOf' | 'anyOf';
  /** The relationship's `description`, used by the CLI as the prompt. */
  prompt?: string;
  choices: PatternChoice[];
}

/** The `--option-choices` JSON: relationship id to one description (`oneOf`) or a list of descriptions (`anyOf`). */
export type OptionChoices = Record<string, string | string[]>;

/** Parameter to decision map stored on a Template (see `CALM_ANNOTATIONS.decisions`). */
export interface TemplateDecisionParameter {
  parameter: string;
  relationshipId: string;
  kind: 'oneOf' | 'anyOf';
}
