# Tracks for Monday 2026-11-16

The base works end to end: CALM Hub → catalog → entity pages → create a service from a pattern with options → render
with a template bundle → publish to `output/` → register. Each track below can start from it without waiting for
the others. Pick one, branch from `main`, keep to its folders where you can, and add tests for what you change.

How it fits together (details in `README.md` and `docs/superpowers/specs/2026-11-13-calm-backstage-design.md`):

| Package | Role |
|---|---|
| `plugins/calm-common` | Types, annotation names, entity names, options reader, placeholder scanner, Hub client, Mermaid transform |
| `plugins/calm-node` | Runs the published `@finos/calm-cli` (generate, validate, template) |
| `plugins/calm-backend` | Routes `/placeholders`, `/architecture`, `/pattern` |
| `plugins/catalog-backend-module-calm` | Entity provider: architectures, patterns, controls, bundles, one Template per pattern |
| `plugins/scaffolder-backend-module-calm` | `calm:generate`, `calm:fill`, `calm:validate`, `calm:template`, `calm:publish:local`, `calm:register:local` |
| `plugins/calm` | Frontend: entity cards, `CalmPlaceholders` form field |
| `hub/`, `seed/`, `bundles/` | CALM Hub in Docker, seed content, template bundles |

Read `FINDINGS.md` before you start: it lists the CLI and Hub behaviours that will catch you out.

## A. Catalog

Scope: decorators, flows, versions, pattern → architecture "implementations", refresh on change.

- Start at `plugins/catalog-backend-module-calm/src/{provider,entities}.ts`.
- The provider takes the latest version of each pattern and architecture. Show every version, or link versions.
- The Hub has `GET /calm/namespaces/{ns}/patterns/{p}/versions/{v}/implementations`; use it for pattern →
  architecture relations instead of reading `$schema`.
- Flows and decorators are not in the catalog yet.
- Refresh is a 60 s full mutation. Look at a delta mutation, or a Hub event, if the Hub offers one.
- Entity names drop the Hub namespace; a clash across namespaces is dropped with a warning.

## B. Entity page

Scope: a better diagram (ReactFlow or CALM's own renderer), controls status, a flows tab.

- Start at `plugins/calm/src` (cards) and the Mermaid transform in `plugins/calm-common`.
- The diagram is Mermaid from our own transform (FINDINGS R3). A richer view could reuse CALM's own renderer once it
  is published.
- Controls are listed, not checked. A status view needs evidence (CALM has `evidence.json` in the schema).

## C. Pattern options

Scope: `anyOf` UX, option descriptions, a review step, nested patterns.

- Start at `plugins/calm-common/src/options.ts` and the Template parameters in `entities.ts`.
- Choices show the decision description only. Patterns could carry richer text per choice.
- `anyOf` is optional (the CLI asks only for `oneOf`). Decide whether a pattern can require at least one.
- Placeholders answered before a choice change are kept by JSON Pointer; with placeholders on optional nodes an
  answer could land on the wrong value (`plugins/calm/src/components/CalmPlaceholdersField.tsx`).
- The seed pattern's placeholders are all on fixed nodes. Add a pattern where choices change the placeholder list.
- Nested patterns and `$ref`'d decisions are untested.

## D. Template bundles

Scope: where bundles live (Git, npm, CALM Hub), versions, "bundle update available", transformers.

- Bundles are folders named in `app-config.yaml` `calm.bundles`, each with `calm-backstage.json` saying which
  pattern it fits. Bundle fit ignores the pattern version.
- Published services record `calm.finos.org/bundle` and `/bundle-version`, which is enough to show "bundle update
  available" when a newer bundle fits the same pattern.
- `calm template` has no `-c` option (control look-ups warn), and dotted output folder names misbehave.

## E. Publish

Scope: GitHub publish, dry run, register the architecture in the Hub.

- Today `calm:publish:local` writes `output/<name>/` and `calm:register:local` adds a file location.
- Swap in `publish:github` + `catalog:register` (url location) for a real repository; no GitHub credentials are set up.
- The generated architecture has no `$id` and is not in the Hub. Registering it (namespace `hackathon`, name-based
  API, see FINDINGS) would let the architecture card read it from the Hub like the seeded ones.
- `calm:generate`, `calm:fill`, `calm:validate` support dry runs; the template editor's dry run can use them.

## F. Provisioning

Scope: connect the `~/business/sp` flow as an extension.

- Out of scope for the base. The spike in `~/business/sp/backstage` used the same Backstage version and shows the
  portal and GitHub flows; reuse ideas, not code paths, and keep its ports (3000/7007, Hub 8088) clear of ours.
