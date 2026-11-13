# Step 7: Entity pages

Spec: thin slice step 7. Risk to remove: Mermaid in Backstage.
Spec decision: Mermaid in the browser from a small transform. No unpublished CALM package.

## Facts checked (2026-11-13 16:25)

- `EntityCardBlueprint` (`@backstage/plugin-catalog-react/alpha`):
  `EntityCardBlueprint.make({ name, params: { loader: () => Promise<JSX.Element>, filter?, type? } })`; `filter` takes a
  function, a filter expression string, or a predicate. Spike example (read only):
  `~/business/sp/backstage/plugins/calm/src/{plugin.tsx,components/CalmCards.tsx}` (`useEntity`, lazy `loader`).
- `mermaid` 11.17.2 is already in `yarn.lock` and `node_modules` (a dependency of `@finos/calm-cli`). Depend on
  `mermaid: ^11.16.1` from `plugins/calm` so Yarn reuses that resolution and fetches nothing. Do not take a newer
  version (the 3-day age gate applies and `.yarnrc.yml` must not change).
- The frontend plugin `plugins/calm` exists (step 5: `createFrontendPlugin({ pluginId: 'calm' })` with the
  `CalmPlaceholders` field). `calm-backend` exists with `POST /placeholders`; the Hub client and options reader are in
  `calm-common`.
- Entities (step 3): architectures `component:default/{orders-service,catalog-service}` (`spec.type:
  calm-architecture`), pattern `resource:default/pattern-web-service`, controls `control-*`, bundles
  `bundle-web-service-{1.0.0,2.0.0}`, Template `create-from-web-service`. Step 6 adds services published to `output/`
  with `calm.finos.org/architecture-file` (read the step-6 Results for the exact annotations).

- Step 6 (commits 638c90a…ffa2331): published services live in `output/<name>/` (`architecture.json`,
  `catalog-info.yaml` with `calm.finos.org/{namespace,pattern,pattern-version,bundle,bundle-version}` and
  `calm.finos.org/architecture-file: ./architecture.json`, `spec.type: service`, tag `calm-service`). Present now:
  `orders-api` (v1), `orders-api-v2`, `catalog-api`. Entity names helpers are in `calm-common/src/entityNames.ts`.
  The catalog database is in memory, so these services vanish from the catalog on restart (folders stay).

## Tasks

0. **Published services survive a restart.** Add a `catalog.locations` entry `type: file`,
   `target: ../../output/*/catalog-info.yaml`, `rules: [allow: [Component]]` (check that the glob works for file
   locations and that an empty `output/` does not error). Change `calm:register:local` so that, when the entity
   already comes from that glob location (same file), it counts as registered instead of failing on the name clash,
   and it waits for the entity as before (or triggers a refresh of the glob location). Verify: restart the backend,
   the three published services are back in the catalog; one new Template run still completes and its entity
   appears.

1. **Transform in `calm-common`.** `toMermaid(architecture)` returns a `flowchart` string: one node per CALM node
   (label = name, with the node type as a second line, shape by type: e.g. database → cylinder, actor/webclient →
   rounded), one edge per `connects` relationship (label = protocol), `interacts` as dotted edges, `composed-of` /
   `deployed-in` as subgraphs if simple, otherwise edges. Escape labels; sanitise ids. Unit tests with the step-5
   generated fixture: the output contains every node and connection.
2. **`calm-backend` routes.**
   - `GET /architecture?entityRef=<ref>`: reads the entity from the catalog (`catalogServiceRef` with the caller's
     credentials), then either fetches the architecture from the Hub using the entity's annotations (namespace,
     architecture, version), or, for a published local service, reads `architecture-file` relative to the entity's
     source location (only inside `calm.publish.localDir`). Returns `{ architecture, source }`.
   - `GET /pattern?entityRef=<ref>`: returns the pattern's decisions (`readPatternDecisions`), the bundles that fit
     (from config + `calm-backstage.json`), and the Template ref.
3. **Architecture card** (`EntityCardBlueprint`, filter: has `calm.finos.org/architecture` or
   `calm.finos.org/architecture-file`, or `spec.type == calm-architecture`): pattern and version (linking to the
   pattern entity), the controls it references (linking to the control entities), node/relationship counts and the
   Mermaid diagram rendered with `mermaid.render()` into an inline SVG. Init mermaid once with
   `startOnLoad: false`, `securityLevel: 'strict'`, and a theme picked from the Backstage palette (light/dark).
   Loading and error states.
4. **Pattern card** (filter: `spec.type == calm-pattern`): one row per decision (kind oneOf/anyOf, choices), the bundles
   that fit (links to the bundle entities), and a "Create from this pattern" link to `/create/templates/default/
   create-from-<pattern>`.
5. Check where the cards land on the entity page (overview grid) in the new frontend system; if they need enabling in
   `app-config.yaml` `app.extensions`, add it.
6. **Verification.** `yarn tsc`, `yarn test`, `yarn build:backend`, `yarn build:all` or the app build if Mermaid's ESM
   causes bundling trouble. Start the app. Playwright screenshots (save to `docs/demo/` with clear names; the spec
   wants three screens):
   - `docs/demo/catalog.png`: catalog list filtered to CALM kinds (or the catalog graph for `orders-service` showing
     architecture → pattern → controls);
   - `docs/demo/architecture-page.png`: `orders-service` page with the card and diagram;
   - `docs/demo/pattern-page.png`: `pattern-web-service` page with decisions and bundles;
   - `docs/demo/create-form.png`: the choices step of the Template form (reuse the step-3/5 flow);
   - one published service page (from step 6) with its diagram, if `output/` has one.
   Also check the browser console for Mermaid errors. Stop the app; ports free.
