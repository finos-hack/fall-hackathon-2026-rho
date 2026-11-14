# Step 2: Hub and seed

Spec: thin slice step 2. Risks to remove: clone-and-run, Hub write API shapes.

## Facts checked (2026-11-13 15:20)

- Reference compose: `~/finos/architecture-as-code/calm-hub/deploy/docker-compose.yml` (checkout `c7ce7fe1a`,
  2026-11-02). Profile `jvm`: `finos/calm-hub:latest` with
  `JAVA_OPTS=-Dquarkus.mongodb.connection-string=mongodb://mongodb:27017 -Dquarkus.profile=no-auth`; `mongo:latest`
  mounts `calm-hub/mongo/init-mongo.js` into `/docker-entrypoint-initdb.d/` and the release schemas at
  `/calm-schemas/release` with `CALM_RELEASE_SCHEMA_PATH=/calm-schemas/release`.
- `init-mongo.js` (7089 lines) sets `LATEST_SCHEMA_VERSION = 16`. The Hub's `SchemaMigrationRunner` compares this
  with its own latest step. The checkout is 11 days behind `latest`, so a mismatch is possible: check the Hub log.
- The base URL property is `calm.hub.base-url=${CALM_HUB_BASE_URL:…}` (in `application-oidc.properties`; check it
  also applies under `no-auth`, otherwise pass `-Dcalm.hub.base-url=http://localhost:8090` in `JAVA_OPTS`).
- Schema layout: `<path>/<major.minor>/meta/*.json`. `@finos/calm-cli@1.71.0` already ships it at
  `dist/calm/release/{1.0,1.1,1.2,1.3}/meta`, so one package covers every release. `@finos/calm-schema@1.3.0` holds
  only 1.3 (`schema/`, `release/`, `draft/`). The spec named `@finos/calm-schema`; use the CLI's `dist/calm/release`
  instead (deviation, recorded).
- CLI 1.71.0: `calm generate -p <file|Hub URL> -o <file> -c <hubUrl> -u <url-map> --option-choices <json|file>`
  (a JSON object of option unique-id → choice description). `calm template -a -b -o [--clear-output-directory] [-u]`.
- Decision shape: see `shared/test_fixtures/command/validate/options/pattern.json` and `PATTERN-DECISIONS.md` in
  the monorepo. A relationship whose `relationship-type.properties.options` is an array whose `prefixItems[]` hold
  `oneOf` or `anyOf` lists of `core.json#/defs/decision` objects (`description`, `nodes`, `relationships` consts).
- Bundle format reference: `conferences/qcon/scenario4/bundle-v1/index.json` (`name`, `transformer`, `templates[]`
  with `template`, `from`, `output`, `output-type`). Format only: those bundles fit the trades architecture.

## Tasks

1. `hub/docker-compose.yml`: `finos/calm-hub:latest` with the `no-auth` profile, published on host port **8090**
   (container 8080), `CALM_HUB_BASE_URL=http://localhost:8090` (or the JAVA_OPTS property); MongoDB with **no
   published port**. Compose project name `calm-backstage` so the containers do not clash with other CALM stacks.
2. `hub/mongo/init-mongo.js`: a copy of the monorepo file, with a header comment naming its origin and commit.
   Consider seeding nothing from it beyond what the Hub needs (it also seeds demo namespaces/patterns; keep them only
   if harmless).
3. `hub/copy-schemas.sh` (or `.mjs`): copies `node_modules/@finos/calm-cli/dist/calm/release` into
   `hub/.schemas/release` (git-ignored). Add `@finos/calm-cli@1.71.0` as a root dev dependency so the copy and later
   steps share one CLI version. Run from `hub/seed.sh` or a root script before `docker compose up`.
4. Start the stack and wait for health. Read `http://localhost:8090/q/openapi` and record the exact request shapes
   for: create namespace, create pattern, create architecture, create domain, create control requirement and
   control configuration. Put the shapes you used in this file under "Hub API shapes (observed)".
5. `seed/`: write the content.
   - `seed/patterns/web-service.pattern.json`: our own pattern (namespace e.g. `hackathon`), $id under the Hub URL,
     with at least one `oneOf` decision (e.g. datastore: PostgreSQL or MongoDB) and one `anyOf` decision with
     three or more choices (e.g. add-ons: cache, message queue, observability). Keep it small: a service node, an
     API gateway or client, plus the decision targets. Include placeholders (`"[[ NAME ]]"` strings, `-1` numbers)
     where a developer must fill values.
   - `seed/architectures/*.json`: two architectures that conform to the pattern with different choices.
   - `seed/controls/`: one domain (e.g. `security`) with one or two control requirements and configurations, and
     the pattern/architectures referencing them.
   - `bundles/web-service/1.0.0/` and `bundles/web-service/2.0.0/`: a small bundle in the QCon format that renders
     a few files from the architecture (e.g. a README, a `docker-compose.yml` and a config file whose content
     depends on the chosen datastore and add-ons). v2 must render visibly different files (e.g. adds a file or
     changes the layout). Each bundle states the pattern it fits (e.g. a `calm-backstage.json` beside `index.json`
     with `patternId` and `version`, or a field in `index.json` if the CLI ignores unknown fields; verify).
