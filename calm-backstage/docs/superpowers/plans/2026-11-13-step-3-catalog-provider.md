# Step 3: Catalog provider

Spec: thin slice step 3. Risk to remove: provider-emitted Templates appear on `/create`.
Fallback named in the spec: one generic Template with a field that fetches the options.

## Facts checked (2026-11-13 15:25)

- Backend modules are added in `packages/backend/src/index.ts` with `backend.add(import(...))`. The scaffolder entity
  model module is already there (create-app 1.56), check rather than assume.
- Spike reference (read only): `~/business/sp/backstage/plugins/catalog-backend-module-calm/src/{module,provider}.ts`.
  It shows `catalogProcessingExtensionPoint.addEntityProvider`, a scheduled task runner
  (`scheduler.createScheduledTaskRunner`), `connection.applyMutation({ type: 'full', entities })`, the
  `calm.finos.org/*` annotation names, `entityName()` sanitising, and a pattern-URL regex. Package roles:
  `backend-plugin-module` with `pluginId: catalog`.
- Playwright and its Chromium builds are installed (`node_modules/.bin/playwright`, `~/Library/Caches/ms-playwright`).
- Seed and Hub facts: see the step-2 plan's "Hub API shapes (observed)". From the step-2 report (Hub 0.7.7 on 8090):
  - Namespace `hackathon` (the Hub also holds upstream demo namespaces: finos, workshop, traderx, qcon, …; the
    provider should read only the namespaces listed in config, default `[hackathon]`).
  - Pattern `hackathon/web-service` 1.0.0, `$id`
    `http://localhost:8090/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0`. Decisions:
    `datastore-choice` (oneOf: `PostgreSQL`, `MongoDB`), `add-ons` (anyOf: `Cache (Redis)`,
    `Message queue (RabbitMQ)`, `Observability (OpenTelemetry)`); anyOf nodes are under `items.anyOf`.
    `--option-choices` takes `{"datastore-choice":"PostgreSQL","add-ons":["Cache (Redis)", …]}`.
  - Architectures `orders-service` and `catalog-service` 1.0.0; their `$schema` is the pattern URL.
    `GET /calm/namespaces/hackathon/patterns/web-service/versions/1.0.0/implementations` lists both.
  - Controls: domain `hackathon-security`, requirements `permitted-connection` (configs `https`, `datastore`) and
    `encryption-at-rest` (config `aes-256-kms`); documents reference them by `requirement-url` / `config-url`.
  - Read via the name-based API (`/calm/namespaces/{ns}/patterns/{name}/versions/{v}`): it returns `$id`; the
    numeric `/api/calm/...` reads do not. Control documents come back without `$id` on both APIs. Numeric lists
    look like `{"values":[{"customId","id","name","description","versionCount"}]}`. Check the name-based list
    endpoints in `/q/openapi` before coding the client.
  - Bundles: `bundles/web-service/{1.0.0,2.0.0}/` each with `calm-backstage.json`
    (`version`, `pattern.{namespace, patternId, version, url}`) beside `index.json`.
- The CLI is NOT a dependency yet (age-gate decision pending with Jim). Do not add it and do not change
  `.yarnrc.yml`. Skip the optional CLI cross-check in the tests.

## 3a. `plugins/calm-common` (common library)

- Create with `yarn new` (common-library, id `calm-common`) or by hand in the same shape as the other plugins.
- `annotations.ts`: `calm.finos.org/namespace`, `/pattern`, `/pattern-version`, `/architecture`,
  `/architecture-version`, `/control`, `/bundle`, `/bundle-version`, `/hub-url`.
- `types.ts`: `PatternDecision { relationshipId; kind: 'oneOf' | 'anyOf'; choices: { description; nodes; relationships }[] }`.
- `options.ts`: `readPatternDecisions(pattern)`. Mirror `shared/src/commands/generate/components/options.ts` in
  `~/finos/architecture-as-code` (read only): which relationships count, how `prefixItems` and `$ref` decisions are
  read, which string the CLI's `--option-choices` keys on and which value it matches (description). Write a comment
  naming the source file and the CLI version (1.71.0).
- `hubClient.ts`: a read-only `CalmHubClient(baseUrl, fetch?)` with `namespaces()`, `patterns(ns)`,
  `patternVersions(ns, id)`, `pattern(ns, id, v)`, the same for architectures, and the control endpoints the seed
  uses. Lists unwrap `{values: [...]}`. Model it on `calm-plugins/vscode/src/extension/services/hub-client.ts`.
  (The spec places the Hub client in `calm-backend`; it lives in `calm-common` so the catalog module and
  `calm-backend` share one client. Record as a deviation.)
- Tests (`yarn test` in the package): copy `shared/test_fixtures/command/validate/options/pattern.json` into
  `src/__fixtures__/` with an origin note; assert the decisions read from it and from `seed/patterns/*` match what
  the CLI would offer. Optional cross-check: run `calm generate --option-choices` with each choice read and confirm
  the CLI accepts it.

## 3b. `plugins/catalog-backend-module-calm`

- Config in `app-config.yaml`:
  ```yaml
  calm:
    hubUrl: http://localhost:8090
    refreshSeconds: 60
    bundles:
      - { name: web-service, version: 1.0.0, path: ../../bundles/web-service/1.0.0 }
      - { name: web-service, version: 2.0.0, path: ../../bundles/web-service/2.0.0 }
  ```
  Bundle `pattern` fit comes from the bundle's own metadata file (step 2), not from config.
