# Tracks for Monday 2026-11-16

The base works end to end: CALM Hub → catalog → entity pages → create a service from a pattern with options → store
its architecture in CALM Hub → render with a template bundle from the OCI registry → publish to `output/` → build
and deploy to a local Kubernetes cluster → record the deployment in CALM Hub → register. Part 3 added starters
(Node, Spring Boot, Red Hat Quarkus, Nisshi) and deployment rules as separate bundles, one Gitea repository per
service deployed by Flux, upgrades of code and deployment rules through pull requests, a Template Explorer and an
"Open the running app" button. Each track below can start from it without waiting for the others. Pick one, branch from `main`, keep to its folders where you can, and add tests for what you change.

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

- Done (part 3): starters and deployment rules as two kinds of bundle (`calm-backstage.json` `kind`, `patterns`);
  bundles are published from the Gitea repository `calm-templates/bundles` with their source and revision as OCI
  annotations, and a published version never changes; the Template Explorer shows files, sources, diffs and who uses
  what; "update available" is on the service card with an Upgrade Template.
- Left (part 3): an upgrade overwrites the files the starter rendered (no three-way merge of a developer's edits);
  a bundle is published from Git by a script, not by a Backstage action; bundles fit patterns by id only.
- Done: bundles are OCI artifacts in a local registry (`localhost:5050/calm-bundles/<name>:<version>`, pushed with
  `yarn bundles:push`); the catalog lists them and `calm:template` pulls them by digest. `calm-backstage.json` says
  which pattern a bundle fits and whether it can be deployed. Bundle fit ignores the pattern version.
- Left: a registry with TLS and authentication (the client has neither), signed bundles, and bundles from Git or
  npm.
- Published services record `calm.finos.org/bundle` and `/bundle-version`, which is enough to show "bundle update
  available" when a newer bundle fits the same pattern.
- `calm template` has no `-c` option (control look-ups warn), and dotted output folder names misbehave.

## E. Publish

Scope: GitHub publish, dry run, register the architecture in the Hub.

- Done: the generated architecture is stored in CALM Hub (`calm:register:hub`), the service is built and deployed
  to the local minikube (`calm:image:build`, `calm:deploy:k8s`) with NetworkPolicies from its `connects`
  relationships, and the deployment is recorded as a decorator (`calm:decorate:deployment`). A failed deployment is
  recorded too: `calm:deploy:k8s` and `calm:deploy:gitops` take `record` and, when the deploy fails after it started,
  post a `failed` decorator (applies to the nodes the rendered workloads are labelled with, the error in the notes)
  and rethrow the error.
- Done: the gateway reaches the service over TLS, as the architecture's HTTPS relationship says. The deployment rules
  `k8s-deploy` 1.3.0 put an nginx sidecar on 8443 in front of the destination of an HTTPS relationship inside the
  cluster, with a certificate cert-manager issues from a self-signed CA in the namespace; the gateway checks it, and
  the network policies allow 8443. `yarn k8s:up` installs cert-manager v1.16.2. To use it: push the bundle
  (`yarn bundles:push`) and recreate the cluster (`yarn k8s:down`, `yarn k8s:up`), or run `yarn k8s:up` again on it.
- Left:
  - An existing service cannot be redeployed: `calm:register:hub` and `calm:publish:local` refuse a name whose
    folder exists.
  - The Hub write happens after the render and the publish and before the git publish (`calm:register:hub` in
    `prepare` mode first, in `store` mode then), so a run that fails in the render or the publish leaves nothing in
    the Hub. `prepare` checks the catalog and the output folder, so a clashing name writes nothing. `store` stores
    the prepared file as the version its `$id` names (an identical document at that version is reused, another one
    fails), and first checks that the published `architecture.json` is that file. When the store step fails before a
    version was written (the Hub unreachable or answering an error, the catalog or Hub name taken in between, a
    different document at that version, a published file that differs) or in the POST itself (the Hub may or may not
    hold the version then; a rerun with the same document reuses it), nothing is in Git yet and it removes the
    service folder this run published (`publishedDir`, only `<localDir>/<name>` with the same `$id`), so the Template
    can be run again. A workspace file without a prepared `$id` fails with the folder kept, and so does a failed
    read-back after a POST that worked (the version exists). A failure after the store (git publish, build, deploy)
    still leaves the stored version, which cannot be deleted (a rerun with the same document reuses it), and the
    published folder, so a rerun with that name is refused.
  - `calm:image:build`, `calm:deploy:k8s` and `calm:decorate:deployment` have no dry run: in a dry run the
    scaffolder skips the publish step they depend on.
- `calm:publish:local` still writes `output/<name>/` and `calm:register:local` adds a file location.
- Done (part 3): services are pushed to Gitea and deployed by Flux (`calm:git:publish`, `calm:deploy:gitops`); the
  card shows the Flux status and the commit applied; upgrades go through a merged pull request.
- Left (part 3): a GitHub client next to `GiteaClient` (push-to-create, pull requests and anonymous Flux reads are
  Gitea's); a namespaced service account and `targetNamespace` per Flux Kustomization (Flux runs as cluster-admin, so
  anyone who can push to Gitea controls the cluster); `user-cookie` auth or a separate origin for the app proxy
  (FINDINGS, part 3, Security).
- Swap in `publish:github` + `catalog:register` (url location) for a real repository; no GitHub credentials are set up.
- `calm:generate`, `calm:fill`, `calm:validate` support dry runs; the template editor's dry run can use them.

## F. Provisioning

Scope: connect the `~/business/sp` flow as an extension.

- Out of scope for the base. The spike in `~/business/sp/backstage` used the same Backstage version and shows the
  portal and GitHub flows; reuse ideas, not code paths, and keep its ports (3000/7007, Hub 8088) clear of ours.
