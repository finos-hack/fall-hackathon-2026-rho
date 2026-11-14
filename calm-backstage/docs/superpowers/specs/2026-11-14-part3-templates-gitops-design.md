# CALM Backstage part 3: template explorer, upgrades through GitOps, starters, Nisshi

## Intent

Show what CALM + Backstage + template bundles give a developer and a platform team together:

- **CALM** says what the system is (pattern → architecture, controls, relationships).
- **Backstage** is the one place the developer works: create, see, upgrade.
- **Template bundles** carry two kinds of rules: *starters* (the code a service begins with) and *deployment rules*
  (how any service is deployed: workloads, network policies from CALM relationships, hardening).
- **Upgrades are easy on both sides**: a newer starter upgrades the code, a newer set of deployment rules upgrades
  how it runs, and both reach the cluster through Git (GitOps), with a record in CALM Hub.

Every deployed service must visibly work: Backstage opens the running app.

Jim asked for this on 2026-11-14 and is away; he asked Claude to decide, consult the advisor, and only escalate
something serious. Every decision below is Claude's unless marked otherwise.

## Goals

1. **Template Explorer** page in Backstage: every bundle and version in the OCI registry, what is inside each one
   (its files, its OCI reference, digest and annotations), the Git repository and commit it was published from (where
   to make a change), what changed between two versions, and which services use it, with an upgrade status.
2. **Upgrade flow**: a service page says when its starter or its deployment rules have a newer version. One
   Backstage action upgrades either or both: re-render, open and merge a pull request in the service's Git repository,
   rebuild the image when the code changed, and let Flux redeploy. The new deployment is recorded in CALM Hub.
3. **GitOps** for every deployment: a service's repository holds its code and `deploy/`; Flux in the local cluster
   applies `deploy/k8s-overlay` from Git. Backstage shows the Flux status and the applied commit.
4. **Starters**: Node (from the existing bundle 3.0.0 code), Spring Boot (Spring Initializr shape), Red Hat build of
   Quarkus (Red Hat Maven BOM, UBI OpenJDK image). The Java starters each have two versions, so the code upgrade can
   be shown.
