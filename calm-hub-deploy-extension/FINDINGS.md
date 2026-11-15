# Findings: building a deployment extension on CALM Hub

What building `gitops-deploy` found out about CALM Hub's extension framework (finos/architecture-as-code `main` at
`96fe3674`, 15 Nov 2026), and what we would ask of CALM. Each item says what we saw and what the extension does about
it.

## Requests to CALM

| # | Request | Why |
|---|---|---|
| X1 | **Show an action's reply**, or at least a link from it | An action is fire-and-forget: the UI shows "running…", then "done" or "Extension request failed.", and drops the reply. A deployment that opens a change ticket cannot show the ticket. The extension writes progress to a decorator instead, which works because the diagram re-reads decorators every 5 s. |
| X2 | **Forms for actions**, drawn from the matching command's `input` schema | An action gets only the UI context (namespace, resource, version, selected node). Choosing an environment or approving with a comment is not possible from the UI; it needs one action per choice, or the CLI/MCP command. |
| X3 | **A manifest field for profiles**, e.g. `"implements": ["deployment/0"]` | Unknown manifest fields are errors, so an extension cannot say it implements the deployment profile; consumers can only guess from command names. |
| X4 | **Publish a CLI with `calm hub ext`** | `@finos/calm-cli` 1.72.0 (latest on npm) was released hours before the extension commands merged. Until the next release, commands are reachable only through MCP or the proxy URL. |
| X5 | **A versioned Hub image with the framework** | `finos/calm-hub:latest` and `0.7.7` are built from before the proxy, identity, actions and MCP tools. `main` builds are tagged only `main` and `sha-<short>`; we pin `sha-96fe367`. |
| X6 | **Document the context the UI sends** | The UI sends `resourceId` as the architecture's *name* (`events-stream`) when browsing by name, not its numeric id, and `resource=architectures/<name>`. The docs' examples suggest numeric ids. The extension accepts both. |
| X7 | **Accept the explicit-parameter EC keys LibreSSL writes, or say so in the docs** | The tutorial's `openssl genpkey` command, run with macOS's LibreSSL 3.3.6, writes the P-256 curve as explicit parameters; CALM Hub refuses the key ("must be an RSA key (RS256) or a P-256 key (ES256)"). `scripts/hub-up.sh` makes the key pair with Node's crypto instead. |

## Behaviour worth knowing

- **Route ambiguity is about overlapping paths**, not just literal counts: two routes clash only when they have the
  same method, could match the same path and have the same number of literal segments. Our five routes start fine.
- **The whole UI context is sent twice for an action**: as query parameters (sorted) and as the JSON body. The
  assertion's `htp` includes the query exactly as sent, with `%2F` in `resource`; verify against the raw URL.
- **`PUT` on a decorator replaces it** and CALM Hub keeps the old one under `/decorators/{id}/history`. That makes
  one decorator per deployment, moved through its statuses, a clean record.
- **Decorators with calm-common's `draft/2026-03` deployment `$schema` are accepted**, and the built-in *Deployments*
  view matches them by `type`, so the diagram overlay shows them. `DELETE` needs `global_admin`.
- **There is no Deployments tab any more**: deployments are on the generic *Decorators* tab, which shows every
  `data` field (links and dates formatted), so the profile's extra fields need no UI work.
- **The no-auth Hub signs every call as `sub: "no-auth"`**, and needs `calm.extensions.allow-without-auth=true` to
  start with an extension that has routes.
- **A backend on the Docker host** needs `backend-url=http://host.docker.internal:<port>` and `allow-http=true`
  (only literal loopback may be plain http), plus `extra_hosts: host.docker.internal:host-gateway` on Linux.
- **Compose with two `-f` files resolves relative paths against the first file's folder.** A relative mount in the
  override silently mounts an empty folder from calm-backstage and the Hub starts with no extension; the script
  passes absolute paths.
- **calm-backstage keeps working on the newer Hub**: catalog, architecture cards and its deployment list (which
  reads the name-based decorator target) all render against `sha-96fe367`.

## The pattern is the controls gate

calm-backstage's patterns make every node, relationship, protocol and description a constant; only the decisions
(`oneOf`/`anyOf`) vary. So the only versions that pass `calm validate` are the ones that change a pattern decision,
and anything else (a renamed node, a changed protocol, an extra connection) fails. For a deployment extension that is
exactly the gate a firm wants: an architecture can change only in the ways its pattern allows, and the deployment
refuses anything else before Git is touched.

## Reusing calm-backstage

- `calm-common` has no Backstage imports and `calm-node` uses Backstage only for types, so a plain Node service uses
  both through `file:` dependencies and `tsx`. The package must stay CommonJS: an ES module cannot import their named
  exports (`does not provide an export named 'CalmHubClient'`).
- The scaffolder actions' helpers (overlay, Flux wait, rollouts, node labels) import `@backstage/plugin-scaffolder-node`
  at load time, so they were ported (`src/deploy/kube.ts`), not imported. Moving them into `calm-node` would let both
  share them.