6. `hub/seed.sh`: idempotent curl POSTs (re-running must not fail or duplicate); `set -euo pipefail`; prints what it
   created. Then verify:
   - `calm validate -p seed/patterns/... -a seed/architectures/<each> -f json` passes (use `-u` URL mapping if the
     $ids are Hub URLs, or validate against the Hub).
   - `calm generate -p http://localhost:8090/... -c http://localhost:8090 --option-choices '<json>'` produces an
     architecture; run it for two different choice sets and confirm the node lists differ.
   - `calm template -a <generated> -b bundles/web-service/1.0.0 -o <tmp>` and with 2.0.0; outputs differ.
   - GET the Hub list endpoints and show the seeded namespace, pattern, architectures, controls.
7. Root scripts in `package.json`: `hub:up` (copy schemas + compose up), `hub:seed`, `hub:down`. The one-command
   start for the README can be `yarn hub:up && yarn hub:seed`.
8. Leave the Hub running (later steps need it) but report the container names. Commit:
   `feat(hub): add CALM Hub compose, seed pattern, architectures, controls and bundle`.

## Risk gate

If the Hub does not start against the copied `init-mongo.js` (schema version mismatch, migration lock), or a write
endpoint's shape cannot be satisfied, stop and report the exact log lines or response. If `calm generate` cannot
resolve the Hub URLs, report the error before trying URL mappings.

## Done when

The Hub on 8090 lists the seeded namespace, pattern, two architectures and controls; validate passes for both
architectures; generate with two choice sets gives different results; template with v1 and v2 gives different files;
`hub/seed.sh` runs twice without error; one commit exists.

## Hub API shapes (observed)

Observed 2026-11-13 on `finos/calm-hub:latest` = calm-hub 0.7.7 (Quarkus 3.40.1.1), digest
`sha256:8a77fecea6146baf01d4f19f22d124e359589f427c236a0e33c280a83555d493` (image built 2026-11-13T15:00Z), profile
`no-auth`, `calm.hub.base-url=http://localhost:8090`. Source: `GET /q/openapi?format=json`. There is no `/q/health`
(404); `seed.sh` waits on `GET /api/calm/namespaces`.

The Hub has two write APIs over one store: the numeric `/api/calm/...` API (JSON wrappers, numeric ids) and the
name-based `/calm/...` API (raw CALM document, `$id` must equal the canonical URL under the base URL). We use the
name-based API for every document, so each `$id` is also a URL the CLI can GET.

Used by `hub/seed.sh`:

- Create namespace: `POST /api/calm/namespaces` body `{"name": "hackathon", "description": "..."}` (both required,
  name `^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$`). Duplicate: `409 {"error":"Namespace already exists"}`.
- Create domain: `POST /calm/domains` body `{"name": "hackathon-security"}` (`^[A-Za-z0-9-]+$`). Duplicate:
  `409 {"error":"Domain already exists"}`. List: `GET /calm/domains` → `{"values":["security", ...]}` (strings).
- Create control requirement: `POST /calm/domains/{domain}/controls/{controlName}/requirement/versions/{version}`,
  body = the raw requirement JSON Schema with `$id` = that same URL; first version must be `1.0.0`. Duplicate:
  `409 Version 1.0.0 already exists` (plain text).
- Create control configuration:
  `POST /calm/domains/{domain}/controls/{controlName}/configurations/{configName}/versions/{version}`, body = raw
  configuration with `$id` = that URL (we set `$schema` = the requirement URL). Duplicate: `409` as above.
- Create pattern / architecture: `POST /calm/namespaces/{ns}/{patterns|architectures}/{name}/versions/{version}`
  (or `POST /calm` with the same body), body = raw CALM document with `$id` = that URL and a `title` (required).
  First version must be `1.0.0` or `1.0.0-SNAPSHOT`. Duplicate:
  `409 Version 1.0.0 already exists for pattern 'web-service' in namespace 'hackathon'` (plain text).
- Idempotency: `seed.sh` GETs each document's `$id` first (200 = skip) and also treats a 409 as "exists".

Not used, for reference: numeric `POST /api/calm/namespaces/{ns}/patterns` body
`{"name","description","patternJson": "<string>"}`; `POST /api/calm/namespaces/{ns}/architectures` body
`{"name","description","architectureJson": "<string>"}`; `POST /api/calm/domains/{domain}/controls` body
`{"name","description","requirementJson": "<string>"}`; `POST /api/calm/domains/{d}/controls/{controlId}/configurations`
body `{"configurationJson": "<string>", "name"}`.

Read side (for step 3):

