# CALM Backstage: hackathon base

## Context

The CALM hackathon needs a first step toward developer integration. The target is Backstage: a developer sees CALM
architectures in the catalog, sees the architecture on a service page, and creates a new service from a CALM pattern,
with the pattern's options as form choices. Template bundles decide what code the pattern renders.

Jim and Claude build a clone-and-run base now. A bigger team can join on Monday 2026-11-16, so the base must be thin
and the remaining work must be cut into independent tracks. The provisioning work in `~/business/sp` is a later
extension, not part of this plan.

## Decisions

| Topic | Decision | Whose |
|---|---|---|
| Home | New repository `~/finos/calm-backstage`, local `git init` only | Jim |
| Start point | Clean start. The spike in `~/business/sp/backstage` is a source of Backstage API facts only | Jim |
| CALM logic | Published packages only: scaffolder actions shell out to `@finos/calm-cli` | Jim |
| Must-have demo | Catalog from CALM Hub, architecture on the entity page, create from a pattern with options | Jim |
| Explore | Pattern options, template bundle management | Jim |
| Node | Try Node 26 first; use Node 24 if a native module fails. Record the result in the README | Claude |
| Options form | The catalog provider emits one `Template` per Hub pattern; options are static form parameters | Claude |
| Placeholders | A custom form field asks the backend, which runs `calm generate` and returns the placeholder list | Claude |
| Diagram | Mermaid in the browser from a small transform. No unpublished CALM package | Claude |
| Publish step | Local folder output (`calm:publish:local`). No GitHub credentials needed | Claude |
| Bundles, first slice | Folders in the repository, named in `app-config.yaml`, shown as catalog entities, chosen in the form. Each bundle states which pattern it fits; a pattern's Template offers only those | Claude |
| Seed content | Our own pattern with a `oneOf` and an `anyOf` decision, and our own small bundle in two versions. No demo pattern in the monorepo has options, and the QCon bundles fit only the trades architecture (format reference only) | Claude |
| Tests | Unit tests for the `calm-common` readers against the CLI's fixtures (`shared/test_fixtures/command/validate/options/pattern.json`), because drift from `calm generate` is the cost of published-only. No other tests in the thin slice; the tracks add them | Claude |

Approaches considered for CALM logic: published packages only (chosen), vendored tarballs of `calm-shared` and
`calm-diagram`, links to the sibling checkout. Published-only has no blocker. It makes us write three small parts:
a pattern-options reader, a read-only Hub client, a Mermaid transform. Each one goes in `FINDINGS.md` as a request
to the CALM project.

## Boundaries

- No writes to `~/business/sp`. Its Backstage runs on 3000/7007 and its Hub on 8088: use other ports (Backstage
  3100/7107, Hub 8090).
- No GitHub repository, push, or upstream issue without Jim's confirmation.
- No Claude attribution in commits. Conventional Commits.

## What approval covers

- The new folder `~/finos/calm-backstage` with a local Git repository, and `yarn`/`npm` installs in it.
- Docker containers for CALM Hub and MongoDB (Hub on 8090; the MongoDB port is not published).
- `brew install node@24`, only if the Node 26 check fails.
- Next step after approval: `superpowers:writing-plans` cuts steps 3 and 6 into smaller tasks.

## Repository layout

```
calm-backstage/
  packages/app, packages/backend        # from @backstage/create-app (new frontend and backend systems)
  plugins/calm-common                   # types, annotation names, options reader, placeholder scanner, Mermaid transform
  plugins/calm-backend                  # Hub client; routes /architecture, /placeholders, /bundles
  plugins/catalog-backend-module-calm   # entity provider: architectures, patterns, controls, bundles, Templates
  plugins/scaffolder-backend-module-calm# calm:generate, calm:fill, calm:validate, calm:template, calm:publish:local
  plugins/calm                          # frontend: entity card, CalmPlaceholders form field
  hub/docker-compose.yml, hub/seed.sh   # finos/calm-hub:latest (no-auth) + MongoDB, seeded with curl
  seed/                                 # one pattern with a oneOf and an anyOf decision, two architectures, controls
  bundles/<name>/<version>/             # template bundles (start from conferences/qcon/scenario4/bundle-v1 and v2)
  docs/superpowers/specs/2026-11-13-calm-backstage-design.md
  FINDINGS.md, TRACKS.md, README.md
```

## Facts to build on

- CLI: `calm generate -p <file|Hub URL> -c <hubUrl> --option-choices <json|file>`; `calm validate -p -a -f json`;
  `calm template -a -b <bundleDir> -o <dir> [-u map.json]`. Verified on the local 1.70.0 help; check again on the
  installed npm version.
- A decision is a pattern relationship whose `relationship-type.properties.options.prefixItems[]` has `oneOf` or
  `anyOf`. Reference: `shared/src/commands/generate/components/options.ts`, `PATTERN-DECISIONS.md`.
- Placeholders: `"[[ NAME ]]"` strings and `-1` numbers (`shared/src/commands/generate/components/property.ts`).
  No CLI command fills them, so `calm:fill` is ours. Key them by JSON path.
