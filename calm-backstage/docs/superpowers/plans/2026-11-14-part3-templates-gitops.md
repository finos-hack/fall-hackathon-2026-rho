# Part 3: Template Explorer, GitOps upgrades, starters, Nisshi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer creates a Spring Boot, Red Hat Quarkus, Node or Nisshi service from a CALM pattern, it is
deployed through Git and Flux and opens as a working app from Backstage, and later its code and its deployment rules
are upgraded from Backstage through a pull request and a Flux redeploy; a Template Explorer shows every bundle, its
contents, its Git source and who uses it.

**Architecture:** Bundles split into *starters* (code) and *deployment rules* (`deploy/k8s` from the architecture).
Bundle sources live in a local Gitea (`calm-templates/bundles`) and are published to the OCI registry from a Git
commit. Each service is a Gitea repository (`calm-services/<name>`) whose working copy is `output/<name>`; Flux in
minikube applies its `deploy/k8s-overlay`. New scaffolder actions do the Git and Flux work; `calm-backend` adds
explorer, upgrade-status and app-proxy routes; the `calm` frontend plugin adds the explorer page and card sections.

**Tech Stack:** Backstage (new frontend and backend systems), TypeScript, `@finos/calm-cli` 1.71.0, Gitea 1.27.3,
Flux v2.10.0 (source + kustomize controllers), minikube (Calico), Handlebars bundles, Maven/Java 21, Node 22,
kafkajs 2.2.4, Nisshi 0.8.x, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-part3-templates-gitops-design.md`

## Global Constraints

- Touch only the `calm-backstage` minikube profile, the `calm-backstage` Compose project and this repository. Never the
  user's kubeconfig, other profiles or GitHub.
- No new host tools: no `flux` CLI, no `ffmpeg`. `git`, `kubectl`, `minikube`, `docker`, `node` only.
- Ports: Backstage 3100/7107, Hub 8090, registry 5050, Gitea 3300. Never 3000, 7007, 8080, 8088.
- Gitea: user `calm`, password `calm-local-dev`, orgs `calm-templates` and `calm-services`, repo
  `calm-templates/bundles`; browser URL `http://localhost:3300`, cluster URL `http://host.minikube.internal:3300`.
- Flux objects: `GitRepository` and `Kustomization` named `calm-<name>` in `flux-system`, path `./deploy/k8s-overlay`,
  `prune: true`, `interval: 1m`.
- Versions pinned: Spring Boot `4.0.9` (starter 1.0.0) and `4.1.2` (1.1.0); Red Hat Quarkus BOM `3.33.4.redhat-00003`
  (1.0.0) and `3.40.1.redhat-00004` (1.1.0); Nisshi image `ghcr.io/nisshi-io/nisshi:0.8.1` (k8s-deploy 1.0.0) and
  `0.8.2` (1.1.0); kafkajs `2.2.4`; `node:22-alpine`; `maven:3.9-eclipse-temurin-21`; `eclipse-temurin:21-jre-alpine`;
  `registry.access.redhat.com/ubi9/openjdk-21:latest` and `-runtime:latest`.
- Existing behaviour stays: `web-service@1.0.0/2.0.0/3.0.0` (kind `full`), `calm:deploy:k8s` when `calm.gitops` is not
  configured, services already in `output/`.
- Commits: Conventional Commits, `git commit -s`, no Claude attribution (project rule).
- Every new action and route has unit tests (`yarn test`); `yarn tsc` and `yarn build:backend` pass after every task.

## Review Focus

1. **A service name that already has a Gitea repository or a Flux Kustomization from an earlier run** (e.g. after
   `output/` was moved aside): expect a clear refusal naming the repository, not a force-push over its history. Test
   in Task 3 (`gitPublish refuses a remote that has commits the working copy lacks`).
2. **Flux never reaching the pushed commit** (Gitea down, wrong cluster URL, a manifest Flux rejects): expect the
   deploy step to fail within its timeout with Flux's own Ready message, not hang. Test in Task 3
   (`waitForKustomization fails with the Ready message after the timeout`).
3. **Upgrade asked when nothing is newer, or a starter whose newer version no longer fits the service's pattern**:
   expect "already up to date" and no commit. Test in Task 6 (`upgradeTargets ignores versions that do not fit the
   pattern` and `calm:upgrade:render makes no commit when nothing changes`).
