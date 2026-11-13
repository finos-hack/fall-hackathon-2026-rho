# Step 5: Placeholders

Spec: thin slice step 5. Risk to remove: the alpha form-field API.
Spec decision: a custom form field asks the backend, which runs `calm generate` and returns the placeholder list.

## Facts checked (2026-11-13 15:55)

- The app uses the new frontend system: `packages/app/src/App.tsx` is `createApp({ features: [catalogPlugin, navModule,
  homeModule] })` from `@backstage/frontend-defaults`, and `app.packages: all` discovers plugins from
  `packages/app/package.json` dependencies (`@backstage/plugin-scaffolder` ^1.40.0 is there).
- `@backstage/plugin-scaffolder-react` 2.1.1, `/alpha`: `FormFieldBlueprint` (kind `scaffolder-form-field`,
  `params: { field: () => Promise<FormField> }`) and `createFormField({ name, component, validation?, schema? })`.
  `component` receives `FieldExtensionComponentProps` (`formData`, `onChange`, `uiSchema['ui:options']`,
  `formContext`, …). `formContext.formData` holds the values of earlier steps (spec fact; confirm at runtime).
- Spike frontend (read only): `~/business/sp/backstage/plugins/calm/src/{plugin.tsx,api.ts}` shows
  `createFrontendPlugin`, `EntityCardBlueprint.make({ name, params: { filter, loader } })`, and calls to the backend
  with `discoveryApiRef` + `fetchApiRef` (the fetch API adds the user token).
- Placeholders (spec fact): `"[[ NAME ]]"` strings and `-1` numbers, from
  `shared/src/commands/generate/components/property.ts` in the monorepo (read only). Seed placeholders:
  `api-gateway` interface host/port, `web-service` port, `web-service.metadata.owner` / `service-name`.
- Step 4 (commit 5c28692) built `calm:generate` and a CLI runner in
  `plugins/scaffolder-backend-module-calm/src/{cli.ts,actions/generate.ts}`: `require.resolve` + `bin.calm`, own
  `spawn` of `process.execPath`, ANSI stripped, `CalmCliError` with the exit code and last 20 stderr lines. The CLI
  writes progress to stderr. The Template step writes the pattern URL literally and builds `choices` with one
  expression per decision (`'${{ parameters["add-ons"] }}'`), keyed by relationship id; the CLI is the validator
  (no `toOptionChoices` in the path). The provider can put the same pattern URL and decision map in the field's
  `ui:options`. After a backend restart the catalog needs a few seconds before the Template exists again (404 until
  then). Backend-only runs: `yarn workspace backend start`; for the form you need `yarn start` (both).

## Tasks

1. **Shared CLI runner.** Move the step-4 CLI runner into a new node library `plugins/calm-node`
   (`role: node-library`) with `calmBin()`, `runCalm()` and a `generateArchitecture({ patternUrl, hubUrl, choices,
   dir, logger })` helper. The scaffolder module and `calm-backend` both use it. (The spec has no `calm-node`; record
   it as a deviation.) No behaviour change to `calm:generate`.
2. **Scanner in `calm-common`.** `scanPlaceholders(doc)` returns `{ path: string /* JSON Pointer */, kind:
   'string' | 'number', name: string /* NAME, or the last path segments for numbers */, label: string }[]`;
   `fillPlaceholders(doc, values: Record<path, string | number>)` returns a copy with those paths set (step 6 uses
   it for `calm:fill`). Unit tests with a generated architecture fixture (generate one from the Hub pattern with the
   CLI, save it under `src/__fixtures__/` with a note on how it was made).
3. **`plugins/calm-backend`** (`backend-plugin`, id `calm`): `POST /placeholders` with body `{ patternUrl, choices }`
   (choices as the raw form values plus the `calm.finos.org/decisions` map, or already converted with
   `toOptionChoices`; pick one and document it). It runs generate in a temp folder (`os.tmpdir()`, removed after),
   scans the result and returns `{ placeholders, nodeCount, relationshipCount }`. Validate `patternUrl` starts with
   `calm.hubUrl`. Default auth policy (user or service token). Add to `packages/backend/src/index.ts`.
4. **`plugins/calm`** (frontend, new system): `createFrontendPlugin({ pluginId: 'calm', extensions: [...] })` with a
   `FormFieldBlueprint` extension for field `CalmPlaceholders`. The field reads `ui:options.patternUrl` and
   `ui:options.decisions`, takes the earlier choices from `formContext.formData`, posts to the backend, and shows one
   input per placeholder (number inputs for numbers). Its value is `{ [path]: value }`. Re-fetch when the choices
   change; show a loading state and the backend's error text. A `validation` that requires every placeholder.
   Add `@internal/backstage-plugin-calm` to `packages/app/package.json` so `packages: all` discovers it (or add it to
   `features` in `App.tsx`; check which works).
5. **Template.** The provider adds a third parameters step "Details" with
   `placeholders: { type: object, 'ui:field': CalmPlaceholders, 'ui:options': { patternUrl, decisions } }`. Steps
   stay as step 4 left them, plus a `debug:log` of `parameters.placeholders`.
6. **Verification.** `yarn tsc`, `yarn test` (calm-common), `yarn build:backend`. Start the app.
   `curl -X POST /api/calm/placeholders` with a guest token and the PostgreSQL+Cache choices returns the placeholder
   list (report it). Playwright: walk `/create` → Web Service → name → choices → Details; screenshot the Details step
   with inputs, fill them, go to Review, screenshot. Run the Template; the task log shows the placeholder values.
   Change the choices and confirm the Details list follows (if the pattern's placeholders differ by choice; report
   either way). Stop the app; ports free.
