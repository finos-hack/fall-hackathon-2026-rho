# Platform Connector profile, version 0 (draft)

CALM Hub has a standard deployment decorator and built-in views for it, but the records are write-only: CALM Hub draws
what a tool wrote and cannot tell whether it is still true, start a deployment, or stop one that breaks a control. A
firm's delivery platform (CD pipelines, change tickets, approvals, a CMDB) does not belong in CALM Hub. This profile is
the contract a firm's **Platform Connector**, a CALM Hub extension, implements so that CALM Hub, Backstage, agents and
CI can deploy an architecture version and see what really runs, **without knowing which firm or platform is behind
it**. A connector writes the standard records, so CALM Hub's built-in views keep working, and adds what only the
platform knows: drift, and the ability to act. This folder is the reference implementation, for GitOps on Kubernetes
(Git, a pull request, Flux); `extension/platform-connector/extension.json` has the full JSON Schemas.

## 1. Commands

A connector declares these commands in its manifest, with these names and at least these inputs and outputs. CALM Hub
turns each into `calm hub ext <id> <command>` and the MCP tool `ext_<id>_<command>`.

| Command | Scope | Input | Output |
|---|---|---|---|
| `status` | `read`, readOnly | `namespace`, `architecture` | `managed`, `environment`, `deployedVersion`, `latestVersion`, `ready`, `message`, `inSync`, `drift[]`, and anything else the platform knows (see below) |
| `history` | `read`, readOnly | `namespace`, `architecture` | `deployments[]`, newest first: `id`, `deploymentId`, `evaluationId`, `version`, `status`, `startTime`, `endTime`, `environment`, `requestedBy`, `pullRequest`, `details`, `notes` |
| `deploy` | `write`, `idempotent: true` | `namespace`, `architecture`, `version` (optional `environment`, see 5) | `deploymentId`, `status: "pending"` |
| `verify` | `read`, `idempotent: true` | `namespace`, `architecture` | `managed`, `version`, `observedAt`, `holding`, `checked`, `checks[]` (`element`, `check`, `result`, `expected`, `observed`, `paths`), `problems[]` |

`verify` collects runtime evidence now and records it (see 2, the evidence record). A connector also collects it on its
own, often enough that a broken control shows within seconds.