4. **The app proxy asked for a name that is not a deployed CALM service, or a path that climbs out** (`..`, encoded
   slashes): expect 404 without contacting the API server for an arbitrary namespace. Test in Task 9.
5. **Re-running `yarn hub:seed` after a bundle folder changed without a version bump**: expect the publish to refuse
   that version, naming it, while unchanged versions are skipped. Test in Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `hub/docker-compose.yml` | + Gitea service (done in spike) |
| `hub/gitea-seed.sh` | create admin user, orgs; idempotent |
| `hub/push-bundles.cjs` | mirror `bundles/` into `calm-templates/bundles`, publish from that commit |
| `k8s/flux-install.cjs`, `k8s/up.sh` | Flux install (done in spike) wired into `k8s:up` |
| `plugins/calm-node/src/git.ts` | git CLI wrapper: init, commit, push, branch, head |
| `plugins/calm-common/src/gitea.ts` | Gitea REST client: repo exists, create PR, merge PR |
| `plugins/calm-common/src/bundleMeta.ts` | `kind`, `patterns`, `runtime` from `calm-backstage.json`; fit; newest |
| `plugins/calm-common/src/flux.ts` | Flux object builders and Ready/revision reading |
| `plugins/calm-common/src/annotations.ts` | + `deployBundle`, `deployBundleVersion`, `gitRepo`, `gitops` |
| `plugins/scaffolder-backend-module-calm/src/actions/gitPublish.ts` | `calm:git:publish` |
| `plugins/scaffolder-backend-module-calm/src/actions/deployGitops.ts` | `calm:deploy:gitops` |
| `plugins/scaffolder-backend-module-calm/src/actions/upgradeRender.ts` | `calm:upgrade:render` |
| `plugins/scaffolder-backend-module-calm/src/actions/catalogRefresh.ts` | `calm:catalog:refresh` |
| `plugins/catalog-backend-module-calm/src/entities.ts` | two bundle choices, gitops steps, upgrade Template |
| `plugins/calm-backend/src/bundles.ts` | explorer routes' logic (list, files, file, diff) |
| `plugins/calm-backend/src/upgrades.ts` | upgrade status for an entity |
| `plugins/calm-backend/src/appProxy.ts` | Kubernetes API service proxy to `api-gateway` |
| `plugins/calm-backend/src/gitops.ts` | read a service's Flux Kustomization status |
| `plugins/calm/src/components/TemplateExplorerPage.tsx` (+ small parts) | the explorer page |
| `plugins/calm/src/components/CalmArchitectureCard.tsx` | + GitOps, versions/upgrades, open-app sections |
| `bundles/node-service/1.0.0`, `bundles/spring-boot-service/{1.0.0,1.1.0}`, `bundles/quarkus-service/{1.0.0,1.1.0}`, `bundles/nisshi-stream-app/1.0.0`, `bundles/k8s-deploy/{1.0.0,1.1.0}` | bundles |
| `seed/patterns/event-streaming.pattern.json` | Nisshi pattern |
| `docs/demo/record-full-demo.cjs`, `docs/demo/README.md` | retake video and its contents |

---

### Task 1: Git server and Flux come up from the yarn scripts

**Files:**
- Create: `hub/gitea-seed.sh`
- Modify: `hub/docker-compose.yml` (spike: Gitea), `k8s/up.sh` (spike: 6 GiB / 4 CPUs; + Flux), `k8s/flux-install.cjs` (spike), `package.json` (`hub:seed`), `app-config.yaml` (`calm.gitops`), `.gitignore` if needed

**Interfaces:**
- Produces: Gitea at `http://localhost:3300` with user/orgs from Global Constraints; Flux controllers Ready in `flux-system`; config `calm.gitops.{gitUrl, clusterGitUrl, servicesOrg, templatesRepo, username, password}`.