7. Commits: `refactor: move the CALM CLI runner into calm-node`, `feat(calm-common): add placeholder scanner`,
   `feat(calm): add placeholders route and CalmPlaceholders form field`.

## Risk gate

If the alpha `FormFieldBlueprint` field does not render in the form (unknown `ui:field`, or the extension is not
picked up), try the documented alternatives once (adding the plugin to `features`, or the legacy
`scaffolderPlugin.provide(createScaffolderFieldExtension(...))` route if the new system supports it). If it still
fails, stop and report: the console errors, the extension tree (`/visualizer`), and what was tried.

## Results (2026-11-13)

- `calm-common` tests: 3 suites, 16 tests passed. `yarn tsc` exit 0, `yarn build:backend` exit 0, `backstage-cli package
  lint` exit 0 in all six CALM packages.
- Risk removed: the alpha `FormFieldBlueprint` field renders with no extra wiring. `@internal/backstage-plugin-calm` in
  `packages/app/package.json` is enough for `app.packages: all`. The blueprint attaches to `api:scaffolder/form-fields`
  (read from the source); the id is `scaffolder-form-field:calm/calm-placeholders` by the naming rule (`/visualizer` not
  opened). No `features` entry and no legacy route was needed.
- `POST /api/calm/placeholders` (guest token) with `{ patternUrl: <web-service 1.0.0 $id>, choices: { datastore-choice:
  PostgreSQL, add-ons: [Cache (Redis)] } }` → 200, `nodeCount` 5, `relationshipCount` 6, five placeholders:
  `/nodes/1/interfaces/0/host` (HOST), `/nodes/1/interfaces/0/port` (number), `/nodes/2/metadata/owner` (OWNER),
  `/nodes/2/metadata/service-name` (SERVICE_NAME), `/nodes/2/interfaces/0/port` (number). No token → 401; a pattern URL
  outside the Hub (`http://localhost:8090.evil/x`) → 400 `InputError`; `datastore-choice: Oracle` → 400 with the CLI's
  "The choice of [Oracle] is not a valid choice for option [datastore-choice]." Temp folders are removed.
- Form (Playwright): Details shows one input per placeholder, labelled by the enclosing unique-ids, with number inputs for
  the ports. Review is blocked while the list loads and while any input is empty. Going back and switching to MongoDB +
  RabbitMQ + OpenTelemetry re-fetches (5/6 → 6/7 nodes/relationships) and keeps the values; the placeholder list itself
  is the same for every choice of the seed pattern (the placeholders sit on fixed nodes).
- Task `ca08c805-…` (form, MongoDB + RabbitMQ + OpenTelemetry) `completed`: `Generated architecture.json: 6 nodes, 7
  relationships`, then `placeholders: {"/nodes/1/interfaces/0/host":"gateway.example.com","/nodes/1/interfaces/0/port":443,…}`.
  Task `d796ba5f-…` (API, PostgreSQL + Redis + RabbitMQ) `completed` with 6 nodes, 7 relationships, as in step 4.

## Deviations

- New package `plugins/calm-node` (`node-library`, not in the spec) holds `calmBin`, `runCalm`, `normaliseChoices` and
  `generateArchitecture`; `@finos/calm-cli` 1.71.0 moved there from the scaffolder module. `calm:generate` keeps its
  inputs, outputs, choices file name and log lines; the scaffolder module still re-exports `calmBin`, `runCalm`,
  `CalmCliError`.
- `/placeholders` takes `choices` already keyed by decision (relationship) id, the same JSON as the `calm:generate`
  input; the field maps form parameters with `ui:options.decisions`. As in step 4 the CLI validates; the route only
  drops unanswered values (via `normaliseChoices`) and maps a `CalmCliError` to a 400 `InputError` with the CLI tail.
- The Hub check is "starts with `hubUrl` (trailing slashes removed) + `/`", so a look-alike host is refused.
- Every `[[ … ]]` string is a `string` placeholder (the CLI's `BOOLEAN_`/`REF_` and array forms included); a `-1`
  number's `name` is `<enclosing unique-id>.<key>` (e.g. `api-gateway-ingress.port`). `fillPlaceholders` converts a
  numeric string for a `-1` and throws on an unknown path.
- RJSF fills `{}` for the `type: object` parameter, so `required` alone does not stop an early Review, and the Stepper
  calls a field validator with the value only. The validator checks the value against the list the field last showed
  (module state) and blocks while it is loading or failed. The inputs show the required asterisk without the browser's
  own `required` check, so the field validator's messages are what the user sees.
- The field shows the node and relationship counts as well as the inputs, so a re-fetch is visible even though the seed
  pattern's placeholder list does not change with the choices.
- The Review step lists the values by splitting the pointer keys (`Placeholders > Nodes > 1 > Interfaces > 0 > Host`).
  A nicer review is left for track C.
- `debug:log` prints `${{ parameters.placeholders | dump }}`.
- Known limits: answers carried over after a choice change are keyed by index-based pointer (safe here, where the
  placeholders sit on fixed nodes; with placeholders on optional nodes a pointer can name another value). Tasks sent
  through the API skip the field validator, so `calm:fill` must check completeness itself. After an early Review click
  the "still loading" message stays until the next submit. The backend's error text in the field was not seen in the
  browser (only its response shape, by curl).
