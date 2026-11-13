# Step 4: `calm:generate`

Spec: thin slice step 4. Risks to remove: CLI bin resolution, the exact choices JSON.

## Facts checked (2026-11-13 15:40)

- `@finos/calm-cli@1.71.0`: `bin: { calm: 'dist/index.js' }`, no `exports` map, `engines.node: ^22.13.0 || >=23.5.0`.
  So `require.resolve('@finos/calm-cli/package.json')` works and the bin is `<pkgdir>/dist/index.js`; run it with
  `process.execPath` so the backend's Node runs it (no PATH lookup, no Homebrew `calm`).
- Jim pre-approved `@finos/calm-cli` in `.yarnrc.yml` `npmPreapprovedPackages` (lead applies this at the end of step
  2, before step 4 starts; check that `node_modules/@finos/calm-cli` exists).
- `--option-choices` takes a JSON object: oneOf decision id → choice description string; anyOf decision id → array of
  description strings. Verified on 1.69.0 and 1.70.0 against the Hub pattern:
  `{"datastore-choice":"PostgreSQL","add-ons":["Cache (Redis)","Message queue (RabbitMQ)"]}` gives 6 nodes,
  7 relationships; `{"datastore-choice":"MongoDB","add-ons":["Observability (OpenTelemetry)"]}` gives 5 nodes, 6.
- `calm generate -p <Hub pattern URL> -c http://localhost:8090 -o <file> --option-choices <json|file>` resolves Hub
  URLs with no `-u` mapping.
- Spike reference (read only): `~/business/sp/backstage/plugins/scaffolder-backend-module-calm/src/{calm.ts,actions/native.ts}`
  (`createTemplateAction` with zod `schema.input`/`schema.output` callbacks, `execFile`).
- `@finos/calm-cli@1.71.0` is now a root dev dependency (commit after 03cd0ca; `.yarnrc.yml` pre-approves it).
  On 1.71.0 the two choice sets above still give 6/7 and 5/6 (lead re-run).