- [ ] **Step 1:** `hub/gitea-seed.sh`: wait for `/api/healthz`; `docker exec -u git calm-backstage-gitea gitea admin user create … --admin --must-change-password=false` only when `GET /api/v1/users/calm` is 404; create orgs `calm-templates`, `calm-services` (public) only when `GET /api/v1/orgs/<org>` is 404. Print `created`/`exists` lines like `seed.sh`.
- [ ] **Step 2:** `package.json`: `"hub:seed": "hub/seed.sh && hub/gitea-seed.sh && node hub/push-bundles.cjs"`.
- [ ] **Step 3:** `k8s/up.sh`: after Calico, `node "$ROOT_DIR/k8s/flux-install.cjs" | kc apply --server-side -f -`, then `rollout status` for both controllers (300 s).
- [ ] **Step 4:** `app-config.yaml`: `calm.gitops` block with the constraint values and a comment that they are local-only.
- [ ] **Step 5: Verify** — run `yarn hub:up && hub/gitea-seed.sh` twice (second run all `exists`), and `kc -n flux-system get deploy` shows exactly `kustomize-controller` and `source-controller` Ready.
- [ ] **Step 6: Commit** `feat(gitops): add a local Gitea and Flux to the dev stack` (with the design doc and this plan).

### Task 2: Git and Gitea clients

**Files:**
- Create: `plugins/calm-node/src/git.ts`, `plugins/calm-node/src/git.test.ts`, `plugins/calm-common/src/gitea.ts`, `plugins/calm-common/src/gitea.test.ts`
- Modify: both packages' `index.ts`

**Interfaces:**
- Produces (calm-node):
  - `interface GitAuth { username: string; password: string }`
  - `gitInit(dir: string, branch = 'main'): Promise<void>` (no-op when `.git` exists)
  - `gitCommitAll(dir: string, message: string): Promise<string | undefined>` — stages all, commits as `CALM Backstage <calm-backstage@localhost>`, returns the new sha or `undefined` when nothing changed
  - `gitHead(dir: string): Promise<string>`
  - `gitCheckoutBranch(dir: string, branch: string, create: boolean): Promise<void>`
  - `gitPush(dir: string, remoteUrl: string, branch: string, auth?: GitAuth): Promise<void>` — auth via `-c http.extraHeader=Authorization: Basic …`, never stored in `.git/config`; plain push (no force)
  - `gitPull(dir: string, remoteUrl: string, branch: string, auth?: GitAuth): Promise<void>` (fast-forward only)
- Produces (calm-common): `class GiteaClient { constructor(baseUrl: string, auth: {username; password}); repoExists(owner, repo): Promise<boolean>; createPullRequest(owner, repo, {head, base, title, body}): Promise<{number: number; url: string}>; mergePullRequest(owner, repo, number, title): Promise<void>; repoWebUrl(owner, repo): string; commitWebUrl(owner, repo, sha): string; treeWebUrl(owner, repo, sha, path): string }`

- [ ] **Step 1: Tests** (`git.test.ts`, real git in temp dirs with a bare `file://` remote): `gitCommitAll returns undefined when nothing changed`; `gitPush then a clone of the remote has the commit`; `gitPush is refused when the remote has a commit the working copy lacks` (expect rejection message containing `rejected`); `auth header is not written to .git/config`. (`gitea.test.ts`, fetch mocked): `createPullRequest posts head/base/title/body to /api/v1/repos/o/r/pulls and returns number and html_url`; `mergePullRequest posts Do: merge`; `repoExists maps 404 to false`.
- [ ] **Step 2:** Run `yarn workspace @internal/backstage-plugin-calm-node test git` and the calm-common test: FAIL.
- [ ] **Step 3:** Implement with the existing `runProcess` (calm-node) and `fetch` (calm-common).
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5: Commit** `feat(calm-node): add git and Gitea clients`.

### Task 3: Deploy through Git and Flux

**Files:**
- Create: `plugins/calm-common/src/flux.ts` (+ test), `plugins/scaffolder-backend-module-calm/src/actions/gitPublish.ts`, `deployGitops.ts` (+ tests), `plugins/calm-backend/src/gitops.ts` (+ test)
- Modify: `annotations.ts`, `publishLocal.ts` (annotations), `module.ts` (register, read `calm.gitops`), `entities.ts` (steps), `router.ts` (`/architecture` adds `gitops`), `CalmArchitectureCard.tsx` (GitOps section), `hubRecord.ts` (`deploymentDecorator` takes optional `git: {repo, commit}`)

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - annotations `gitRepo: 'calm.finos.org/git-repo'`, `gitops: 'calm.finos.org/gitops'` (value `flux-system/calm-<name>`), `deployBundle`, `deployBundleVersion` (used from Task 4)
  - `fluxObjects(o: {name: string; repoUrl: string; branch: string; path: string}): object[]` and `readKustomizationStatus(obj: any): {ready: boolean; message: string; appliedRevision?: string}` and `revisionHasCommit(revision: string, sha: string): boolean` (revision format `main@sha1:<sha>`)
  - `calm:git:publish` input `{name, dir}` → output `{repoUrl, commit}`; creates repo by push-to-create in `servicesOrg`
  - `calm:deploy:gitops` input `{dir, name, image}` → outputs of `calm:deploy:k8s` plus `{repoUrl, commit, kustomization}`
  - `GET /api/calm/architecture` adds `gitops?: {kustomization, ready, message, appliedRevision, repoUrl, commitUrl}`

