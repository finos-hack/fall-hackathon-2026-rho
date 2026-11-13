# Findings

What building the hackathon base (2026-11-13) taught us about CALM, CALM Hub and Backstage. Each entry says what we
found, what we did here, and, where it applies, a request to the CALM project. Nothing here has been raised upstream
yet: issues wait for a maintainer's decision.

Versions: `@finos/calm-cli` 1.71.0, `finos/calm-hub:latest` (0.7.7, image built 2026-11-13), Backstage 1.56.0,
Node 26.13.1.

## Requests to the CALM project

The base uses published packages only. That meant writing small parts that CALM already has in unpublished form.
Each is a candidate for a published, supported API.

| # | What we wrote | Where | Request |
|---|---|---|---|
| R1 | Pattern options reader: which relationships are decisions, their `oneOf`/`anyOf` kind and choices | `plugins/calm-common/src/options.ts` (mirrors `shared/src/commands/generate/components/options.ts` at monorepo `c7ce7fe1a`, CLI 1.67.0) | Publish the reader (or a `calm generate --list-options -f json`), so tools stop copying CLI logic that can drift |
| R2 | Read-only CALM Hub client | `plugins/calm-common/src/hubClient.ts` (modelled on the VS Code extension's hub client) | A published Hub client package, shared by the VS Code extension, Backstage and others |
| R3 | CALM → Mermaid transform (nodes by type, `connects` edges with protocol, flat `composed-of`/`deployed-in` as subgraphs) | `plugins/calm-common/src/mermaid.ts` | Publish the diagram transform the CALM tools already use, or a `calm diagram -f mermaid` command |
| R4 | Placeholder scanner and filler (`"[[ NAME ]]"` strings, `-1` numbers) | `plugins/calm-common/src/placeholders.ts` | A `calm fill` command, or a published API, that lists and fills the placeholders `calm generate` leaves |

## CLI

- **`calm validate` needs `-c <hubUrl>` for localhost control URLs.** Without it, control requirement URLs on
  `http://localhost:8090` fail with "Requests to private or internal network addresses are not allowed: localhost".
  `calm:validate` always passes `-c`.
- **`calm template` has no `-c` option**, so its look-ups of the same control URLs log that error as warnings.
  Rendering still works because our bundles don't use controls. Request: accept `-c` on `template` as on
  `generate` and `validate`.
- **`calm template -o` treats a directory name containing a dot as a file path.** `-o out/orders-service-1.0.0`
  writes into `out/`, and with `--clear-output-directory` empties it. `calm:template` refuses dotted folder names.
  Request: decide file vs directory from the bundle mode, not the name.
- **The CLI writes progress and errors to stderr, with ANSI colour even when piped.** `runCalm` strips colour and
  keeps the last 20 stderr lines for error messages.
- **`--option-choices` works well for automation:** a JSON object of decision id → choice description (string for
  `oneOf`, array for `anyOf`). An invalid choice fails with "The choice of [Oracle] is not a valid choice for option
  [datastore-choice]." The CLI asks for an answer only for `oneOf` decisions, so `anyOf` is optional.
- **Generated architectures have no `$id`**, so a bundle that prints the architecture's `$id` prints nothing.
- 1.69.0, 1.70.0 and 1.71.0 gave the same `generate` result for our pattern.

## CALM Hub

- **`init-mongo.js` crashes when `/controls` is missing:** "Controls directory not found at /controls" followed by
  `TypeError: Cannot read properties of undefined (reading 'length')`. The upstream `calm-hub/deploy/docker-compose.yml`
  does not mount `/controls`, so it likely has the same bug (not run). Here, compose mounts an empty
  `hub/mongo/controls` and sets `CALM_CONTROLS_BASE_PATH`. Request: return an empty list instead of `undefined`.
- **Two write APIs.** The numeric `/api/calm/...` API returns documents without `$id`; the name-based
  `/calm/namespaces/{ns}/{patterns|architectures}/{name}/versions/{v}` API keeps `$id`, which the CLI needs to
  resolve references. The seed uses the name-based API; namespaces can only be created through `/api/calm/namespaces`.
- **Control requirements and configurations come back without `$id`** on both APIs.
- **`calm.hub.base-url` is defined only in `application-oidc.properties`.** Under the `no-auth` profile we also pass
  `-Dcalm.hub.base-url=http://localhost:8090` so `$id`s use the published port.
- **There is no `/q/health`** in the image; `seed.sh` waits on `/api/calm/namespaces`.
- **The image seeds upstream demo namespaces** (finos, workshop, traderx, qcon, …). The catalog provider reads only
  the namespaces in `calm.namespaces`.
- **Versions are immutable** (`409 Version 1.0.0 already exists`). With the named MongoDB volume, changes to seed
  files need `docker compose -f hub/docker-compose.yml down -v` before re-seeding.

## Backstage

- **`@backstage/create-app` 0.9.3 refuses Node 26** (a version-string check). The app was scaffolded on Node 22;
  install, build and run use Node 26. `isolated-vm`, which the spec named as the Node 26 risk, is not in Backstage
  1.56 at all; `better-sqlite3` is the native module that was built and loaded.
- **The repo's Yarn age gate (`npmMinimalAgeGate: 3d`) quarantined `@finos/calm-cli` 1.71.0** on its release day.
  `.yarnrc.yml` pre-approves `@finos/calm-cli` (decided by Jim, with a comment there).
- **Provider-emitted Templates work.** `catalog.rules` only apply to entities from locations, so the CALM provider's
  `Template` entities need no rule.
- **`catalog:register` always adds a `url` location**, and the catalog's real default for allowed location types is
  `['url']` (the extension point's doc says "url" and "file"). The CALM catalog module allows `file`, and
  `calm:register:local` adds the file location itself.
- **The alpha `FormFieldBlueprint` works** with only a package dependency in `packages/app`. `required` on an object
  field does not block the Review step (the form fills `{}`), so `CalmPlaceholders` validates its own values; tasks
  sent through the API skip field validators, so `calm:fill` refuses open placeholders.
- **`executeShellCommand` rejects with the exit code only**, so the CALM actions use their own `spawn` to keep stderr.
- **Hyphenated parameter names** need `parameters["add-ons"]` in template expressions.
- **The default catalog database is in memory.** Published services come back after a restart through a file glob
  location over `output/*/catalog-info.yaml`.
