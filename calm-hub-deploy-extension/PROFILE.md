# CALM deployment extension profile, version 0 (draft)

A firm deploys with its own platform: CD pipelines, change tickets, approvals, a CMDB. None of that belongs in CALM
Hub. This profile is the contract a firm's CALM Hub extension implements so that CALM Hub, Backstage, agents and CI
can deploy an architecture version, and read what was deployed, **without knowing which firm or platform is behind
it**. `gitops-deploy` in this folder is the reference implementation (Git, a pull request, Flux).

## 1. Commands

An implementation declares these commands in its manifest, with these names and at least these inputs and outputs
(`extension/platform-connector/extension.json` has the full JSON Schemas). CALM Hub turns each into
`calm hub ext <id> <command>` and the MCP tool `ext_<id>_<command>`.

| Command | Scope | Input | Output |
|---|---|---|---|
| `status` | `read`, readOnly | `namespace`, `architecture` | `managed`, `environment`, `deployedVersion`, `latestVersion`, `ready`, `message`, and anything else the platform knows (repository, commit, change ticket) |
| `history` | `read`, readOnly | `namespace`, `architecture` | `deployments[]`: `id`, `version`, `status`, `startTime`, `endTime`, `environment`, `requestedBy`, `details`, `notes` |
| `deploy` | `write`, `idempotent: true` | `namespace`, `architecture`, `version` (optional `environment`, see 4) | `deploymentId`, `decoratorId`, `status: "pending"` |

`deploy` answers at once (CALM Hub gives a backend 10 s) and carries on in the background. Its progress is the
decorator, not the reply: CALM Hub does not show an action's reply.

An implementation should also contribute a **designer tab** (where the version runs, and whether the version on
screen is the one deployed) and an **action** ("Deploy this version") on the same route shape as `gitops-deploy`.

## 2. The deployment decorator

Every deployment is one decorator of the FINOS deployment standard (`type: "deployment"`), created when the deployment
is accepted and **replaced** (PUT) as it moves on, so the history of one deployment is the decorator's history.

- `target`: both `/calm/namespaces/<ns>/architectures/<name>/versions/<x.y.z>` (name-based: Backstage, the CLI) and
  `/api/calm/namespaces/<ns>/architectures/<numeric id>/versions/<x-y-z>` (CALM Hub's UI looks decorators up by
  this one).
- `applies-to`: the `unique-id`s of the nodes the deployment runs.
- `data`, from the standard: `start-time`, `end-time`, `status`, `deployment-details` (a URI), `notes`.
- `data`, added by this profile (the standard allows extra properties; CALM Hub's Decorators tab shows them):

| Field | Meaning |
|---|---|
| `environment` | Where it was deployed: `local`, `uat`, `prod`… |
| `architecture-version` | The version deployed (also in the target, but easier to read here) |
| `requested-by` | CALM Hub's `sub` for the caller: who asked |
| `hub-audit-id` | The assertion's `jti`: the call's id in CALM Hub's audit log |
| `deployed-by` | The extension id, so an implementation can find its own records |
| `change-ref` | The firm's change ticket, when there is one (`gitops-deploy` uses `pull-request`) |
| `commit` | What was deployed, in the platform's own terms (a commit, an image digest, a release id) |

## 3. Status semantics

| Status | Means |
|---|---|
| `pending` | Accepted; nothing has run yet |
| `in-progress` | Running. `notes` says the step: validating, rendering, **waiting for approval: <link>**, applying |
| `completed` | The version runs in the environment. Also used for a deployment that had nothing to change |
| `failed` | It did not get there. `notes` says why: a failed control, a rejected change, a timeout |
| `rolled-back` | It got there and was taken back out |

## 4. What an implementation must guarantee

1. **Verify every request** with CALM Hub's assertion (signature, `iss`, `aud`, `htm`, `htp`, `bdh`, expiry, `jti`
   replay), and act only on the namespace CALM Hub checked (`ns`).
2. **Bind the request to what it deploys.** CALM Hub vouches only for the scope on the namespace; the
   implementation checks that the thing it deploys belongs to that namespace's architecture.
3. **Gate on the architecture.** Validate the version against its pattern and controls before anything is changed.
4. **Enforce the firm's own rules** with `sub`: who may deploy where, maker-checker, change windows. CALM Hub's
   scopes are per namespace only.
5. **Record every outcome**, failures included, on the decorator; never leave one `pending` or `in-progress` after
   the work has stopped.
6. **Be idempotent**: deploying the version that already runs records a `completed` deployment and changes nothing.
7. **One environment per call.** `environment` is optional input; an implementation with one environment ignores it.

## 5. Open questions

- CALM Hub has no way to say "this extension implements the deployment profile" (unknown manifest fields are
  errors), so consumers find implementations by command names. See FINDINGS.md.
- Promotion (`uat` → `prod`) as one command, or as a deploy per environment with the firm's gate between them.
- A `rollback` command, and whether `rolled-back` is recorded on the old deployment or a new one.
