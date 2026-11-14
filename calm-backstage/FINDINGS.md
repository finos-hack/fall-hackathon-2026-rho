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
- **The name-based write API refuses a generated architecture as it is** (found when `calm:register:hub` first
  posted one: `400: 'title' is required in the document body`). A document needs a non-blank `title`, and
  `calm generate` gives none, so the action adds the service name as `title` and a `description`. From the Hub source
  (`MappingControllerResource`, `CalmDocumentParser`, monorepo `c7ce7fe1a`; not all tried against the 0.7.7 image):
  the name must start with a letter (`^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*$`), so the Template's name field now
  asks for that; the body's `$id` must equal the canonical URL of the version in the path; and the first version of
  a new resource must be `1.0.0`. Request: say in the OpenAPI what a posted document must hold.
- **A document is not returned byte for byte:** `$id` is taken out on write and added at the end on read. Everything
  else came back equal, so "the same document" is a comparison of JSON values, not of text.
- **Decorators** (`/api/calm/namespaces/{ns}/decorators`, only on the numeric API): `POST` answers
  `201 {"id": n}`. They are **written in kebab case and read in camel case**: the Hub stores `unique-id`,
  `target-type` and `applies-to` and returns `uniqueId`, `targetType`, `appliesTo` and `schema` (for `$schema`);
  `data` comes back as posted, and the body has no id. `normaliseDecorator` reads both shapes. Request: return what
  was posted.
- **The decorator `target` filter matches a whole entry and refuses URLs.** `?target=` must match
  `^[A-Za-z0-9_/.-]+$` (a `:` gives 400) and is compared with each entry of `target` exactly, so a prefix finds
  nothing. A deployment decorator therefore names its architecture version by the path
  `/calm/namespaces/<ns>/architectures/<name>/versions/<v>`, not by its `$id`. `…/decorators/values` returns the
  decorators without their ids, so the card lists the ids and reads each one.
- **The Hub's own UI finds an architecture's decorators by a different target.** Its Deployments tab asks for
  `target=/api/calm/namespaces/<ns>/architectures/<numeric id>/versions/<version with hyphens>` (for example
  `…/architectures/16/versions/1-0-0`). A decorator that names only the name-based path shows "No deployment history
  found" there. `calm:decorate:deployment` therefore puts both entries in `target`. Request: one documented target
  form for an architecture version, accepted by the API and used by the UI.
- **Nothing in the Hub says who put an architecture there.** A service's architecture is marked in its own
  `metadata` (`"calm-backstage": { "entity": "component:default/<name>" }`), so the catalog provider can leave it to
  the service's entity and `calm:register:hub` can refuse to add versions to someone else's architecture.
  `calm validate` passes with the marker, in object and in list `metadata`.

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
- **A scaffolder step's `if:` runs the step when the expression fails to render.** The scaffolder renders with
  `nunjitsu`; a render error leaves a non-empty string, which counts as true. The build and deploy conditions were
  evaluated with that renderer before use.
- **A step that needs something outside Backstage should check it first.** Without the cluster, a run failed at the
  image build after it had stored the architecture in CALM Hub and published the files. `calm:cluster:check` now
  runs first, under the same condition as the build and deploy steps.
- **`calm:publish:local` does not overwrite a folder**, so a second run for the same service name fails at publish
  (after `calm:register:hub`, which reuses the stored version). Redeploying an existing service is not built.

## Kubernetes

- **A default-deny NetworkPolicy also blocks DNS.** The bundle adds `allow-dns` (egress to kube-system on 53);
  without it a lookup by Service name fails and looks like a policy fault.
- **A blocked connection times out; it is not refused.** Checks use `nc -z -w 3`.
- **minikube's docker driver can give the API server a new port on each start.** `k8s/up.sh` rewrites
  `app-config.local.yaml` every time, and Backstage needs a restart after it.
- **Policies need a CNI that enforces them.** The profile is started with `--cni=calico`.
- **An image built into minikube needs a tag other than `latest` and `imagePullPolicy: IfNotPresent`**, or the pod
  tries to pull it.
- **`hub/push-bundles.cjs` loads a TypeScript file through Node's type stripping**, which Node 22 before 22.18
  does not do by default. It was run on Node 26 only.

## Part 3 (2026-11-14): Git, Flux, starters, Nisshi

Versions: Gitea 1.27.3, Flux v2.10.0 (source and kustomize controllers only), Spring Boot 4.0.9 and 4.1.2, Red Hat
build of Quarkus 3.33.4 and 3.40.1 (BOM `com.redhat.quarkus.platform:quarkus-bom`), Nisshi 0.8.1 and 0.8.2, kafkajs
2.2.4.

### Git and Flux