- Entities (namespace `default`, owner `group:default/guests` or whatever the example org defines; check
  `examples/org.yaml`):
  - Architecture → `Component`, `spec.type: calm-architecture`, `spec.lifecycle: experimental`,
    `spec.dependsOn: [resource:<pattern>]` when the architecture names its pattern, annotations.
  - Pattern → `Resource`, `spec.type: calm-pattern`, `spec.dependsOn` the control Resources it references.
  - Control (requirement) → `Resource`, `spec.type: calm-control`.
  - Bundle → `Resource`, `spec.type: calm-template-bundle`, name `<bundle>-<version>` (sanitised), annotations
    for bundle, version and fitting pattern; `dependsOn` its pattern.
  - Template per pattern (latest version) → `scaffolder.backstage.io/v1beta3` `Template`, name
    `create-from-<pattern>`, `spec.type: service`.
    Parameters, step 1 "Service": `name` (string, required). Step 2 "Choices": one property per decision,
    named from the relationship id, `oneOf` → `{type: string, enum: [descriptions]}`, `anyOf` →
    `{type: array, items: {type: string, enum: [...]}, uniqueItems: true, minItems: 1, ui:widget: checkboxes}`; plus
    `bundle` → `{type: string, enum: ['<bundle>@<version>', ...]}` limited to the bundles that fit this pattern.
    Put the decision→property map in an annotation or `spec.parameters` field metadata so later steps can rebuild
    the `--option-choices` JSON. Steps for now: one `debug:log` step that prints the values. Later steps replace
    it with `calm:generate` and the rest.
- Every entity carries `backstage.io/managed-by-location` and `managed-by-origin-location` of `calm-hub:<hubUrl>`
  (or a `url:` location; check what the spike did and what the catalog accepts for provider entities).
- One full mutation per refresh. A Hub that is down logs a warning and keeps the last entities.

## Verification

- `yarn tsc`, `yarn test` (calm-common), `yarn build:backend`.
- Start the app in the background. `GET /api/catalog/entities?filter=kind=component,spec.type=calm-architecture`
  (and the same for patterns, controls, bundles, templates) with a guest token returns the seeded items.
  `GET /api/catalog/entity-facets?facet=kind` gives the counts.
- The risk check: `node_modules/.bin/playwright screenshot` (or a ten-line Playwright script, guest sign-in by
  clicking "Enter") of `http://localhost:3100/create` shows the pattern's Template, and of its form's choices step.
  Save the screenshots in the scratchpad and report their paths.
- A catalog graph check: `GET /api/catalog/entities/by-name/component/default/<architecture>` shows `dependsOn`
  and the pattern shows its controls.
- Stop the app; ports 3100/7107 free.
- Two commits: `feat(calm-common): add CALM annotations, options reader and Hub client` and
  `feat(catalog): add CALM entity provider with one Template per pattern`.

## Risk gate

If provider Templates do not appear on `/create` after a successful catalog read, stop and report what the catalog
holds for them (the entity JSON and any processing errors from
`GET /api/catalog/entities/by-name/template/default/<name>` `status.items`). The lead decides on the fallback.

## Results (2026-11-13)

- `calm-common` tests: 2 suites, 10 tests passed. `yarn tsc` and `yarn build:backend` exit 0.
- Catalog after the first refresh (`CALM catalog: 1 patterns, 2 architectures, 2 controls, 2 bundles, 8 entities`):
  Components `catalog-service`, `orders-service` (`calm-architecture`); Resources `pattern-web-service`
  (`calm-pattern`), `control-hackathon-security-{encryption-at-rest,permitted-connection}` (`calm-control`),
  `bundle-web-service-{1.0.0,2.0.0}` (`calm-template-bundle`); Template `create-from-web-service`.
- Relations: architecture `dependsOn` `resource:default/pattern-web-service`; the pattern `dependsOn` both controls;
  bundles `dependsOn` the pattern.
- Risk removed: `/create` lists "Web Service (CALM pattern)"; the Choices step shows the `oneOf` as radios, the
  `anyOf` as checkboxes and the two bundles. A task run through `POST /api/scaffolder/v2/tasks` completed and logged
  `{"name":…,"datastore-choice":"PostgreSQL","add-ons":[…],"bundle":"web-service@2.0.0"}`.
- Provider entities skip `catalog.rules` (the rules check only processor-emitted children), so no rule for
  `Template` was needed.

## Deviations

- The Hub client lives in `calm-common` (the spec placed it in `calm-backend`) so the catalog module and
  `calm-backend` share one client.
- Options reader mirrors the monorepo checkout `c7ce7fe1a` (`cli/package.json` 1.67.0), cross-read against the
  Homebrew CLI 1.70.0 bundle; not compared with 1.71.0 (not installed). No CLI cross-check in the tests.
- `anyOf` parameters have no `minItems: 1`: the CLI accepts an unanswered `anyOf`, and the seed pattern sets no
  minimum. `oneOf` parameters and `bundle` are required.
- Resource names carry a type prefix (`pattern-`, `control-<domain>-`, `bundle-`) so they cannot collide in
  `resource:default/`.
- Config adds `calm.namespaces` (default `[hackathon]`); bundle paths resolve against the backend working directory.
- `debug:log` prints `${{ parameters | dump }}` (hyphenated names cannot be used as `parameters.add-ons`).
- `managed-by-location` is `calm-hub:<hubUrl>` for every entity, bundles included.
- The decision→parameter map is the `calm.finos.org/decisions` annotation on the Template.
- Not tested: Hub down at refresh time (the Hub containers were left alone). The code reads everything before the
  mutation and logs a warning on failure, so the last entities stay.