- Step 3 output (see the step-3 plan's Results/Deviations and `plugins/catalog-backend-module-calm/src/entities.ts`):
  Template `create-from-web-service`; form parameters are named after the decision ids (`datastore-choice`,
  `add-ons`; a decision called `name` or `bundle` becomes `choice-<id>`), plus `name` and `bundle`
  (`web-service@2.0.0`). The decision → parameter map is the `calm.finos.org/decisions` annotation
  (`[{parameter, relationshipId, kind}]`). `calm-common` exports `toOptionChoices`, which rebuilds the
  `--option-choices` JSON; use it in the action so the Template can pass the raw parameters. Hyphenated names break
  `parameters.add-ons` in Nunjucks; use `parameters['add-ons']` or pass the whole `parameters` object.
  The pattern's `$id` is in the pattern annotations; the Template needs it as `patternUrl`.

## Tasks

1. Create `plugins/scaffolder-backend-module-calm` (`backend-plugin-module`, `pluginId: scaffolder`) and add it to
   `packages/backend/src/index.ts`. Dependency `@finos/calm-cli` `1.71.0` (exact).
2. `src/cli.ts`: `calmBin()` resolves the bin as above; `runCalm(args, { cwd, logger })` runs
   `process.execPath [bin, ...args]`, streams stdout/stderr to the task logger, and rejects with the exit code and the
   last lines of stderr. Prefer `executeShellCommand` from `@backstage/plugin-scaffolder-node` if it streams to the
   task log; otherwise `execFile`/`spawn`.
3. `calm:generate` action. Input: `patternUrl` (string), `choices` (object of decision id → string | string[]),
   `outputPath` (default `architecture.json`, relative to the workspace). It writes the choices to a file in the
   workspace, runs `generate -p <patternUrl> -c <calm.hubUrl> -o <workspace>/<outputPath> --option-choices <file>`,
   and outputs `architecturePath` and `nodeCount`/`relationshipCount`. Validate that `outputPath` stays inside
   the workspace (`resolveSafeChildPath`).
4. Template: change the provider-generated Template's steps from `debug:log` to `calm:generate`, building
   `choices` from the form values with the decision → property map (an expression per decision, or one `choices`
   object parameter if that is simpler; record which). Keep a `debug:log` after it that prints the outputs.
   Template `output.text` shows the node and relationship counts.
5. Verification: `yarn tsc`, `yarn build:backend`. Start the app, run the pattern Template through
   `POST /api/scaffolder/v2/tasks` twice with the two choice sets above; both tasks `completed`; the logs show
   6 nodes / 7 relationships and 5 / 6. Run once with an invalid choice (e.g. `"datastore-choice":"Oracle"`) and
   report what the task log says. Stop the app; ports free.
6. Commit: `feat(scaffolder): add calm:generate action running the published CALM CLI`.

## Risk gate

If the bin cannot be resolved from the module (Yarn 4 PnP or hoisting quirks), or the CLI rejects the choices JSON the
Template produces, stop and report the exact error and the JSON sent.

## Results (2026-11-13)

- Bin: `require.resolve('@finos/calm-cli/package.json')` + `bin.calm`, run as `process.execPath <bin> …` with our own
  `spawn`. Logged at start-up: `calm CLI bin: /opt/homebrew/Cellar/node/26.13.1/bin/node
  <repo>/node_modules/@finos/calm-cli/dist/index.js` (hoisted; `nodeLinker: node-modules`).
- Template step as the catalog holds it: `calm:generate` with `patternUrl:
  http://localhost:8090/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0` and
  `choices: { datastore-choice: '${{ parameters["datastore-choice"] }}', add-ons: '${{ parameters["add-ons"] }}' }`,
  then `debug:log` of the outputs; `output.text` renders "Generated `architecture.json` from the pattern: **6 nodes**,
  **7 relationships**."
- `yarn tsc` exit 0, `yarn build:backend` exit 0, `yarn lint` in both CALM backend modules exit 0.
- `POST /api/scaffolder/v2/tasks`: PostgreSQL + Redis + RabbitMQ → task `4bc3f62f-…` `completed`, log
  `Generated architecture.json: 6 nodes, 7 relationships`; MongoDB + OpenTelemetry → task `977d005a-…` `completed`,
  `5 nodes, 6 relationships`. The `--option-choices` JSON the action wrote was exactly the shape in "Facts checked".
- `"datastore-choice":"Oracle"`: the scaffolder answers HTTP 400 before a task exists (`instance.datastore-choice is
  not one of enum values: PostgreSQL,MongoDB`). With the enum removed, `POST /v2/dry-run` runs the action and fails
  with `CalmCliError: calm exited with code 1: … The choice of [Oracle] is not a valid choice for option
  [datastore-choice].`

## Deviations

- Choices are built by one expression per decision, generated by the provider (keyed by relationship id, reading the
  parameter, so `choice-<id>` renames are handled). The action does not call `toOptionChoices`: the CLI is the
  validator (the risk gate tests the CLI against the JSON), and the action only drops unanswered values.
- `patternUrl` is the pattern's `$id`, written literally into the step input (the Template carries no `$id`
  annotation; it falls back to the name-based Hub URL).
- `runCalm` uses `spawn`, not `executeShellCommand`: the latter rejects with only the exit code. The CLI writes its
  progress and its errors to stderr, with ANSI colour even when piped and with `NO_COLOR`/`FORCE_COLOR=0`; lines are
  stripped of ANSI and logged at info, and the rejection carries the last 20 lines.
- `calm:generate` has `supportsDryRun: true` (it reads the Hub and writes only in the workspace), so the Template
  editor's dry run runs it; this is how the invalid-choice path was exercised through Backstage.
- The choices file is `calm-option-choices.json` at the workspace root (no dotted directory).
- Verification started the backend only (`yarn workspace backend start`), not the frontend.