5. **Nisshi** ([nisshi.io](https://nisshi.io/), Kafka-compatible broker): a new CALM pattern `event-streaming` with a
   storage choice, a starter app that produces and consumes through the broker, deployed and working.
6. **Working apps**: every starter serves a small page that shows it is alive, what it runs on, which starter and
   deployment-rules versions made it, and that its connections answer. Backstage links to it.
7. **A retake demo video** of everything (part 1, part 2 and this part) that opens with a table of contents, plus a
   written table of contents with chapter times.

## Non-goals

- No real GitHub: nothing leaves this machine (the base's boundary: no GitHub repository or push without Jim). A local
  Gitea stands in, and every Git URL is configuration, so pointing at GitHub later is a config change plus
  credentials.
- No CI server: Backstage's own actions build images (`minikube image build`), as in part 2.
- No three-way merge of developer edits during an upgrade. The upgrade re-renders the bundle's files and shows the
  diff in a pull request; a developer's edits to rendered files are overwritten (recorded in FINDINGS as the next
  step).
- No GitHub client: Gitea's push-to-create, pull-request API and anonymous Flux reads are Gitea-specific. The Git
  host sits behind a thin client so a GitHub one can be added (a track); that path is untested here.
- No TLS or authentication on the registry, Gitea or the app proxy beyond what is listed under Security.

## Anti-goals (a failure even if it works)

- A demo that needs hand steps outside `yarn` scripts, or extra host tools (no `flux` CLI, no `ffmpeg`).
- A demo that touches anything outside this project: other minikube profiles, other Compose projects, the user's
  kubeconfig, GitHub.
- An upgrade that changes the cluster without a Git commit that explains it.
- Breaking part 1 and part 2: `web-service@1.0.0`/`2.0.0`/`3.0.0`, direct `kubectl apply` deploys and existing
  `output/` services keep working.

## Constraints and facts (from spikes, 2026-11-14)

| Fact | Evidence |
|---|---|
| Images are public and multi-arch (this machine is arm64) | `ghcr.io/nisshi-io/nisshi` 0.7.0–0.8.2, `registry.access.redhat.com/ubi9/openjdk-21(-runtime)`, `maven:3.9-eclipse-temurin-21`, `eclipse-temurin:21-jre-alpine`, `gitea/gitea:1.27.3` |
| Red Hat Quarkus BOM is anonymous on `maven.repository.redhat.com/ga` | versions `3.33.4.redhat-00003` and `3.40.1.redhat-00004` |
| Spring Boot versions | `4.0.9`, `4.1.2` on Maven Central |
| Nisshi works with a real Kafka client | kafkajs 2.2.4: create topic, produce, consumer group consume (memory storage); SQLite storage starts in 20 ms |
| Flux without its CLI | Flux v2.10.0 `install.yaml` filtered to source- and kustomize-controller (`k8s/flux-install.cjs`); cloned `http://host.minikube.internal:3300/...` from Gitea and applied it |
| Flux without the notification controller | each event is retried 5 times (~15 s per reconcile) unless `--events-addr` is removed; removed |
| Gitea | 1.27.3 in the Compose project on host port 3300; push-to-create into public orgs works |
| Build times in `minikube image build` (BuildKit, `.m2` cache mount) | Spring Boot: 96 s cold, 2 s after a code change, 13 s after a Boot 4.0.9 → 4.1.2 bump |
| Cluster size | the profile was at 2.57 of 3 GiB; recreated with 6 GiB and 4 CPUs (`k8s/up.sh`). The Docker VM has 15.8 GiB shared with other projects |
| Network policies | the gateway's ingress is open (the web client is outside the cluster), so the Kubernetes API service proxy can reach it |
| Video tooling | Playwright's bundled ffmpeg has `trim` but no concat; no system ffmpeg |

## Approaches considered

### Bundle shape

1. **One bundle per service renders code and deployment (as today)**: one version to upgrade. A Spring change and a
   network-policy change are the same upgrade, and every starter repeats the deployment rules.
2. **Two kinds of bundle (chosen)**: *starter* (code + Dockerfile) and *deployment rules* (`deploy/k8s` from the
   architecture). A service records one of each. Code and deployment upgrade separately, the platform team owns the
   deployment rules once for every starter, and the explorer can say "4 services on deployment rules 1.0.0". Cost: a
   contract between the two (below) and a second bundle choice in the form.
3. **Starter + Kustomize components the starter picks**: more flexible, but the deployment rules then depend on the
   starter and CALM no longer drives them alone.

The old bundles stay as kind `full` and keep their single-bundle behaviour.

### Git store and GitOps

1. **GitHub + Argo CD**: closest to real life, but outward-facing (needs Jim) and Argo CD needs about 1 GiB.
2. **Local Gitea + Flux (chosen)**: Gitea has the GitHub shape (orgs, repositories, commits, pull requests, a web
   UI), runs in the existing Compose project, and needs nothing outside it. Flux's two controllers are light, need
   no CLI, and expose their status as Kubernetes objects the backend already knows how to read.
3. **Bare Git over a file share + kubectl**: no UI, no pull requests, not GitOps.

### Showing the running app

1. **Port-forward or NodePort**: needs a terminal, or a tunnel on macOS with the Docker driver.
2. **Backend proxy through the Kubernetes API service proxy (chosen)**: one link from the service page, nothing to
   run, goes through the service's own gateway (the architecture's path).
3. **Ingress controller + hosts entry**: changes the user's machine.

### Demo video

1. Chapters recorded separately and joined: no tool to join them.
2. **One take with a contents card, chapter cards and logged chapter times (chosen)**: builds are pre-warmed, so the
   waits are short.

## Design

### Bundles

`calm-backstage.json` gains:

```json
{
  "name": "spring-boot-service", "version": "1.0.0",
  "kind": "starter",                      // starter | deployment | full (default full: the old bundles)
  "description": "...",
  "runtime": "Spring Boot 4.0.9 on Java 21",   // shown in the explorer; starters only
  "patterns": [{ "namespace": "hackathon", "patternId": "web-service" }]   // `pattern` (one) is still read
}
```

Bundles to add:

| Bundle | Kind | Versions | Fits | Notes |
|---|---|---|---|---|
| `node-service` | starter | 1.0.0 | web-service | the bundle 3.0.0 server, moved to the contract |
| `spring-boot-service` | starter | 1.0.0 (Boot 4.0.9), 1.1.0 (Boot 4.1.2) | web-service | Maven, Java 21, Temurin JRE |
| `quarkus-service` | starter | 1.0.0 (RHBQ 3.33.4), 1.1.0 (RHBQ 3.40.1) | web-service | Red Hat Maven BOM, UBI 9 OpenJDK 21 |
| `nisshi-stream-app` | starter | 1.0.0 | event-streaming | Node + kafkajs: produce form, live consumed list |
| `k8s-deploy` | deployment | 1.0.0, 1.1.0 | web-service, event-streaming | 1.1.0 adds resource limits, liveness probes, no service-account tokens, `app.kubernetes.io/*` labels, and moves Nisshi 0.8.1 → 0.8.2 |

**Starter contract** (enforced by the deployment rules, documented in the explorer and README):

- `Dockerfile` at the root; the image is called `calm-service` in the manifests and replaced by the built one.
- Listens on `$PORT` (the deployment rules set it from the architecture's service interface port).
- `GET /health` answers 200 when ready. `GET /` is an HTML page with relative links only (it is served under a path
  prefix). `GET /api/info` is JSON.
- Reads `SERVICE_NAME`, `CALM_CONNECTIONS` (JSON list of `{id, name, technology, host, port}`), `CALM_DEPLOY_RULES`
  (`k8s-deploy@1.1.0`), and, when the architecture has them, `DATABASE_HOST`/`DATABASE_PORT` and
  `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_TOPIC`.
- Requests sized for a JVM (the deployment rules use one size for every starter's app container).

**Deployment rules (`k8s-deploy`)** render `deploy/k8s/` (kustomize base) from the architecture alone: a Deployment
and Service per in-cluster node (backing images by node unique-id, the app node gets `calm-service`), the gateway's
nginx config, and the network policies from `connects` relationships (as bundle 3.0.0). New nodes: `nisshi-broker`
(storage from the chosen node: PostgreSQL URL, or SQLite on an `emptyDir`).

**Rendering a service** with a starter: `calm template` runs twice into the same folder, the starter first, then the
deployment rules into `deploy/k8s`. A file rendered by both is an error.

### One source of truth for bundle sources

`bundles/` in this repository is the seed. `yarn hub:seed` mirrors it into the Gitea repository
`calm-templates/bundles` (one commit when anything changed, idempotent), then publishes each bundle to the OCI
registry **from a checkout of that commit**, with the annotations `org.opencontainers.image.source` (the folder's
Gitea URL), `org.opencontainers.image.revision` (the commit), `org.opencontainers.image.created`, and
`calm.finos.org/bundle-kind`. A version already in the registry is not pushed again when its layer (content) is the
same, and is refused when its content differs: a published version never changes.

Bundle versions published before this part (`web-service` 1.0.0–3.0.0 on an existing registry volume) are not
re-pushed, so their digests (recorded by existing services) stay valid; the explorer shows "Source not recorded" for
them. A from-scratch run (`docker compose … down -v`) deletes every volume of the Compose project, the registry's
included, so everything is then published with its source. The seed's sync commits use a fixed author, committer and
date, so the same `bundles/` tree on an empty Gitea gives the same commit SHA and revision annotations stay true
across a Gitea reset done together with the registry.

To change a bundle: edit it in Gitea (or in `bundles/` and re-seed) as a new version folder, then publish
(`yarn bundles:publish`, which publishes from Gitea's `main`). The explorer links each version to its source folder at
its commit.

### Services in Git

`output/<name>` becomes a Git working copy whose remote is `calm-services/<name>` in Gitea. New action
`calm:git:publish` (after `calm:publish:local`) commits the rendered service with a message naming the pattern,
starter and deployment rules, and pushes. `catalog-info.yaml` gains:

```
calm.finos.org/deploy-bundle: k8s-deploy
calm.finos.org/deploy-bundle-version: 1.0.0
calm.finos.org/git-repo: http://localhost:3300/calm-services/<name>
calm.finos.org/gitops: flux-system/calm-<name>
```

and `calm.finos.org/bundle(-version)` names the starter. The catalog still reads the local file (no Gitea integration
needed in Backstage).

### GitOps deploy

`calm.gitops` is configured by default, so new services deploy through Git and Flux; the Template no longer offers a
direct `kubectl apply`. Without `calm.gitops` the Template keeps part 2's steps (`calm:deploy:k8s`). Services already in
`output/` (not Git working copies, `full` bundles) are left as they are: they have no upgrade path and the explorer and
card say so ("not in Git" / "full bundle: create the service again with a starter").

New action `calm:deploy:gitops` (used instead of `calm:deploy:k8s` when `calm.gitops` is configured):

1. Refuses a namespace that exists and is not this service's (as `calm:deploy:k8s`).
2. Writes `deploy/k8s-overlay/` (namespace, built image, `backstage.io/kubernetes-id` labels: the same overlay as
   part 2), commits "Deploy <image>" and pushes.
3. Applies a Flux `GitRepository` and `Kustomization` `calm-<name>` in `flux-system` (cluster-side Git URL
   `http://host.minikube.internal:3300/...`, path `./deploy/k8s-overlay`, prune on), and asks for an immediate
   reconcile (`reconcile.fluxcd.io/requestedAt`).
4. Waits until the Kustomization is Ready with the pushed commit as its applied revision, then for the rollouts.
5. Outputs what `calm:deploy:k8s` outputs, plus the repository, commit and Kustomization.

`calm:image:build` tags with the code commit, so the image says which commit it was built from. The deployment
decorator in CALM Hub records the Git repository and commit.

Config (local development values, in `app-config.yaml`):

```yaml
calm:
  gitops:
    gitUrl: http://localhost:3300          # Backstage and the browser
    clusterGitUrl: http://host.minikube.internal:3300   # Flux in the cluster
    servicesOrg: calm-services
    templatesRepo: calm-templates/bundles
    username: calm
    password: calm-local-dev               # local Gitea only; created by hub/gitea-seed.sh
```

### Upgrade

- **Status**: the backend route `GET /api/calm/upgrades?entity=` compares a service's starter and deployment rules
  with the newest registry versions of the same bundle names (that still fit the service's pattern). The service card
  shows "Code: spring-boot-service 1.0.0 → 1.1.0 available" and "Deployment rules: k8s-deploy 1.0.0 → 1.1.0
  available", each with an **Upgrade** link to the upgrade Template with the service filled in.
- **Template** `calm-upgrade` (emitted by the provider): the service (entity picker, CALM services in Git), and two
  boxes: upgrade the code, upgrade the deployment rules (each defaults to on when an upgrade exists).
- **Actions** (in this order, so `main` only ever holds a commit that is complete, and the merge commit is the one
  Flux applies):
  - `calm:upgrade:render`: starts from a clean `main` (a branch left by a failed run is deleted), creates
    `upgrade/<side>-<version>`, re-renders the starter (keeping `deploy/`) and/or the deployment rules (replacing
    `deploy/k8s/`), updates the bundle annotations in `catalog-info.yaml` and commits on the branch (not pushed).
    Outputs whether anything changed, whether code changed, the branch commit and the current image.
  - `calm:image:build` (only when code changed), from the branch working copy, tagged with the branch commit.
  - `calm:upgrade:merge`: writes the overlay's image (new or current) on the branch, commits, pushes the branch, opens
    a pull request in Gitea whose body lists the versions and the changed files, merges it and fast-forwards `main`.
    A failed build stops the run before this step: `main`, Gitea and the cluster are untouched.
  - `calm:deploy:gitops` (finds the overlay already up to date, so it makes no commit and waits for Flux to apply the
    merge commit), `calm:decorate:deployment`, and a catalog refresh of the entity.

### Template Explorer

A page at `/calm-templates` (nav item "Template Explorer") in the `calm` frontend plugin.

- **Backend routes** (`calm-backend`): `GET /bundles` (registry catalog: names, tags, manifest annotations, config,
  kind, patterns, digest, size), `GET /bundles/:name/:version/files` (pulled into the cache; paths and sizes),
  `GET /bundles/:name/:version/file?path=` (text), `GET /bundles/:name/diff?from=&to=` (unified diff per file, `diff`
  package).
- **Page**: bundles grouped as Starters / Deployment rules / Older full bundles; for the chosen bundle: versions,
  OCI reference and digest, "Source in Git" link at the commit, the pattern(s) it fits, its file tree with a file
  viewer, a version diff, and "Used by" (catalog query on the bundle annotations) with up to date / upgrade available
  and a link to the upgrade Template.

### Working apps

`GET /api/calm/app/:name/*` (`calm-backend`) proxies to the service's gateway through the Kubernetes API service proxy
(`/api/v1/namespaces/calm-<name>/services/http:api-gateway:80/proxy/...`), using the kubeconfig in
`calm.deploy.kubernetes`. The architecture card shows **Open the running app**. Each starter's page shows: service
name, runtime (e.g. Spring Boot 4.1.2, Java 21), starter version, deployment-rules version, connection checks; the
Nisshi app adds a produce form and the messages it consumed.

### Nisshi pattern `hackathon/event-streaming`

Nodes: web client, API gateway, stream app (the service, with `topic` and owner as placeholders), Nisshi broker, and
a `oneOf` broker storage: PostgreSQL or SQLite on the broker's volume. Relationships: client → gateway → app → broker
(→ PostgreSQL). Controls: reuse the `hackathon-security` controls where they fit. Seeded into CALM Hub like
`web-service`.

### Demo

`docs/demo/record-full-demo.cjs` records one take: a contents card, then chapters, each opened by a chapter card:

1. The catalog from CALM Hub: architectures, patterns, controls.
2. Architecture and pattern pages.
3. Template Explorer: starters and deployment rules, what is inside the OCI artifact, source in Git, a version diff.
4. Create a Spring Boot service (starter 1.0.0, deployment rules 1.0.0), deployed through Git and Flux; open the
   running app.
5. Create a Red Hat Quarkus service; open the running app.
6. Create a Nisshi event-streaming service; produce and consume in the running app.
7. CALM Hub: the stored architectures and recorded deployments.
8. Gitea: the template sources and the service repositories.
9. Upgrade the Spring service's code and deployment rules: pull request, Flux redeploy, the app shows the new
   versions, the Hub records the deployment.
10. The explorer again: who uses which version.

The script logs each chapter's start time; `docs/demo/README.md` holds the table of contents with times. Builds and
image pulls are warmed before recording.

### Security (local development only)

- Gitea admin `calm` / `calm-local-dev`, created by the seed script; repositories public; registration off.
- `/api/calm/app/*` is unauthenticated (a new browser tab has no Backstage token); it only reaches services in
  namespaces `calm-<name>` that carry the `calm.finos.org/service` label, and only their `api-gateway` service.
- As before: no-auth CALM Hub, plain HTTP registry.

## Order and cut line

1. Infrastructure: Gitea in Compose, Flux in `k8s:up`, seeds (orgs, templates repo).
2. GitOps deploy for the existing `web-service@3.0.0` (`calm:git:publish`, `calm:deploy:gitops`, card status).
3. Bundle split: `kind`, `patterns`, two-bundle rendering; `node-service` and `k8s-deploy@1.0.0`.
4. Upgrade flow (status route, card, Template, `calm:upgrade:render`) with `k8s-deploy@1.1.0`.
5. Java starters (both versions each).
6. Template Explorer (list, files, used by; then diff).
7. App proxy and the "open the running app" link.
8. Nisshi pattern and starter.
9. From-scratch run, docs (README, TRACKS, FINDINGS), retake video.

**Cut line**, if time runs short: Nisshi as one `full` bundle; drop the explorer's version diff; Quarkus with one
version. The demo video is not cut.

## What changed while building (2026-11-14)

- `calm.finos.org/gitops` and the `calm-gitops` tag mark a service once `calm:deploy:gitops` has deployed it (not at
  `calm:git:publish`), so never-deployed services are not offered upgrades.
- Extra bundle versions: `k8s-deploy` 1.2.0 and 1.2.1 (backing services never run twice during a rollout; 1.2.1's
  `maxSurge: 0` replaces 1.2.0's `Recreate`, which an existing deployment refuses) and `nisshi-stream-app` 1.0.1
  (creates its topic again after a broker restart on empty storage). The demo upgrades `k8s-deploy` 1.0.0 → 1.2.1.
- The app proxy sets its own Content-Security-Policy.
- No full from-scratch run on empty Compose volumes: they are shared with another checkout. The cluster was rebuilt
  from scratch and the seeds' create path was run against throwaway containers.

## Left to the builder

File layout inside plugins, test split, exact UI layout, and whether a step is one action or two, within the above.

## Acceptance

- `yarn tsc`, `yarn test`, `yarn build:backend` pass.
- From scratch (Hub volume, Gitea volume and cluster deleted, `output/` moved aside): `yarn hub:up && yarn hub:seed`,
  `yarn k8s:up`, `yarn start`, then every demo chapter works without a hand step.
- Each starter, once deployed, answers through "Open the running app"; the Nisshi app round-trips a message.
- An upgrade of code and deployment rules produces a merged pull request in Gitea, a new Flux-applied commit, a new
  pod running the new versions (shown on the app page), and a new deployment decorator in CALM Hub.
- The video exists, opens with a contents card, and `docs/demo/README.md` has chapter times.
