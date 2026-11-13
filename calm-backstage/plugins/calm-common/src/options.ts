/*
 * Reads the decisions (options) of a CALM pattern the way `calm generate` does.
 *
 * Mirrors `extractOptions` in `shared/src/commands/generate/components/options.ts` and `loadChoicesFromInput` in
 * `cli/src/command-helpers/generate-options.ts` of https://github.com/finos/architecture-as-code, read at commit
 * `c7ce7fe1a` (2026-11-02, `cli/package.json` 1.67.0). The same messages and logic were found in the bundled
 * `@finos/calm-cli` 1.70.0 (Homebrew). Not yet compared with 1.71.0, the version the repository will pin.
 *
 * What the CLI does, and this reader copies:
 * - Relationships come from `properties.relationships.prefixItems`, or from the first `allOf[]` member that has
 *   them. `items` (the add-on catalogue) is not read for decisions, and `$ref`s are not resolved.
 * - A relationship is a decision when `properties.relationship-type.properties.options` is present.
 * - Each `options.prefixItems[]` entry with `oneOf` gives a decision of kind `oneOf`, each with `anyOf` one of kind
 *   `anyOf`; per relationship all `oneOf` blocks come first, then all `anyOf` blocks.
 * - The decision id is the relationship's `properties.unique-id.const`, the prompt its `properties.description.const`.
 * - A choice is `{ description, nodes, relationships }` from `properties.{description,nodes,relationships}.const`.
 * - `--option-choices` keys on the decision id and matches each value against the choice `description` with `===`.
 *   A `oneOf` decision needs exactly one string and must be answered; an `anyOf` decision takes a string or a list
 *   and may be left out. When two blocks share an id, the CLI only ever matches the first.
 *
 * Differences: the CLI throws on a malformed decision; this reader skips it. Decisions that repeat an id are dropped
 * (only the first is reachable through `--option-choices`).
 */
import { OptionChoices, PatternChoice, PatternDecision } from './types';

type SchemaNode = { [key: string]: any };

const isObject = (v: unknown): v is SchemaNode =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function relationshipsPrefixItems(pattern: SchemaNode): SchemaNode[] {
  const direct = pattern?.properties?.relationships?.prefixItems;
  if (Array.isArray(direct)) {
    return direct;
  }
  if (Array.isArray(pattern?.allOf)) {
    for (const schema of pattern.allOf) {
      const items = schema?.properties?.relationships?.prefixItems;
      if (Array.isArray(items)) {
        return items;
      }
    }
  }
  return [];
}

function readChoice(choice: unknown): PatternChoice | undefined {
  if (!isObject(choice)) {
    return undefined;
  }
  const description = choice.properties?.description?.const;
  if (typeof description !== 'string') {
    return undefined;
  }
  const nodes = choice.properties?.nodes?.const;
  const relationships = choice.properties?.relationships?.const;
  return {
    description,
    nodes: Array.isArray(nodes) ? nodes : [],
    relationships: Array.isArray(relationships) ? relationships : [],
  };
}

function readBlocks(
  relationship: SchemaNode,
  kind: 'oneOf' | 'anyOf',
): PatternDecision[] {
  const relationshipId = relationship.properties?.['unique-id']?.const;
  const prefixItems =
    relationship.properties?.['relationship-type']?.properties?.options
      ?.prefixItems;
  if (typeof relationshipId !== 'string' || !Array.isArray(prefixItems)) {
    return [];
  }
  const prompt = relationship.properties?.description?.const;
  return prefixItems
    .filter(item => isObject(item) && Array.isArray(item[kind]))
    .map(item => ({
      relationshipId,
      kind,
      ...(typeof prompt === 'string' ? { prompt } : {}),
      choices: (item[kind] as unknown[])
        .map(readChoice)
        .filter((c): c is PatternChoice => c !== undefined),
    }));
}

/** The decisions a developer answers when generating an architecture from this pattern, in CLI order. */
export function readPatternDecisions(pattern: unknown): PatternDecision[] {
  if (!isObject(pattern)) {
    return [];
  }
  const decisions = relationshipsPrefixItems(pattern)
    .filter(
      rel =>
        isObject(rel) &&
        rel.properties?.['relationship-type']?.properties?.options !==
          undefined,
    )
    .flatMap(rel => [...readBlocks(rel, 'oneOf'), ...readBlocks(rel, 'anyOf')]);

  const seen = new Set<string>();
  return decisions.filter(d => {
    if (seen.has(d.relationshipId)) {
      return false;
    }
    seen.add(d.relationshipId);
    return true;
  });
}

/**
 * Builds the `--option-choices` JSON from answers keyed by relationship id. Throws, with the CLI's wording, on an
 * unknown id, an unknown choice, an array for a `oneOf`, or an unanswered `oneOf`. Empty `anyOf` answers are left out.
 */
export function toOptionChoices(
  decisions: PatternDecision[],
  answers: Record<string, unknown>,
): OptionChoices {
  const out: OptionChoices = {};
  for (const [id, value] of Object.entries(answers)) {
    if (value === undefined || value === null) {
      continue;
    }
    const decision = decisions.find(d => d.relationshipId === id);
    if (!decision) {
      throw new Error(
        `The option id [${id}] is not a valid option in the pattern.`,
      );
    }
    if (Array.isArray(value) && decision.kind === 'oneOf') {
      throw new Error(
        `The option [${id}] is a oneOf option and only accepts a single choice, not an array.`,
      );
    }
    const values = (Array.isArray(value) ? value : [value]).map(String);
    for (const v of values) {
      if (!decision.choices.some(c => c.description === v)) {
        throw new Error(
          `The choice of [${v}] is not a valid choice for option [${id}].`,
        );
      }
    }
    if (decision.kind === 'oneOf') {
      out[id] = values[0];
    } else if (values.length > 0) {
      out[id] = values;
    }
  }
  const unanswered = decisions.find(
    d => d.kind === 'oneOf' && !(d.relationshipId in out),
  );
  if (unanswered) {
    throw new Error(
      `The option [${unanswered.relationshipId}] is a oneOf option and needs exactly one choice.`,
    );
  }
  return out;
}
