# Step 6: Finish the run

Spec: thin slice step 6. Risk to remove: file locations.
Fallback named in the spec: write `catalog-info.yaml` only and show its path (no registration).

## Facts checked (2026-11-13 16:05)

- `calm validate -p <pattern> -a <arch> -c http://localhost:8090 -f json` needs `-c`, or control URLs on localhost
  fail with "Requests to private or internal network addresses are not allowed". Output JSON has `hasErrors`,
  `hasWarnings`, `jsonSchemaValidationOutputs`, `spectralSchemaValidationOutputs`.
- `calm template -a <arch> -b <bundleDir> -o <dir> [--clear-output-directory]`: a dir name containing a dot is taken as
  a file path (writes into the parent; with `--clear-output-directory` it empties the parent). Use dot-free names.
- Bundles in `app-config.yaml` `calm.bundles` (`name`, `version`, `path` relative to `packages/backend`); the form value
  is `<name>@<version>` (e.g. `web-service@2.0.0`). v1 renders `README.md`, `docker-compose.yml`,
  `config/application.yaml`; v2 renders `README.md`, `deploy/docker-compose.yml`, `Dockerfile`,
  `config/application.yaml`.
- `calm-common` has `fillPlaceholders(doc, values)` and `scanPlaceholders(doc)` (step 5); `calm-node` has the CLI
  runner (step 5 moved it). The placeholders form value is `{ [jsonPointer]: value }`.
- Catalog: `catalogLocationsExtensionPoint.setAllowedLocationTypes([...])` exists in
  `@backstage/plugin-catalog-node` (its doc says the default is "url" and "file"; check what the locations API and
  `catalog:register` accept in practice). `catalogServiceRef` (`addLocation`) is exported from the same package.
  The spike wrote a `catalog-info.yaml` with `calm.finos.org/architecture-file` (read only:
  `~/business/sp/backstage/plugins/scaffolder-backend-module-calm/src/actions/native.ts` around line 160).
- `catalog.rules` allows `[Component, System, API, Resource, Location]` for config locations.

- From step 5 (commits 28cbfac, 335dba5, 7cfbf15; read its Results/Deviations): tasks sent through the API skip the
  field's validator, so `calm:fill` is the real check that every placeholder has a value. `fillPlaceholders` turns a
  numeric string into a number for a `-1` and throws on an unknown path. Small UI bug to fix in this step: the
  Details step keeps saying "5 values are still needed" after all five are filled; the count should drop as values
  are entered (`plugins/calm/src/components/CalmPlaceholdersField.tsx`).

## 6a. `calm:fill` and `calm:validate`

1. `calm:fill`: input `architecturePath`, `values` (the placeholders object). Writes the filled architecture back (or
   to `outputPath`), fails with the list of placeholders still open (`scanPlaceholders` after fill is empty).
2. `calm:validate`: input `architecturePath`, `patternUrl`. Runs validate with `-c <calm.hubUrl> -f json`, logs a
   summary (error and warning counts, first few messages), fails on `hasErrors`. Output `hasWarnings`.
3. Both `supportsDryRun: true`.

## 6b. `calm:template`, `calm:publish:local`, register

4. `calm:template`: input `architecturePath`, `bundle` (`name@version`), `outputDir` (default `rendered`, dot-free,
   inside the workspace). Resolves the bundle path from config, runs template, outputs the list of files.
5. `calm:publish:local`: input `name`, `sourceDir` (workspace-relative), plus pattern id/version, bundle and
   architecture path. Copies the rendered files, `architecture.json` and a generated `catalog-info.yaml` into
   `<calm.publish.localDir>/<name>` (config, default `<repo>/output`, git-ignored; refuse to overwrite an existing
   folder unless the template says so). The `catalog-info.yaml` is a `Component` (`spec.type: service`, owner from
   the guest user or a parameter) with annotations `calm.finos.org/pattern`, `/pattern-version`, `/bundle`,
   `/bundle-version`, `/architecture-file: ./architecture.json`, and `dependsOn` the pattern Resource
   (`resource:default/pattern-<id>`) and the bundle Resource (`bundle-<name>-<version>`). Outputs `path` and
   `catalogInfoPath`.