- `GET /api/calm/namespaces/hackathon/patterns` →
  `{"values":[{"customId":"web-service","description":"...","id":3,"name":"Web Service","versionCount":1}]}`;
  architectures the same shape (`id` 12 catalog-service, 13 orders-service). `name` is the document `title`,
  `customId` the name in the `$id`.
- `GET /calm/namespaces/{ns}/{patterns|architectures}` →
  `{"values":[{"customId":"web-service","namespace":"hackathon","numericId":3,"resourceType":"PATTERN"}]}`.
- `GET /calm/namespaces/hackathon/patterns/web-service/versions/1.0.0/implementations` →
  `{"implementations":[{"architectureId":12,"customId":"catalog-service","namespace":"hackathon","version":"1.0.0"},...],"pattern":{...}}`
  (the Hub links architecture → pattern by the architecture's `$schema`).
- `GET /api/calm/domains/{d}/controls` → `{"values":[{"id":42,"name":"permitted-connection","title":"Permitted Connection","description":"..."}]}`;
  `GET /calm/domains/{d}/controls/{name}/configurations` → `{"values":[{"id":3,"name":"https"}, ...]}`.
- `$id` on reads: the name-based GET of a pattern/architecture returns its `$id`; the numeric `/api/calm/...` GET
  returns the document without `$id`; control requirements and configurations come back without `$id` on both APIs.

## Results (2026-11-13)

CLI used for every result below: Homebrew `calm` **1.70.0** (`/opt/homebrew/bin/calm`), not the repository
dependency (see Deviations). Not yet repeated on the version that will be pinned.

- Pattern `hackathon/web-service` 1.0.0. Decisions: `datastore-choice` (oneOf: `PostgreSQL`, `MongoDB`) and
  `add-ons` (anyOf: `Cache (Redis)`, `Message queue (RabbitMQ)`, `Observability (OpenTelemetry)`). Add-on nodes
  and relationships sit in an `items.anyOf` catalogue. Placeholders: `api-gateway` interface `host`/`port`,
  `web-service` interface `port`, `web-service.metadata.owner`/`service-name`.
- `calm validate -p seed/patterns/web-service.pattern.json -f json`: no errors, no warnings.
- `calm generate -p <Hub URL> -c http://localhost:8090 --option-choices '{"datastore-choice":"PostgreSQL","add-ons":["Cache (Redis)","Message queue (RabbitMQ)"]}'`
  → 6 nodes, 7 relationships; with `{"datastore-choice":"MongoDB","add-ons":["Observability (OpenTelemetry)"]}`
  → 5 nodes, 6 relationships. Generated `$schema` = the pattern's Hub URL; no `$id`/`title` (seed adds them).
- Seed architectures `orders-service` and `catalog-service` are those two outputs with placeholders filled.
  `calm validate -p ... -a ... -c http://localhost:8090 -f json`: `hasErrors:false, hasWarnings:false` for both.
  Without `-c`, the control URLs fail: `Requests to private or internal network addresses are not allowed: localhost`.
- `calm template` with bundle 1.0.0 → `README.md docker-compose.yml config/application.yaml`; with 2.0.0 →
  `README.md Dockerfile deploy/docker-compose.yml config/application.yaml`. The CLI ignores unknown `index.json`
  fields (checked), but the bundle's pattern link lives in `calm-backstage.json` beside `index.json`.
- `hub/seed.sh` twice in a row: exit 0 both times (`10 already present` on the second run).

## Deviations

- `@finos/calm-cli@1.71.0` is not installed: Yarn's `npmMinimalAgeGate: 3d` rejects it
  (`YN0016: @finos/calm-cli@npm:1.71.0: All versions satisfying "1.71.0" are quarantined`; published
  2026-11-13T12:32Z). Adding it to `npmPreapprovedPackages`, or pinning 1.69.0, was refused by the session's
  permission check, so the decision is left to Jim. `hub/copy-schemas.sh` reads the package as planned; until the
  dependency lands, `hub/.schemas/release` was filled once by hand from the Homebrew 1.70.0 package, and
  `yarn hub:up` stops at copy-schemas.
- `init-mongo.js` aborts when its controls directory is missing (`Controls directory not found at /controls,
  skipping` then `TypeError: Cannot read properties of undefined (reading 'length')`; upstream
  `loadControlsFromDir` returns `undefined`). The copy is unmodified; compose mounts an empty `hub/mongo/controls`
  at `/controls` (`CALM_CONTROLS_BASE_PATH=/controls`). The upstream compose has the same bug.
- Seed documents use the Hub's name-based `/calm/...` API rather than `/api/calm/...`, so `$id`s are resolvable URLs.
- Domain `hackathon-security` (new) rather than the existing upstream-seeded `security`.
- `calm template -o <dir>` treats a directory name with a dot (`out-1.0.0`) as a file and writes to (and with
  `--clear-output-directory` empties) the parent directory. Use dot-free output directory names.
- The bundle transformer is an ES module; each bundle has a `package.json` with `"type": "module"` to silence
  Node's `MODULE_TYPELESS_PACKAGE_JSON` warning.