`status` also gives, in the reference connector: `repository`, `deploymentRules`, `commit`, `commitUrl`, `mainCommit`,
`fluxAtMain`, `deploying`, `problems[]`, `pendingApproval`, `workloads[]` (name, architecture node, replicas Git asks
for, replicas in the cluster, replicas ready, images) and `hubRecord` (CALM Hub's newest deployment record). A
platform other than Git and Flux reports its own equivalents.

`history` lists deployments, versions refused at the controls gate (status `refused`, with `evaluationId`, the id of the
control-evaluation decorator) and a job still at the gate (status `validating`, no `id`, only `deploymentId`). The
reference connector reads the records of the newest 10 versions, and gives `problems[]` with what memory holds when
CALM Hub does not answer in time.

`deploy` answers at once (CALM Hub gives a backend 10 s) and carries on in the background. The reply carries the
`deploymentId` only: there is no decorator yet, because the connector validates the version first and writes the
deployment decorator only once it passes. CALM Hub does not show an action's reply. Follow the deployment with
`history`, or on the diagram's Deployments overlay.

## 2. The records

### The deployment decorator

Every deployment is one decorator of CALM Hub's deployment standard (`type: "deployment"`), created once the version has
passed the controls gate and **replaced** (PUT) as it moves on, so the history of one deployment is the decorator's
history.

- `$schema`: the standard for the platform, from those CALM Hub bundles (here
  `https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json`). CALM Hub validates against
  it and refuses (HTTP 400) a record that does not match. Do not stamp a schema CALM Hub does not bundle: the record is
  then stored without validation. calm-common's draft deployment URL is one.
- `target`: both `/calm/namespaces/<ns>/architectures/<name>/versions/<x.y.z>` (name-based: Backstage, the CLI) and
  `/api/calm/namespaces/<ns>/architectures/<numeric id>/versions/<x-y-z>` (CALM Hub's UI looks decorators up by this one).
- `applies-to`: the `unique-id`s of the nodes the deployment runs.
- `data`, from the standard: `start-time`, `end-time`, `status`, `deployment-details` (a URI), `notes`, and the
  platform's own block (here `data.kubernetes`: `cluster`, `namespace`).
- `data.<platform>`: the connector's own sub-standard, so it can find its own records and say how it made the change.
  The reference connector uses `data.gitops` (`standards/gitops.decorator.standard.json`, which is the Kubernetes
  standard plus this block):

| Field | Meaning |
|---|---|
| `connector` | The extension id, so a connector can find its own records |
| `environment` | Where it was deployed: `local`, `uat`, `prod`... |
| `architecture-version` | The version deployed (also in the target, but easier to read here) |
| `requested-by` | CALM Hub's `sub` for the caller: who asked |
| `hub-audit-id` | The assertion's `jti`: the call's id in CALM Hub's audit log |
| `repository`, `pull-request`, `commit` | The platform's own terms for the change. `pull-request` is the firm's change reference (a ticket, for another platform); `commit` is what was deployed (a commit, an image digest, a release id) |

CALM Hub validates only the standards it bundles. A sub-standard registered through the Standards API (here
`npx tsx scripts/publish-standard.ts`) is stored and documents `data.<platform>`, but CALM Hub does not check records
against it.

### The control evaluation

A version refused at the controls gate is not a failed deployment, because no deployment started. The connector writes
one decorator of the control-evaluation standard (`type: "control-evaluation"`, `$schema`
`https://calm.finos.org/standards/control-evaluation/1.0/control-evaluation.decorator.standard.json`, validated by
CALM Hub) with the same two targets:

- `applies-to`: the connection the version adds and its two nodes, so CALM Hub's Control evaluations overlay draws
  them as not met. When the error is elsewhere, every node of the version.
- `data.control` (the requirement refused and, where there is one, the connection it is attached to), `data.status`
  `not-met`, `data.evaluated-at`, `data.findings[]` (one per validation error: `subject`, `description`, `check`) and
  `data.engine`.
- `data.actors`: `requested-by`, `hub-audit-id` and `connector`.

### The evidence record

What the platform observed about one control on one architecture element: one decorator per (environment, element,
check), replaced (PUT) as it changes, so CALM Hub keeps its history. `type: "evidence"`, `$schema` the base decorator
definition `https://calm.finos.org/release/1.3/meta/decorators.json#/defs/decorator` (CALM bundles no evidence
standard), the two targets of the running version, and:

- `applies-to`: the relationship for a connection check, the node for a node check.
- `data.evidence`: CALM's `meta/evidence.json`: `unique-id`, `evidence-paths[]` (where the raw evidence is, in the
  platform's own terms), `control-config-url` (the requirement's configuration, else the requirement).
- `data.control` (`unique-id`, `control-id`, `requirement-url`), `data.check`, `data.result` (`pass`, `fail`, `stale`,
  `not-applicable`), `data.expected`, `data.observed`, `data.observed-at`, `data.valid-until`, `data.sensor`,
  `data.deployment`.

Beside it, one control evaluation per element and control (the 1.0 standard, as above) mirrors the evidence of every
check on that element: `not-met` when any is `fail` or `stale` (one finding each), `not-applicable` when none applies,
else `met`, with `report-uri` pointing at the evidence and `data.engine` naming the sensor. It is what CALM Hub's
Control evaluations overlay draws. It carries no `actors.connector`, so `history` does not list it as a refusal.

## 3. Status semantics

### Deployment status

| Status | Means |
|---|---|
| `validating` | Only in `history` and `status`, from the connector's memory: the job is at the controls gate and CALM Hub holds no record yet |
| `pending` | Passed the controls gate and recorded; nothing has run yet |
| `in-progress` | Running. `notes` says the step: rendering, **waiting for approval: <link>**, applying |
| `completed` | The version runs in the environment. Also used for a deployment that had nothing to change |
| `failed` | It did not get there. `notes` says why: a rejected change, a timeout |
| `rolled-back` | It got there and was taken back out |
| `refused` | Only in `history`: the version failed the controls gate. See the control evaluation, not a deployment decorator |

### Drift

`status` says whether what really runs matches what the records and Git say. `drift` is a list of reasons and is empty
when in sync; `inSync` is true only when nothing is deploying, nothing could not be read and there is no drift. The
reference connector reports drift when:

- Flux is not ready, or has not applied the commit `main` points at;
- a Deployment runs a different number of replicas from the one Git asks for, or has fewer ready than it runs;
- a Deployment runs an image other than the one Git asks for (for each container that runs the image the overlay
  sets);
- Git asks for a Deployment that does not run;
- CALM Hub's newest completed deployment record names a different version from the one the platform runs.

Rules for any connector:

- A read that fails (the cluster, the platform's API) is a `problem`, never drift: the state is unknown. So is a read
  that times out: the reference connector gives each read of CALM Hub or Gitea 4 s, within CALM Hub's 10 s.
- While the connector has a job running for the service, drift is not reported: the service is `deploying`. That
  state comes from the connector's own jobs, so another writer's in-progress deployment can show as drift until it
  finishes (drift compares the newest completed record with what runs).
- The reference connector treats only Kubernetes Deployments as workloads, not StatefulSets or DaemonSets.

### Runtime evidence

- `pass` and `fail` are what the platform observed. A read that fails is not a `fail`: it is a problem, and the
  evidence ages.
- An observation holds until `valid-until`. Evidence past it is `stale`, and a stale check makes its control `not-met`:
  **evidence nobody refreshes is never shown as met**. A connector refreshes unchanged evidence before it expires (the
  reference connector: heartbeat 60 s, valid 90 s).
- While the connector deploys a service it does not record that service's evidence, and does not let it go stale.

## 4. The UI contributions

A connector contributes these to CALM Hub (the manifest's `contributes`). Each is blocks CALM Hub draws.

| Contribution | Where | Must show |
|---|---|---|
| `action` "Deploy this version" | The architecture version's Extensions | Nothing of its own: CALM Hub shows only running, done or failed. Progress is the decorator. Route `POST /deploy/{namespace}/{resourceType}/{resourceId}/{version}`, scope `write` |
| `designer-tab` "Deployment" | The architecture version's Extensions | Where the version runs, whether the version on screen is the one running, the platform's health (here Flux), and CALM Hub's newest deployment record with whether it matches. Headline: deploying, the first drift reason, or in sync. It does not repeat deployment history: CALM Hub's Deployments view has it |
| `detail-panel` "Platform" | The node sidebar, under Extensions | For the selected node: what the platform runs for it (workload, replicas ready, image, last change), what the platform allows in and out of it, and CALM Hub's newest record covering it. For a connection: its runtime evidence (whether the control holds, each check). For something the platform does not run, say so. Route scope `read` |
| `landing-card` | CALM Hub's home page | The count of services, how many are in sync and how many have drifted, as the **first** `stats` block: CALM Hub draws only that block of a card, not an alert after it. Route scope `authenticated` |
| `screen` "Services" | An extension screen | Every service the connector manages with its running version, platform health and drift (reasons in full). Route scope `authenticated` |

The card and the screen are not tied to a namespace, so they use the scope `authenticated`: any signed-in user sees
every service the connector is configured for, whatever their namespace read scope. A connector decides which services
that is (here `DEPLOY_NAMESPACES`) and should document it.

## 5. What a connector must guarantee

1. **Verify every request** with CALM Hub's assertion (signature, `iss`, `aud`, `htm`, `htp`, `bdh`, expiry, `jti`
   replay), and act only on the namespace CALM Hub checked (`ns`).
2. **Bind the request to what it deploys.** CALM Hub vouches only for the scope on the namespace; the connector checks
   that the thing it deploys belongs to that namespace's architecture.
3. **Nothing reaches the platform without passing the controls gate.** Validate the version against its pattern and
   controls before anything is written to the platform, and before the deployment decorator exists. A refusal is a
   control evaluation. A version that names no pattern cannot be validated, so it is refused too.
10. **Never show stale evidence as met** (3, Runtime evidence).
4. **Enforce the firm's own rules** with `sub`: who may deploy where, maker-checker, change windows. CALM Hub's
   scopes are per namespace only.
5. **One deployment per service at a time.** A second `deploy` while one runs is refused (HTTP 409).
6. **Record every outcome**, failures included, on the decorator; never leave one `pending` or `in-progress` after the
   work has stopped, including after a restart. The exceptions are the outcomes that happen before CALM Hub holds a
   record: a crash at the controls gate, a first write CALM Hub refused, or a control evaluation that could not be
   written. The reference connector holds these in memory only, so a restart loses them. A connector that can should
   keep them somewhere durable.
7. **Be idempotent**: deploying the version that already runs records a `completed` deployment and changes nothing.
8. **Every deploy carries CALM Hub's audit id**: the assertion's `jti` goes on the decorator (`hub-audit-id`) and in the
   platform's own record of the change (here the commit message).
9. **One environment per call.** `environment` is optional input; a connector with one environment ignores it.

## 6. Open questions

- CALM Hub has no way to say "this extension is a platform connector" (unknown manifest fields are errors), so
  consumers find connectors by command names. See FINDINGS.md.
- CALM Hub validates decorators only against the standards it bundles, so a platform's sub-standard cannot be enforced
  until it validates against registered standards (FINDINGS.md).
- Promotion (`uat` → `prod`) as one command, or as a deploy per environment with the firm's gate between them.
- A `rollback` command, and whether `rolled-back` is recorded on the old deployment or a new one.
- Where a connector keeps what it cannot yet write to CALM Hub (see guarantee 6).
- Who marks evidence stale when the connector itself is down: today nobody does (FINDINGS X11).