- **Flux without its CLI works from the release manifest.** `k8s/flux-install.cjs` keeps every CRD and only the
  source and kustomize controllers. Without the notification controller, each controller retries every event five
  times (about 15 s per reconcile) unless `--events-addr` is removed; it is.
- **Flux in minikube reaches a Compose container through `host.minikube.internal`** and the published port; the two
  are on different Docker networks. So Gitea must listen on the host's interfaces, not only on loopback.
- **Ask for a reconcile with the annotation `reconcile.fluxcd.io/requestedAt`**, then wait until the Kustomization is
  Ready with `status.lastAppliedRevision` naming the pushed commit (`main@sha1:<sha>`). Ready alone can still be the
  previous commit.
- **Write files a GitOps step rewrites byte for byte the same.** Two actions wrote the overlay with different header
  comments, so every upgrade made one extra commit. They now share one header.
- **Merge before you deploy, and build before you merge.** The upgrade builds the image from the upgrade branch and
  puts its tag in the overlay on that branch, so `main` only ever holds a complete upgrade and the merge commit is
  what Flux applies. A failed build leaves `main`, Gitea and the cluster untouched.
- **Gitea creates a repository on the first push** into an organisation (`ENABLE_PUSH_CREATE_ORG`), and refuses to
  merge a new pull request until it has checked it can be merged (405 "try again later"); the merge is retried.
- **GitHub is not a drop-in.** Push-to-create, the pull request API and anonymous reads by Flux are Gitea's. The Git
  host sits behind `GiteaClient`; a GitHub client is a track.

### Template bundles

- **Two kinds of bundle make upgrades separable.** A starter renders the code and its Dockerfile; deployment rules
  render `deploy/k8s` from the architecture alone. They meet in a small contract (`$PORT`, `/health`, the image name
  `calm-service`, `CALM_*` environment variables), so one set of rules serves Node, Spring, Quarkus and Nisshi.
- **A published version never changes, so a fix is a new version.** `k8s-deploy` 1.2.0 and `nisshi-stream-app`
  1.0.1 exist because 1.0.0/1.1.0 were already published when a bug was found, and 1.2.1 because 1.2.0 had one too;
  `push-bundles` refuses changed content before anything reaches Gitea.
- **Deployment rules must apply over their own older versions, not only to a new namespace.** 1.2.0 set
  `strategy: Recreate` on backing services. A new deployment took it; an upgrade from 1.0.0 did not: Kubernetes
  refuses Recreate while the Deployment holds `rollingUpdate` settings, and server-side apply (Flux) cannot remove
  them, even with `rollingUpdate: null`. Flux reported it and the upgrade failed cleanly after its merge. 1.2.1 uses
  `RollingUpdate` with `maxSurge: 0` instead (the old pod stops first), which applies over 1.0.0. A test that
  upgrades from every older version of a deployment bundle would have caught it.
- **Handlebars reads `${PORT:{{port}}}` as a triple-stash** and stops rendering. Transformers give such values whole.
- **An upgrade re-renders, it does not merge.** Files the old starter rendered are replaced; files the developer
  added stay. Edits to rendered files are overwritten (the pull request shows it). A three-way merge is the next step.
- **Java builds in `minikube image build` are fine with a BuildKit cache mount.** Spring Boot: 96 s cold, 2 s after a
  code change, 13 s after a Boot upgrade. Red Hat Quarkus: 454 s cold (the Red Hat Maven repository), 109 s for a new
  platform version on a warm cache.
- **The Red Hat build of Quarkus BOM and the UBI images need no login**; the UBI OpenJDK builder image ships Maven
  and runs as uid 185 (the `.m2` cache mount needs `uid=185`).

### Nisshi

- **kafkajs works against Nisshi** (topics, produce, consumer groups). The broker's advertised listener must be its
  in-cluster name (`ADVERTISED_LISTENER_URL=tcp://nisshi-broker:9092`).
- **A broker on SQLite in the pod loses its topics when it restarts**, and a rolling update briefly runs two brokers.
  The rules roll out backing services with `Recreate` (1.2.0) and the app creates its topic again (1.0.1).

### Backstage

- **A proxied app page needs its own Content-Security-Policy.** Backstage's default (no inline scripts,
  `upgrade-insecure-requests`) left the starters' page empty in a browser while `curl` showed it fine.
- **Security, open (local development only):**
  - `/api/calm/app/*` is unauthenticated (a new tab carries no Backstage token) and serves the app on the backend's
    origin, so the app's script is same-origin with Backstage's APIs. Use `user-cookie` auth or a separate origin.
  - Anyone who can push to a service repository in Gitea (port 3300, fixed admin password) can apply anything
    through Flux, which runs as cluster-admin. Give each Kustomization a namespaced service account and
    `targetNamespace`, and seed a random password.
- **A `PageBlueprint` gets a sidebar item from the plugin's `title` and `icon` and a `routeRef`**, not from the page's
  own title.