- [ ] **Step 1: Tests**: `fluxObjects builds a GitRepository and Kustomization named calm-orders in flux-system with path ./deploy/k8s-overlay and prune true`; `revisionHasCommit accepts main@sha1:<sha> and rejects another sha`; `waitForKustomization fails with the Ready message after the timeout` (fake clock / injected poll, kubectl mocked); `gitPublish refuses a remote that has commits the working copy lacks` (bare remote pre-seeded); `deployGitops commits deploy/k8s-overlay, pushes, applies the Flux objects, annotates requestedAt and waits for the pushed sha` (git real against a bare remote; kubectl mocked returning Ready with that revision); `deployGitops refuses a namespace owned by another service` (reuse `checkExistingNamespace`).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Implement. Reuse `overlayKustomization`, `namespaceManifest`, `checkExistingNamespace`, `summariseObjects` and the rollout wait from `deployK8s.ts` (export what is needed; do not copy). Poll every 2 s, timeout 300 s. The Template uses `calm:git:publish` + `calm:deploy:gitops` when `calm.gitops` is configured (the provider reads it), else the part 2 steps. `calm:image:build` tag: `${{ steps["git-publish"].output.commit | truncate(12) }}`-style short sha (fall back to task id when no git step).
- [ ] **Step 4:** Tests PASS; `yarn tsc`.
- [ ] **Step 5: Verify live** with `web-service@3.0.0`: create `gitops-check-api` from the UI or a scaffolder dry API call; Gitea shows two commits (create, deploy); `kc -n flux-system get kustomization calm-gitops-check-api` Ready with that commit; pods Running; card shows GitOps section.
- [ ] **Step 6: Commit** `feat(scaffolder): deploy new services through Git and Flux`.

### Task 4: Starters and deployment rules

**Files:**
- Create: `plugins/calm-common/src/bundleMeta.ts` (+ test), `bundles/node-service/1.0.0/*`, `bundles/k8s-deploy/1.0.0/*`
- Modify: `catalog-backend-module-calm/src/{bundles.ts,entities.ts}` (+ tests), `scaffolder…/actions/{template.ts,publishLocal.ts}` (+ tests), `CalmPatternCard.tsx` (show kind)

**Interfaces:**
- Produces:
  - `type BundleKind = 'starter' | 'deployment' | 'full'`; `interface BundleMeta { name; version; kind: BundleKind; description?; runtime?; deploy?; patterns: {namespace?: string; patternId: string}[] }`; `readBundleMeta(json: any): BundleMeta` (accepts old `pattern`; missing `kind` → `full`; `kind: deployment` implies `deploy: kubernetes`); `fits(meta, namespace, patternId): boolean`; `newestFitting(all: BundleMeta[], name, namespace, patternId): BundleMeta | undefined`
  - Template parameters: `bundle` (enum of starter and full bundles, label "Starter (code)"), `deployBundle` (enum of deployment bundles, label "Deployment rules"; ignored for a full bundle); `calm:template` gets optional input `subdir` and the Template runs it a second time with `bundle: deployBundle, subdir: 'deploy/k8s'` when the starter is not full; a file rendered twice fails the run
  - `calm:publish:local` input `deployBundle?` → annotations `deployBundle(-Version)` and a second `dependsOn`
  - Starter contract and env names exactly as in the spec ("Starter contract")
