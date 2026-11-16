# CALM Hub Platform Connector

CALM Hub already has a standard deployment decorator and built-in views for it. The Deployments overlay on the
diagram puts a badge on each node a deployment covers, the badge shows the details, and "View all" opens the
Decorators tab filtered to deployments. The Control evaluations view draws a control that was not met on the
elements it names.

Those records are write-only. Any tool can write one and CALM Hub draws it, but CALM Hub does not understand the
platform behind it. It cannot tell whether a record is still true, start a deployment, or stop one that breaks a
control.

A **Platform Connector** is the plugin a firm writes to connect its own delivery platform to CALM Hub. It writes the
standard records, so CALM Hub's built-in views keep working and CALM Hub validates them. It adds what only the
platform knows: what really runs and whether that matches the record (drift), and the ability to act (deploy, behind
the firm's own approval and CALM Hub's controls). This one is the reference connector for GitOps on Kubernetes: Git,
a pull request and Flux. It is a [CALM Hub extension](https://calm.finos.org/tutorials/advanced/hub-extension/).
[PROFILE.md](PROFILE.md) is the contract another firm would implement against its own delivery platform.

It works with the services [calm-backstage](../calm-backstage) creates from a CALM pattern with a starter and
deployment rules: each lives in its own Gitea repository and Flux deploys it. Nothing in calm-backstage changes. Its
service card already reads the deployment records this connector writes.

![The Deployment tab in CALM Hub](docs/demo/deployment-tab.png)

▶ The demo (narrated; video link to follow) has a terminal on the cluster and CALM Hub side by side. It starts with
CALM Hub with no extensions and plugs this one in. Chapters and how to record it again: [docs/demo](docs/demo/README.md).

## What it adds to CALM Hub

Organised by the CALM Hub feature each piece appears in.

- **The Deploy action.** On an architecture version, under **Extensions**, "Deploy this version". After CALM Hub's
  confirmation the connector accepts the request at once and carries on in the background:
  1. runs `calm validate` on the version against its pattern and the Hub's controls (the controls gate). A version
     that fails is refused: it is recorded as a control evaluation and nothing reaches Git or the cluster;
  2. records a deployment decorator on the version, status `pending`, once the version has passed;
  3. re-renders the service's deployment rules (`k8s-deploy@<version>`) against that version, on a branch;
  4. opens a pull request in Gitea and merges it (`APPROVAL=auto`), or waits until someone merges it
     (`APPROVAL=manual`, the firm's change gate);
  5. asks Flux to reconcile, waits until it has applied the merge commit and the rollouts finish;
  6. marks the decorator `completed` (or `failed`, with the reason) with the pull request and commit.

  The reply to the action carries only the deployment id; CALM Hub does not show it. Progress is the decorator, which
  the diagram's Deployments overlay re-reads every 5 s. Until the version has passed the gate there is no decorator,
  and the connector reports the job as `validating` from memory.
- **The Deployment tab** (trimmed to platform facts). The environment, the version running and the version on
  screen, Flux's status, the commit it applied, and CALM Hub's newest deployment record with whether it matches what
  runs. A headline says whether a deployment is running, the platform has drifted (the first reason), or the version
  on screen is the one running. It does not repeat history: deployment history is the built-in Deployments view
  ("View all").
- **The node detail panel.** Select a node in the diagram and **Platform** appears under **Extensions** in the node
  sidebar: the Deployment that runs the node (replicas ready out of the replicas Git asks for, image, the commit
  Flux last applied), the NetworkPolicies that allow traffic in and out of it, and CALM Hub's newest record that
  covers the node. For a node or connection the platform does not run, it says so and lists any policy that names
  it.
- **The home page card and the Services screen.** The card on CALM Hub's home page counts the services, how many
  are in sync and how many have drifted. The Services screen lists every service with its running version, Flux's
  status and its drift. Both show every service in `DEPLOY_NAMESPACES` to any signed-in user, whatever their
  namespace read scope (the routes use the scope `authenticated`). CALM Hub draws only the first `stats` block of a
  card, not its alert, so drift shows on the card as the "Drifted" count and the Services screen has the detail.
- **Deployment records in the built-in Deployments view.** Every deployment is one standard deployment decorator,
  moved through its statuses, so the overlay, its badges and "View all" work without this connector's UI.
- **Refused versions in the built-in Control evaluations view.** A version refused at the controls gate is recorded
  as a `not-met` control evaluation naming the offending connection and its two nodes, so the overlay draws it in
  red on all three.
- **Commands.** For the CLI (`calm hub ext platform-connector <command>`, once a CLI with it is published) and as MCP
  tools `ext_platform-connector_status`, `ext_platform-connector_history` and `ext_platform-connector_deploy`.
  `status` includes the drift and the workloads; `history` lists deployments and refusals, newest first.

What it does not duplicate: deployment history. The built-in Deployments view and Decorators tab already show it,
so the tab links there and the `history` command reads the same records.

How it decides what is drift (`src/platform.ts`):

- Flux is not ready, or has not applied the commit `main` points at.
- A Deployment runs a different number of replicas from the one Git asks for, or has fewer ready than it runs.
- Git asks for a Deployment that does not run in the cluster.
- CALM Hub's newest completed record names a version other than the one `main` says is deployed.

A read that fails (the cluster, Flux, Git) is reported as a problem, never as drift, and the service is then
neither in sync nor drifted. "Deploying" comes only from this connector's own in-memory jobs: while one runs, drift
is not reported. A deployment another writer has in progress shows as drift until it finishes. Only Deployments are
treated as workloads; StatefulSets and DaemonSets are not read.

The routes need CALM Hub's `read` scope (tab, node panel, status, history), `write` scope (deploy) or only a signed-in
user (card and screen). Every call that deploys is in CALM Hub's audit log; its audit id is stored on the decorator
and in the commit message.

## Records it writes

**Deployment decorator.** One per deployment, created once the version has passed the gate and replaced (PUT) as it
moves on, so CALM Hub keeps its history. CALM Hub validates it against the standard it is stamped with:

- `$schema`: `https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json`
- `type`: `deployment`; `target-type`: `["architecture"]`; `unique-id`: `<architecture>-<version>-<8 characters of the audit id>`
- `target`: the version by name (`/calm/namespaces/<ns>/architectures/<name>/versions/<x.y.z>`, which Backstage and
  this connector read) and, when known, by numeric id (`/api/calm/namespaces/<ns>/architectures/<id>/versions/<x-y-z>`,
  which CALM Hub's UI looks up)
- `applies-to`: the architecture nodes the deployment runs
- `data`, from the standard: `start-time`, `end-time`, `status` (`pending`, `in-progress`, `completed`, `failed`),
  `deployment-details` (a URI: the commit Flux applied, else the pull request, else the repository), `notes`
- `data.kubernetes`: `cluster` (the kube context) and `namespace` (the service's namespace), and nothing else, which
  is all the standard allows
- `data.gitops`: `connector` (`platform-connector`), `environment`, `repository`, `pull-request`, `commit`,
  `requested-by`, `hub-audit-id` (the call's id in CALM Hub's audit log) and `architecture-version`. `repository`,
  `pull-request` and `commit` appear once known.

**Control evaluation.** One per version refused at the controls gate (`type: control-evaluation`, stamped with
`https://calm.finos.org/standards/control-evaluation/1.0/control-evaluation.decorator.standard.json`, which CALM Hub
validates), with the same two targets:

- `applies-to`: the first connection the version adds over the deployed one and its source and destination nodes; when
  there is none, every node of the version
- `data.control`: `unique-id` `security`, the `control-id` and `requirement-url` (the offending connection's security
  requirement, else the first one in the version, else the version's URL in CALM Hub), and `attached-to` (the
  connection)
- `data.status`: `not-met`; `evaluated-at`; `findings`: up to five `calm validate` errors (`subject`, `description`,
  `check`); `engine`: `calm validate`
- `data.actors`: `requested-by`, `hub-audit-id` and `connector`

**The GitOps sub-standard.** [standards/gitops.decorator.standard.json](standards/gitops.decorator.standard.json) is
the Kubernetes deployment standard plus a required `data.gitops` object with the fields above. To put it in CALM Hub's
Standards as `gitops-deployment`:

```sh
npx tsx scripts/publish-standard.ts [namespace]     # default hackathon; CALM_HUB_URL defaults to http://localhost:8090
```

CALM Hub validates decorators only against the standards it bundles. A standard registered through the Standards API
is stored, but a decorator is not checked against it. So the sub-standard documents `data.gitops` for anyone reading
the Standards API (CALM Hub's UI has no Standards page); CALM Hub does not enforce it. The connector stamps the bundled
1.0 Kubernetes standard, which CALM Hub does enforce: a record without `data.kubernetes.namespace` is refused with
HTTP 400 "Decorator does not match its $schema". [FINDINGS.md](FINDINGS.md) says why not the draft schema URL.

## Run it

You need calm-backstage's local stack running (see its README): `yarn install`, `yarn hub:up && yarn hub:seed`,
`yarn k8s:up`, and a service created with a starter and `k8s-deploy` (README step 7), for example `events-stream`
from the event-streaming Template.

```sh
cd calm-hub-deploy-extension
npm install
npm run hub:up          # restarts CALM Hub on finos/calm-hub:sha-96fe367 with this connector (keeps its data)
npm start               # the extension on :8093
```

`npm run hub:up` (`scripts/hub-up.sh`) layers `hub/compose.override.yml` over calm-backstage's
`hub/docker-compose.yml`: the Hub image with the extension framework (`latest` and `0.7.7` predate it), the manifest
folder, a P-256 signing key pair in `.keys/` (made on first run), and MCP turned on. Run calm-backstage's
`yarn hub:up` to go back to its own Hub. `scripts/hub-up.sh --without-extensions` runs the same Hub with no
extension loaded. To use a calm-backstage checkout elsewhere:
`CALM_BACKSTAGE_DIR=/path/to/calm-backstage npm run hub:up`.

Settings (environment variables; defaults match calm-backstage's `app-config.yaml`):

| Variable | Default | |
|---|---|---|
| `PORT` | `8093` | CALM Hub's `backend-url` points here (`http://host.docker.internal:8093`) |
| `CALM_HUB_URL` | `http://localhost:8090` | |
| `APPROVAL` | `auto` | `manual`: wait for a person to merge the pull request |
| `APPROVAL_TIMEOUT_SECONDS` | `1800` | |
| `FLUX_TIMEOUT_SECONDS` | `300` | |
| `DEPLOY_ENVIRONMENT` | `local` | recorded on every deployment (`data.gitops.environment`) |
| `CALM_KUBE_CONTEXT` | `calm-backstage` | the kube context, recorded as `data.kubernetes.cluster` |
| `CALM_KUBECONFIG` | `../calm-backstage/.kube/config` | the cluster `yarn k8s:up` made |
| `GITEA_URL`, `GITEA_USER`, `GITEA_PASSWORD` | `http://localhost:3300`, `calm`, `calm-local-dev` | |
| `GITEA_SERVICES_ORG` | `calm-services` | the Gitea organisation whose repositories are the services |
| `BUNDLE_REGISTRY_URL` | `http://localhost:5050` | where the deployment rules are pulled from |
| `DEPLOY_NAMESPACES` | `hackathon` | the namespaces whose services the card and screen list, and where unfinished deployments are closed on start-up |

## Try it

```sh
# A new version of events-stream that changes a pattern decision: the broker keeps its topics in SQLite.
npx tsx scripts/new-version.ts hackathon events-stream --choose "broker-storage=SQLite on the broker’s volume"
```

Open the new version in CALM Hub (http://localhost:8090, *hackathon* → *events-stream* → the newest version →
**Extensions**): the tab warns that the cluster runs the previous version. Choose **Deploy this version** → **Run**,
then watch the overlay on the **Diagram** and the record on **Decorators**. In the cluster the PostgreSQL Deployment
and its two network policies go away (`kubectl -n calm-events-stream get deploy,networkpolicies`).

```sh
# A version the pattern does not allow: the browser connects to the service directly, past the gateway.
npx tsx scripts/new-version.ts hackathon events-stream --connect web-client:stream-app
```

Deploying it stops at the controls gate: the decorator says `failed` with the validation error, and no pull request
is opened. The same through the API (what the CLI and MCP tools call):

```sh
curl -X POST -H 'content-type: application/json' -d '{}' \
  localhost:8090/api/calm/extensions/platform-connector/api/namespaces/hackathon/architectures/events-stream/versions/1.0.1/deployments
curl localhost:8090/api/calm/extensions/platform-connector/api/namespaces/hackathon/architectures/events-stream/status
```

Deploying the version that already runs is a no-op recorded as `completed` ("Already deployed").

## Try it

```sh
# A new version of events-stream that changes a pattern decision: the broker keeps its topics in SQLite.
npx tsx scripts/new-version.ts hackathon events-stream --choose "broker-storage=SQLite on the broker’s volume"
```

Open the new version in CALM Hub (http://localhost:8090, *hackathon* → *events-stream* → the newest version →
**Extensions**): the tab warns that the cluster runs the previous version. Choose **Deploy this version** → **Run**,
then watch the Deployments overlay on the **Diagram** and the record on **Decorators**. In the cluster the PostgreSQL
Deployment and its two network policies go away (`kubectl -n calm-events-stream get deploy,networkpolicies`).

```sh
# A version the pattern does not allow: the browser connects to the service directly, past the gateway.
npx tsx scripts/new-version.ts hackathon events-stream --connect web-client:stream-app
```

Deploying it stops at the controls gate. No deployment record is written and no pull request is opened. Instead the
Control evaluations overlay draws the connection and its two nodes as not met, and the finding says what
`calm validate` refused. The same through the API (what the CLI and MCP tools call):

```sh
curl -X POST -H 'content-type: application/json' -d '{}' \
  localhost:8090/api/calm/extensions/platform-connector/api/namespaces/hackathon/architectures/events-stream/versions/1.0.1/deployments
curl localhost:8090/api/calm/extensions/platform-connector/api/namespaces/hackathon/architectures/events-stream/status
```

Deploying the version that already runs is a no-op recorded as `completed` ("Already deployed").

Drift: change the cluster behind Git's back.

```sh
kubectl -n calm-events-stream scale deploy stream-app --replicas=0
```

The node panel for `stream-app` shows a warning (it runs 0 replicas, and Git asks for more), the Deployment tab headline says
the same, and the home page card counts one service as drifted (the connector reuses one read of the services for
10 s). Flux puts the replicas back at its next reconcile, or ask it to now:

```sh
kubectl -n flux-system annotate --overwrite kustomization/calm-events-stream reconcile.fluxcd.io/requestedAt="$(date +%s)"
```

The panel, tab and card then say in sync again.

## How it works

| File | Role |
|---|---|
| `extension/platform-connector/extension.json` | The manifest CALM Hub loads: routes, scopes, commands (with the profile's schemas) and the contributions (tab, action, detail panel, landing card, screen). The backend builds its route table from it. |
| `src/identity.ts` | Verifies CALM Hub's signed assertion (`X-Calm-Hub-Identity`) against the Hub's JWKS: signature, issuer, audience, method, path, body hash, expiry, replay. A port of upstream `identity.mjs`. |
| `src/app.ts`, `src/server.ts`, `src/routes.ts` | Exact-path routing (no decoding), verification, the namespace CALM Hub checked must be the one acted on, handlers. |
| `src/resolve.ts` | Context → architecture (by name, as the Hub UI sends it, or numeric id); reads the service's `catalog-info.yaml` and manifests from Gitea over HTTP; refuses a repository that names another namespace's architecture. |
| `src/record.ts` | The deployment decorator: the bundled Kubernetes standard with `data.kubernetes` and `data.gitops`, and reading records back (also the layout older versions wrote). |
| `src/evaluation.ts` | The control evaluation for a version refused at the controls gate, and reading it back for history. |
| `src/platform.ts` | What really runs (Deployments, NetworkPolicies, Flux, `main`) next to CALM Hub's newest record, and the drift between them. |
| `src/status.ts` | The status command and the history of deployments and refusals. |
| `src/blocks.ts` | The blocks CALM Hub draws: the tab, the node panel, the landing card and the Services screen. |
| `src/services.ts` | Every service in `DEPLOY_NAMESPACES`, for the card and screen (one read reused for 10 s). |
| `src/interrupted.ts` | On start-up, marks the deployments a restart cut off as `failed`. |
| `src/deploy/job.ts` | The deployment job: the controls gate, then the decorator lifecycle; one job per service at a time. |
| `src/deploy/kube.ts` | Flux and rollout helpers ported from calm-backstage's scaffolder actions. |
| `standards/gitops.decorator.standard.json`, `scripts/publish-standard.ts` | The GitOps sub-standard and the script that publishes it to CALM Hub's Standards. |
| `scripts/new-version.ts` | Stores the next version of an architecture, changed by a pattern decision or with a forbidden connection. |

It depends on calm-backstage's `calm-common` (Hub client, decorators, Flux, Gitea) and `calm-node` (git, kubectl,
`calm validate` and `calm template`, OCI bundles) through `file:` dependencies, run with `tsx`. `npm test` runs the
tests (vitest): the identity checks, the route table, the records, the platform views, and the read and deploy paths
against an in-memory Hub, a Gitea backed by real bare git repositories, and a kubectl whose Flux follows `main`.

## Limits

- CALM Hub runs without auth here, so every caller is `no-auth`: `requested-by` is always `no-auth`. With the Hub on
  OIDC it is the user, and a firm would check its own entitlements (who may deploy to production) with it.
- Jobs live in memory. On start-up, deployments this connector left `pending` or `in-progress` are marked `failed`.
  Three outcomes are held only in memory and lost on a restart: a job at the controls gate (`validating`), a
  controls-gate crash or a first deployment record CALM Hub refused (the job ends `failed`), and a refusal whose
  control evaluation could not be written (the job ends `refused` with no evaluation id). The status and history
  commands show them until then.
- The landing card and the Services screen are open to any signed-in user: they list every service in
  `DEPLOY_NAMESPACES`, whatever the user's namespace read scope.
- CALM Hub draws only a card's first `stats` block, so the card shows drift as a count; the detail is on the
  Services screen.
- One environment per instance. Promotion between environments would be one instance per environment, or the
  profile's `environment` input (PROFILE.md).
- "Deploying" comes only from this connector's own jobs; another writer's in-progress deployment shows as drift until
  it finishes. Only Deployments are workloads: StatefulSets and DaemonSets are not read.
- The sub-standard for `data.gitops` is not enforced by CALM Hub, which validates only the standards it bundles.
- Every record has a double target (the version by name, for Backstage, and by numeric id, for CALM Hub's UI). It is
  known and left; see FINDINGS.md.
- Backstage's working copy `output/<name>` and its catalog entity keep the old `architecture-version` until they are
  pulled again (the next upgrade does that). Backstage's own card for these records is out of scope for now.
- The connector only redeploys services that are already in Flux; it does not create the Flux objects.

[FINDINGS.md](FINDINGS.md) lists what the build found out about the extension framework and the standards, as
requests to CALM.