- Hub read API: `/api/calm/namespaces`, `/api/calm/namespaces/{ns}/{architectures|patterns}[/{id}/versions[/{v}]]`,
  `/api/calm/domains/{d}/controls/...`. Lists are `{values: [...]}`. Model the client on
  `calm-plugins/vscode/src/extension/services/hub-client.ts`.
- Hub start-up reference: `calm-hub/deploy/docker-compose.yml`, `calm-hub/mongo/init-mongo.js`.
- Backstage 1.56 APIs (read from the spike's `node_modules`): `catalogProcessingExtensionPoint.addEntityProvider`,
  `scaffolderActionsExtensionPoint.addActions`, `createTemplateAction`, `executeShellCommand`,
  `EntityCardBlueprint` and `FormFieldBlueprint` (both alpha), `formContext.formData` for earlier form steps,
  `catalogServiceRef.addLocation` with `setAllowedLocationTypes(['url','file'])`. The backend needs
  `plugin-catalog-backend-module-scaffolder-entity-model`.

## Thin slice (in order; each step removes one risk)

1. **Repository and app.** `git init`, `create-app`, ports (check that 3100, 7107 and 8090 are free). Copy this
   design to `docs/superpowers/specs/`. Node 26 check: install, build, start, and run one scaffolder template
   (the template run loads `isolated-vm`; a start alone does not prove it). Risk: Node version.
2. **Hub and seed.** Risk: clone-and-run, Hub write API shapes.
   - Compose: `finos/calm-hub:latest` (`no-auth`) and MongoDB, with `CALM_HUB_BASE_URL=http://localhost:8090`
     so that `$id`, `$schema` and control URLs resolve for the CLI.
   - Mongo init: a committed copy of `calm-hub/mongo/init-mongo.js` (origin noted). A script copies the release
     schemas from the `@finos/calm-schema` npm package to the folder that `CALM_RELEASE_SCHEMA_PATH` names. No
     monorepo checkout is necessary.
   - `seed.sh` uses the Hub POST endpoints (namespace, pattern, architecture, domain, control requirement and
     configuration). Check each shape against the running image's `/q/openapi` first: the local checkout is
     behind `latest`.
   - Write the seed pattern, two architectures that conform to it, the controls, and the bundle (two versions).
3. **Catalog provider.** Architectures as `Component`, patterns and controls as `Resource`, with relations and
   `calm.finos.org/*` annotations. One `Template` per pattern, with a `choices` parameter (`oneOf` → enum,
   `anyOf` → array of enum). Risk: provider-emitted Templates appear on `/create`.
4. **`calm:generate`.** Resolve the CLI bin from the module dependency, run with `--option-choices`.
   Risk: bin resolution, the exact choices JSON.
5. **Placeholders.** Backend `/placeholders` runs generate in a temp folder and scans the result; the
   `CalmPlaceholders` field shows the inputs. Risk: alpha form-field API.
6. **Finish the run.** `calm:fill`, `calm:validate`, `calm:template` with the chosen bundle,
   `calm:publish:local`, register the new entity. Risk: file locations.
7. **Entity pages.** Architecture card: pattern and version, controls, Mermaid diagram from `calm-backend`.
   Pattern card: its decisions and choices (from the options reader), the bundles that fit, and a link to its
   Template. Risk: Mermaid in Backstage.
8. **Hand-over.** `README.md` (one command to start), `FINDINGS.md`, `TRACKS.md`.

If a risk step fails, stop and report with the alternative (for step 3: one generic template with a field that
fetches options; for step 6: write `catalog-info.yaml` only and show the path).

## Tracks for Monday (`TRACKS.md`)

| Track | Scope |
|---|---|
| A. Catalog | Decorators, flows, versions, pattern → architecture "implementations", refresh on change |
| B. Entity page | Better diagram (ReactFlow or CALM's own renderer), controls status, flows tab |
| C. Pattern options | `anyOf` UX, option descriptions, review step, nested patterns |
| D. Template bundles | Where bundles live (Git, npm, CALM Hub), versions, "bundle update available", transformers |
| E. Publish | GitHub publish, dry run, register the architecture in the Hub |
| F. Provisioning | Connect the `~/business/sp` flow as an extension |

## Verification

- `docker compose -f hub/docker-compose.yml up -d && hub/seed.sh`, then `yarn start`: one documented command each.
- Catalog at `http://localhost:3100/catalog` lists the seeded architectures, patterns and controls; the graph
  shows architecture → pattern → controls.
- An architecture's page shows the CALM card with a diagram.
- `/create` shows the seed pattern; a run with one `oneOf` choice and two `anyOf` choices asks for the
  placeholders, passes `calm validate`, and writes rendered files under the output folder. The files differ
  between bundle v1 and v2, and between two different option choices.
- A pattern's page lists its decisions and choices.
- `yarn test` passes for `calm-common`.
- `yarn tsc` and `yarn build:backend` pass. Playwright screenshots of the three screens go in `docs/demo/`.