- Bundles: `node-service@1.0.0` = bundle 3.0.0's `server.js`, `Dockerfile`, `README` moved to the contract (`$PORT`, `/health`, `/api/info`, HTML `/` with relative links, `CALM_*` env); `k8s-deploy@1.0.0` = bundle 3.0.0's `workloads`, `gateway-config`, `network-policy`, `kustomization` templates and transformer, generalised: app node = the node with `node-type: service`; env injection per contract; app container requests `250m`/`384Mi`; label `calm.finos.org/deploy-rules: k8s-deploy-1.0.0`. Fits `web-service` (Task 10 adds `event-streaming`).

- [ ] **Step 1: Tests**: `readBundleMeta treats a bundle without kind as full`; `readBundleMeta reads patterns and the old single pattern`; `templateEntity offers starters and full bundles as bundle and deployment bundles as deployBundle`; `templateEntity renders the deployment rules into deploy/k8s only when the starter is not full`; `publishLocal records the deployment bundle annotations`; `k8s-deploy renders a Deployment per in-cluster node with CALM_CONNECTIONS and PORT for the service node` (render the bundle with the CLI against `seed/architectures/orders-service.architecture.json`-shaped fixture; assert on YAML).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Verify live**: create `node-check-api` with `node-service@1.0.0` + `k8s-deploy@1.0.0`, deployed through Flux; `curl` through `kubectl port-forward svc/api-gateway` returns `/api/info` naming both bundles.
- [ ] **Step 6: Commit** `feat(bundles): split bundles into starters and deployment rules`.

### Task 5: Publish bundles from Git

**Files:**
- Modify: `hub/push-bundles.cjs`, `plugins/calm-node/src/oci.ts` (+ test), `package.json` (`bundles:publish`)

**Interfaces:**
- Produces: `pushBundle(opts: {ref; dir; annotations?: Record<string,string>; immutable?: boolean})` — with `immutable`, when the tag exists: same layer digest → returns `{skipped: true}`; different layer → throws `bundle <ref> already published with different content; publish a new version`. Annotations on every push: `org.opencontainers.image.source`, `.revision`, `.created`, `calm.finos.org/bundle-kind`.
- Same layer already published → skipped without touching the manifest (old versions keep their digest and may have no source annotations). Sync commits use author/committer `CALM Backstage <calm-backstage@localhost>` and `GIT_AUTHOR_DATE=GIT_COMMITTER_DATE=2026-11-14T00:00:00Z`.
- `push-bundles.cjs`: clones `calm-templates/bundles` into a temp dir, replaces its tree with `bundles/` (unless `--from-git`), commits "Sync bundles from calm-backstage" when changed, pushes, then publishes every `<name>/<version>` from that checkout with `source = http://localhost:3300/calm-templates/bundles/src/commit/<sha>/<name>/<version>`.

- [ ] **Step 1: Tests** (`oci.test.ts`, fake registry already used there): `pushBundle with immutable skips an identical layer`; `pushBundle with immutable refuses different content for an existing tag`; `pushBundle writes the given annotations`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Verify**: `yarn hub:seed` twice — second run publishes nothing new; registry manifest of `k8s-deploy:1.0.0` has the four annotations; Gitea shows `calm-templates/bundles` with the folders.
- [ ] **Step 6: Commit** `feat(bundles): publish bundles from the Gitea templates repository`.

### Task 6: Upgrade code and deployment rules

**Files:**
- Create: `plugins/calm-common/src/upgrades.ts` (+ test), `plugins/calm-backend/src/upgrades.ts` (+ test), `scaffolder…/actions/upgradeRender.ts`, `upgradeMerge.ts` (+ tests), `scaffolder…/actions/catalogRefresh.ts`, `bundles/k8s-deploy/1.1.0/*`
- Modify: `entities.ts` (+ upgrade Template), `router.ts` (`GET /upgrades`), `CalmArchitectureCard.tsx` (Versions section with Upgrade links), `module.ts`

