/**
 * CALM backend plugin (`calm`): `POST /placeholders` runs `calm generate` (published `@finos/calm-cli`) for a Hub
 * pattern and a set of option choices and returns the placeholders left in the architecture. `GET /architecture` and
 * `GET /pattern` feed the entity cards.
 *
 * @packageDocumentation
 */

export { calmPlugin as default } from './plugin';
export type {
  ArchitectureResponse,
  PatternResponse,
  PlaceholdersRequest,
  PlaceholdersResponse,
} from './router';