7. Commits: `feat(calm-common): add CALM to Mermaid transform`, `feat(calm): add architecture and pattern entity cards`.

## Risk gate

If Mermaid will not bundle or render in the Backstage frontend (ESM/worker errors, CSP), stop and report the errors.
Alternatives to name in the report: render the SVG on the backend with the CLI's own docify/diagram output, or show
the Mermaid source in a code block with a link to mermaid.live.

## Results (2026-11-13)

- Tests: 5 suites, 22 tests passed (`toMermaid`: 5 new). `yarn tsc` exit 0, `yarn build:backend` exit 0,
  `yarn workspace app build` exit 0 (Mermaid in its own lazy chunks, no bundling warnings), `backstage-cli package lint`
  exit 0 in the five CALM packages. `yarn install` added workspace lines only to `yarn.lock` (`mermaid@npm:^11.16.1`
  reused at 11.17.2; nothing fetched).
- Task 0: after a backend restart the catalog holds `orders-api`, `orders-api-v2`, `catalog-api` again, with
  `managed-by-location: file:<repo>/output/<name>/catalog-info.yaml` and `managed-by-origin-location:
  file:<repo>/output/*/catalog-info.yaml`. An empty glob gives one `warn` log line ("… does not exist") on its Location
  entity, nothing else. New run `payments-api` (PostgreSQL + Redis, `web-service@2.0.0`): task `f5251005-…`
  `completed`, entity in the catalog. A forced refresh of the glob Location afterwards, then about 5 minutes with both
  Locations live (and the later full-app run), logged no conflict.
- Routes (guest token): `GET /api/calm/architecture?entityRef=component:default/orders-service` → 200 with `source:
  { type: hub, url: …/architectures/orders-service/versions/1.0.0 }`; `…=component:default/orders-api` → 200 with
  `source: { type: file, path: orders-api/architecture.json }`; `GET /api/calm/pattern?entityRef=
  resource:default/pattern-web-service` → 200 with 2 decisions (`datastore-choice` oneOf, `add-ons` anyOf), bundles
  `bundle-web-service-{1.0.0,2.0.0}`, `templateRef: template:default/create-from-web-service`. Unknown ref → 404,
  entity without CALM annotations → 404, no `entityRef` → 400, no token → 401.
- Risk removed: Mermaid renders in the dev server (3100) and in the built app served by the backend (7107, with the
  backend's CSP: `script-src 'self' 'unsafe-eval'`): SVG present on `orders-service`, `orders-api` and the pattern card
  loads; no console errors on 7107. A page loaded with the dark theme set renders with Mermaid's `dark` theme (the
  in-page theme toggle, a second `initialize`, was not exercised). No Mermaid scratch elements left in the body.
- Screenshots in `docs/demo/`: `catalog.png` (Components tagged `calm`: two architectures, four published services),
  `catalog-graph.png` (`orders-service` → `pattern-web-service` → two controls, `dependsOn` only),
  `architecture-page.png`, `pattern-page.png`, `service-page.png` (`orders-api` from its architecture file),
  `create-form.png` (Choices step).
- Browser console on 3100: React dev warnings from Backstage/material-table (`defaultProps`, `findDOMNode`, keys,
  `validateDOMNesting`), the deprecated IconComponent warning, and a 404 for `user:development/guest` (the guest user is
  not in the catalog, as in step 6). None from Mermaid or the CALM cards.

## Deviations

- The cards land at the end of the overview's content column with no `app.extensions` entry (both are `type:
  content`; the default layout puts content cards after the built-in ones).
- Bundles for `/pattern` come from the catalog's bundle Resources (filter `spec.type`, `calm.finos.org/pattern`, then
  namespace as `bundlesFor` does), not from config + `calm-backstage.json` again: the reader is private to the catalog
  module and the card links to those Resources anyway. `templateRef` is left out when the catalog has no such Template.
- `calm:register:local` checks the catalog first and returns when it already holds the entity from the same file; for
  a new folder it still adds the `file` location (the glob is reread only on the catalog's processing interval, by
  default 100-150 s, read from `CatalogBuilder`). After the glob's forced pass the entity's origin location showed the
  glob (with two parent Locations it may alternate); no conflict. The "already held" branch was not hit by a run.
- `/architecture` reads the Hub at the configured `calm.hubUrl` (not the entity's `hub-url` annotation), resolves the
  architecture file from `managed-by-location` (must be `file:`) and refuses a path outside `calm.publish.localDir`
  (`resolveSafeChildPath`). The outside-folder branch was not exercised.
- `toMermaid` returns `{ source, nodeCount, drawnRelationships, skippedRelationships }`. Ids are `n0…`; labels use
  Mermaid entity codes; the node type is a second line in italics. `options` relationships and edges to unknown nodes
  are skipped. Subgraphs are used only when every contained node has one container and containers do not nest.
  The seed data has no `interacts`, `composed-of` or `deployed-in`, so those paths are covered by unit tests only.
- Controls on the card come from the document's `requirement-url`s, not from catalog relations; the control and
  Template name helpers moved to `calm-common` (own refactor commit). Four commits instead of two (Task 0 and the
  refactor are separate), plus this docs commit.
- Extra screenshots: `catalog-graph.png` and `service-page.png`. Kept `output/payments-api` from the Task 0 run.