**Interfaces:**
- Produces:
  - `upgradeTargets(current: {starter?: {name; version}; deploy?: {name; version}}, available: BundleMeta[], pattern: {namespace?; patternId}): {starter?: {from; to}; deploy?: {from; to}}`
  - `GET /api/calm/upgrades?entityRef=` → `{starter?: {name, from, to?}, deploy?: {name, from, to?}, upgradeTemplate: string}`
  - Template `calm-upgrade` (`metadata.name: calm-upgrade`, title "Upgrade a CALM service"): parameters `service` (`EntityPicker`, `catalogFilter: {kind: Component, 'metadata.tags': 'calm-gitops'}`), `upgradeCode: boolean`, `upgradeDeploy: boolean`; steps `calm:upgrade:render` → `calm:image:build` (if `codeChanged`, tag = branch commit) → `calm:upgrade:merge` (image = built or `currentImage`) → `calm:deploy:gitops` (overlay already current: no commit, waits for the merge commit) → `calm:decorate:deployment` → `calm:catalog:refresh`; each step after render is skipped when `changed` is false
  - `calm:upgrade:render` input `{entityRef, upgradeCode, upgradeDeploy}` → output `{changed, codeChanged, branch, commit, dir, currentImage, starter, deployBundle}`; starts from clean `main` (deletes a leftover branch); branch `upgrade/<code|deploy|both>-<to>`; commits on the branch, does not push
  - `calm:upgrade:merge` input `{dir, name, branch, image}` → output `{prUrl, commit}`: writes the overlay image, commits, pushes the branch, opens the PR (body: `from → to` per side and `git diff --stat main`), merges, fast-forwards `main`
  - `calm:deploy:gitops` must treat "overlay unchanged" as deploy `HEAD` (no empty commit)
  - `calm:catalog:refresh` input `{entityRef}` (catalog service `refreshEntity`)
  - `catalog-info.yaml` gets tag `calm-gitops` from `calm:publish:local` when gitops is on
- `k8s-deploy@1.1.0`: as 1.0.0 plus limits (`cpu: 1`, `memory: 768Mi` app; 2× request for backing), `livenessProbe` on the same path as readiness, `automountServiceAccountToken: false`, `app.kubernetes.io/{name,part-of,managed-by}` labels, `CALM_DEPLOY_RULES=k8s-deploy@1.1.0`, Nisshi `0.8.2`.