6. Register: try the built-in `catalog:register` with `catalogInfoUrl: file://…` or `optional: false`; if it only takes
   `url` locations, call `catalogServiceRef.addLocation({ type: 'file', target })` from a small `calm:register:local`
   action (with the user's credentials from the action context). Allow the `file` type if needed via
   `catalogLocationsExtensionPoint` in the catalog module. Output the entity ref; the Template output links to it.
7. Template steps (provider): `calm:generate` → `calm:fill` (`${{ parameters.placeholders }}`) → `calm:validate` →
   `calm:template` (`${{ parameters.bundle }}`) → `calm:publish:local` → register. Template `output.links`: the new
   entity page and the folder path in `output.text`.

## Verification

- `yarn tsc`, `yarn test`, `yarn build:backend`.
- Start the app. Four Template runs through the tasks API (with placeholder values filled):
  1. PostgreSQL + Cache + Queue, bundle v1, name `orders-api`;
  2. same choices, bundle v2, name `orders-api-v2`;
  3. MongoDB + Observability, bundle v2, name `catalog-api`;
  4. one with a missing placeholder value: the task fails at `calm:fill` with the open placeholder named.
  Runs 1–3 complete, `calm validate` reports no errors, and folders appear under `output/`. Diff 1 vs 2 (bundle
  versions) and 2 vs 3 (choices) and report the file lists and one concrete content difference each.
- The new Components appear in the catalog (`GET /api/catalog/entities/by-name/component/default/orders-api`) with
  `dependsOn` the pattern and bundle.
- One run through the UI with Playwright: fill the form, submit, screenshot the finished task page.
- Stop the app; ports free. Clean `output/` of test runs only if the README will not use them as samples (keep
  `orders-api` and `catalog-api` if the step-7 card can show them; they are git-ignored either way).
- Commits: `feat(scaffolder): add calm:fill and calm:validate actions` and
  `feat(scaffolder): render with the chosen bundle, publish locally and register the service`.

## Risk gate

If registration of a local folder cannot work (location type refused, processing errors on the new location), stop
after writing `catalog-info.yaml`, and report the exact error. The spec's fallback is to show the path and skip
registration; the lead decides.

## Results (2026-11-13)

- Tests: 4 suites, 17 tests passed. `yarn tsc` exit 0, `yarn build:backend` exit 0, `backstage-cli package lint` exit 0
  in the five CALM packages touched.
- Risk removed: a `file` location under `output/` registers and processes. `catalog:register` cannot do it (it always
  adds a `url` location), and the catalog's own default is `["url"]` (`DefaultLocationService`, `CatalogBuilder`),
  whatever the extension point's doc comment says. The CALM catalog module now calls
  `setAllowedLocationTypes(['url', 'file'])`, and `calm:register:local` calls `catalogServiceRef.addLocation` with
  the initiator's credentials (a dry run first, for the entity ref and any processing error).
- Template steps (from the catalog): `calm:generate` → `calm:fill` (`values: ${{ parameters.placeholders }}`) →
  `calm:validate` (pattern `$id`) → `calm:template` (`bundle: ${{ parameters.bundle }}`, `outputDir: rendered`) →
  `calm:publish:local` (name, pattern id/version and namespace written literally by the provider) →
  `calm:register:local`. `output.links`: "Open the new service in the catalog" (`entityRef` from register);
  `output.text`: folder path, rendered files, node/relationship counts and the validate counts.
- Task runs (`POST /api/scaffolder/v2/tasks`, placeholder pointers taken from `POST /api/calm/placeholders`):
  1. `orders-api`, PostgreSQL + Redis + RabbitMQ, `web-service@1.0.0`: `cd55d179-…` completed. 6 nodes / 7
     relationships, `Filled 5 placeholders`, `calm validate: 0 errors, 0 warnings`, rendered `README.md`,
     `config/application.yaml`, `docker-compose.yml`, published to `output/orders-api`, `component:default/orders-api`.
  2. `orders-api-v2`, same choices, `web-service@2.0.0`: `8914a575-…` completed; rendered `Dockerfile`, `README.md`,
     `config/application.yaml`, `deploy/docker-compose.yml`.
  3. `catalog-api`, MongoDB + OpenTelemetry, `web-service@2.0.0`: `d0110bde-…` completed; 5 nodes / 6 relationships.
  4. `missing-value`, owner left empty: `b8f4da27-…` failed at `calm:fill`: "1 of 5 placeholders still need a value:
     /nodes/2/metadata/owner (web-service › metadata › owner; OWNER)". Later steps skipped; nothing published.
- Diffs: v1 vs v2 differ in layout (`docker-compose.yml` vs `deploy/docker-compose.yml`, plus `Dockerfile`) and content
  (`config/application.yaml` v2 adds `management.health-path: /health` and `kind: postgres`). Choices A vs B: the
  compose file swaps `postgres:16` + `redis:7` + `rabbitmq:3-management` for `mongo:7` + `otel-collector`.
- Catalog: `orders-api`, `orders-api-v2`, `catalog-api` (and `inventory-api` from the UI run) are `Component`
  `service`, owner `group:default/guests`, `managed-by-location: file:<repo>/output/<name>/catalog-info.yaml`,
  relations `dependsOn` `resource:default/pattern-web-service` and `resource:default/bundle-web-service-<version>`.
- UI (Playwright): Details went "5 of 5 values are still needed" → "3 of 5" → "all 5 values are given"; the task
  `f01dfdaf-…` for `inventory-api` finished with all six steps green and the catalog link.

## Deviations

- `catalog:register` is not used: it hard-codes `type: url`. A small `calm:register:local` adds the `file` location,
  refuses a `catalog-info.yaml` outside `calm.publish.localDir`, treats a conflict as already registered, and waits
  (30 s) for the catalog to hold the entity from that file; an entity of that name from another location fails the
  step.
- Owner: the task user is `user:development/guest`, which the catalog does not hold, so the Component's owner is
  `group:default/guests` (an `owner` input can override it). `spec.lifecycle: experimental` is added (required).
- The pattern and bundle entity-name helpers moved to `calm-common` (own refactor commit) so `dependsOn` cannot drift
  from the provider. A third commit fixes the Details count (`fix(calm)`), so there are four commits, not two.
- New `calm-node` helpers `validateArchitecture`, `renderBundle`, `listFiles`. `calm validate` exits 1 when the report
  has errors; the report (`-o calm-validation.json` in the workspace) is still read and summarised.
- `calm template` runs without `--clear-output-directory` (fresh workspace; with a misread path the flag would empty
  the parent) and rejects any output folder with a dot in a segment.
- `calm:publish:local` copies only the rendered files and `architecture.json` (not the choices or validation files),
  refuses an existing folder unless `overwrite: true`, and writes `catalog-info.yaml` with the `yaml` package.
  `calm.publish.localDir` (default `../../output`, relative to `packages/backend`) is set in `app-config.yaml` and
  declared in the scaffolder module's `config.d.ts`; `/output/` is git-ignored.
- The Template's `name` now has `pattern: ^[a-z0-9]+(-[a-z0-9]+)*$` and `maxLength: 63`. Without a fitting bundle the
  Template stops after `calm:validate`.
- `calm:fill` also fails on a value for a path that is not a placeholder (rather than overwriting that value).
- Findings: `calm template` has no `-c`, so its look-ups of the Hub's control URLs on localhost fail ("Failed to
  dereference Resolvable: … Requests to private or internal network addresses are not allowed: localhost"); the
  bundles do not use controls, so rendering succeeds. Generated architectures have no `$id`, so the bundles' "architecture" provenance line is empty. The
  catalog database is in memory: the registered Components are gone after a restart while `output/` stays (not fixed
  here). Kept under `output/`: `orders-api`, `orders-api-v2`, `catalog-api`.
- Read from the installed source, not seen refused in a run: the catalog's `["url"]` default and `catalog:register`'s
  fixed `url` type (the extension call was in place before the first probe).
- Runs 1–3 were done twice; the first set used index-based port values (the service port came out as 5672), so its
  three locations were deleted through `DELETE /api/catalog/locations/{id}`, the folders removed, and the runs
  repeated. The ids above are the second set. The UI run's `output/inventory-api` was removed afterwards.
- After a restart: the three folders stay under `output/` but the catalog (in memory) no longer holds their
  Components, and a new run with the same name is refused by `calm:publish:local` because the folder exists.
- Not exercised: `calm:validate`'s error branch through Backstage (only the CLI by hand: exit 1, report still
  written with `hasErrors: true`); the overwrite refusal of `calm:publish:local`; the conflict, name-clash, timeout
  and outside-folder branches of `calm:register:local`; a Template without a fitting bundle; the dotted `outputDir`
  rejection. No unit tests were added in this step (the 17 tests are repo-wide).