- [ ] **Step 1: Tests**: `a failed build leaves main and the remote untouched` (render then no merge: remote main sha unchanged); `upgradeTargets picks the newest fitting version per side`; `upgradeTargets ignores versions that do not fit the pattern`; `upgradeTargets returns nothing when up to date`; `calm:upgrade:render makes no commit when nothing changes`; `calm:upgrade:render re-renders deploy/k8s only for a deployment upgrade and keeps src/` (real git, bare remote, Gitea client mocked, `renderBundle` mocked writing known files); `upgrade route reports from and to for an entity`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (re-render in a temp folder then copy over the working copy; for a code upgrade remove the old starter's files that the new version no longer renders, keeping `deploy/`, `architecture.json`, `catalog-info.yaml`). **Step 4:** PASS.
- [ ] **Step 5: Verify live**: upgrade `node-check-api` deployment rules 1.0.0 → 1.1.0; Gitea shows a merged PR; Flux applied the merge commit; pod has limits; `/api/info` shows `k8s-deploy@1.1.0`; Hub has a second deployment decorator; card shows "up to date".
- [ ] **Step 7: Commit** `feat(scaffolder): upgrade a service's code and deployment rules through a pull request`.

### Task 7: Spring Boot and Red Hat Quarkus starters

**Files:**
- Create: `bundles/spring-boot-service/{1.0.0,1.1.0}/*`, `bundles/quarkus-service/{1.0.0,1.1.0}/*`

**Interfaces:**
- Consumes: the starter contract (Task 4).
- Spring: `pom.xml` (parent `spring-boot-starter-parent` pinned, `web`, `actuator`), `src/main/java/<pkg>/Application.java`, `InfoController.java` (`/`, `/health`, `/api/info`, connection checks over TCP with 2 s timeout), `application.properties` (`server.port=${PORT:8080}`), multi-stage `Dockerfile` (`maven:3.9-eclipse-temurin-21`, `RUN --mount=type=cache,target=/root/.m2`, runtime `eclipse-temurin:21-jre-alpine`, `USER 1000`). Package from the service name (`com.example.<name without hyphens>`). 1.1.0 differs by the Boot version and the version strings shown.
- Quarkus: `pom.xml` with `com.redhat.quarkus.platform:quarkus-bom` pinned and the `maven.repository.redhat.com/ga` repository and plugin repository, `quarkus-rest`, `quarkus-rest-jackson`, `quarkus-smallrye-health`; `InfoResource.java`; `application.properties` (`quarkus.http.port=${PORT:8080}`); `Dockerfile` building with `registry.access.redhat.com/ubi9/openjdk-21:latest` (Maven wrapper not needed: install Maven via the image's `mvn` if present, else use `maven:3.9-eclipse-temurin-21` build stage — verify which in step 1) and running on `ubi9/openjdk-21-runtime` with `quarkus-app/` fast-jar layout.

- [ ] **Step 1:** Render each version against a web-service architecture with `calm template` into a temp folder and build it with `minikube -p calm-backstage image build`; record cold and warm build times.
- [ ] **Step 2:** Run each image in the cluster (Task 4 flow through the UI for 1.0.0 of each) and check `/health` 200 and `/api/info` JSON with the runtime version.
- [ ] **Step 3: Commit** `feat(bundles): add Spring Boot and Red Hat build of Quarkus starters`.

### Task 8: Template Explorer

**Files:**
- Create: `plugins/calm-backend/src/bundles.ts` (+ test), `plugins/calm/src/components/TemplateExplorerPage.tsx`, `plugins/calm/src/components/explorer/*` (list, detail, file viewer, diff), `plugins/calm/src/api.ts` additions
- Modify: `router.ts`, `plugins/calm/src/plugin.tsx` (`PageBlueprint` at `/calm-templates`, `NavItemBlueprint` "Template Explorer"), `plugins/calm-backend/package.json` (`diff`)

**Interfaces:**
- Produces routes: `GET /api/calm/bundles` → `{bundles: {name, kind, versions: {version, ref, digest, size, created?, source?, revision?, description?, runtime?, patterns}[]}[]}`; `GET /api/calm/bundles/:name/:version/files` → `{files: {path, size}[]}`; `GET /api/calm/bundles/:name/:version/file?path=` → `text/plain` (404 for a path not in the bundle); `GET /api/calm/bundles/:name/diff?from=&to=` → `{files: {path, status: 'added'|'removed'|'changed', patch?: string}[]}`.
- Page: groups Starters / Deployment rules / Full; detail shows the spec's fields; "Used by" from `catalogApiRef.getEntities({filter: {kind: 'Component', 'metadata.annotations.calm.finos.org/bundle': name}})` plus the deploy-bundle annotation, with status and a link to `/create/templates/default/calm-upgrade?formData=…`.

- [ ] **Step 1: Tests**: `listBundles groups registry tags by name with kind and annotations`; `bundleFile refuses a path not listed in the bundle`; `bundleDiff reports added, removed and changed files with a unified patch`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Verify live** in the browser (Playwright screenshot to scratchpad): page lists all bundles, shows `k8s-deploy` files, a 1.0.0 → 1.1.0 diff, and Used by.
- [ ] **Step 6: Commit** `feat(calm): add the Template Explorer`.

### Task 9: Open the running app

**Files:**
- Create: `plugins/calm-backend/src/appProxy.ts` (+ test)
- Modify: `plugin.ts` (auth policy `unauthenticated` for `/app`), `router.ts`, `CalmArchitectureCard.tsx` ("Open the running app" link when deployed)

**Interfaces:**
- Produces: `GET /api/calm/app/:name/*` → streams the response of `https://<apiserver>/api/v1/namespaces/<prefix><name>/services/http:api-gateway:80/proxy/<rest>`; `GET /api/calm/app/:name` redirects to `…/:name/`. Uses `@kubernetes/client-node` `KubeConfig` from `calm.deploy.kubernetes` (`applyToHTTPSOptions`). Only for a namespace labelled `calm.finos.org/service=<name>` (looked up, cached 30 s).
- `appTarget(name: string, rest: string, prefix: string): {namespace: string; path: string} | undefined` — undefined for a non-DNS-label name or a `rest` that contains `..` segments or encoded slashes.

- [ ] **Step 1: Tests**: `appTarget rejects .. and %2F`; `appTarget builds the service proxy path`; `proxy returns 404 for a namespace without the service label` (kubectl/API mocked).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Verify live**: open `http://localhost:7107/api/calm/app/node-check-api/` and the Spring/Quarkus ones; pages render with working relative links.
- [ ] **Step 6: Commit** `feat(calm): open a deployed service's app from its page`.

### Task 10: Nisshi event streaming

**Files:**
- Create: `seed/patterns/event-streaming.pattern.json`, `bundles/nisshi-stream-app/1.0.0/*`
- Modify: `bundles/k8s-deploy/{1.0.0,1.1.0}` (broker and storage nodes, `event-streaming` fit), `hub/seed.sh` if it lists patterns explicitly

**Interfaces:**
- Pattern `hackathon/event-streaming` 1.0.0: nodes `web-client`, `api-gateway` (host/port placeholders), `stream-app` (service; metadata `owner`, `service-name`, `topic`; interface port), `nisshi-broker` (system; port 9092), `oneOf` storage `broker-postgres` (database, 5432) | `broker-sqlite` (data-asset "SQLite file on the broker's volume"); relationships client→gateway, gateway→app, app→broker (connects, Kafka protocol shown as `TCP`), `oneOf` broker→postgres (connects) | broker→sqlite (`composed-of`); decision `broker-storage` with descriptions "PostgreSQL" and "SQLite on the broker's volume". Controls: `permitted-connection` on connects, `encryption-at-rest` on postgres, as in `web-service`.
- `k8s-deploy`: `nisshi-broker` → image per version, `ADVERTISED_LISTENER_URL=tcp://nisshi-broker:9092`, `STORAGE_ENGINE=postgres://postgres:change-me@broker-postgres` or `sqlite:///data/nisshi.db` with an `emptyDir` at `/data`; app env `KAFKA_BOOTSTRAP_SERVERS=nisshi-broker:9092`, `KAFKA_TOPIC=<topic>`.
- `nisshi-stream-app@1.0.0`: Node 22 + `kafkajs@2.2.4` (`npm ci` in the Dockerfile with a committed `package-lock.json`), contract endpoints plus `POST api/messages` (produce) and `GET api/messages` (last 50 consumed, consumer group `<service>-ui`), page with a form and auto-refreshing list; creates the topic on start; retries the broker connection until ready.

- [ ] **Step 1:** `calm validate` the pattern; `hub/seed.sh` stores it; the provider emits its Template with the storage choice.
- [ ] **Step 2:** Create `stream-check` with PostgreSQL storage through the UI; through the app proxy, POST a message and see it in GET within 5 s.
- [ ] **Step 3:** Same with SQLite storage (one run).
- [ ] **Step 4: Commit** `feat(bundles): add the Nisshi event-streaming pattern and starter`.

### Task 11: From scratch, docs and the retake video

**Files:**
- Create: `docs/demo/record-full-demo.cjs`, `docs/demo/README.md`, `docs/plan/calm-backstage-part3-status.html` (status page, from task 0)
- Modify: `README.md`, `TRACKS.md`, `FINDINGS.md`, `.gitignore`

- [ ] **Step 1: From scratch**: move `output/` to `output.part2-<date>/` (not deleted); `docker compose -f hub/docker-compose.yml down -v`; `yarn k8s:down`; then `yarn hub:up && yarn hub:seed`, `yarn k8s:up`, restart Backstage. Record each command's time.
- [ ] **Step 2: Warm**: build each starter once in the cluster (throwaway services deleted afterwards: Gitea repo, Flux objects, namespace, `output/` folder) so recording builds use the cache.
- [ ] **Step 3: Recorder** with the spec's chapters, a contents card (HTML page via `page.setContent`) and a chapter card before each chapter; writes `chapters.json` (start seconds). Run it; copy the `.webm` to `docs/demo/calm-backstage-full-demo.webm`; write `docs/demo/README.md` (contents with `mm:ss`).
- [ ] **Step 4: Docs**: README (new services, ports, flows, what to try), TRACKS (what is done and left), FINDINGS (new findings: Flux events, Gitea, upgrade overwrite, Nisshi notes, Red Hat BOM).
- [ ] **Step 5: Verify**: `yarn tsc && yarn test && yarn build:backend`; watch the video start, middle and end frames (extract three PNGs with Playwright's ffmpeg `-ss` if it can decode, else screenshots during recording).
- [ ] **Step 6: Commit** `docs: part 3 README, findings, tracks and the retake demo`.

## Execution

Native: Claude implements every task in this session (the tasks share interfaces tightly and Jim is away), then one
fresh reviewer checks the whole branch before the wrap-up. Status page: `docs/plan/calm-backstage-part3-status.html`,
published as a private Artifact and updated at every task start and finish.
