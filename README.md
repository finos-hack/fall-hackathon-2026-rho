# CALM Backstage

**Hackathon Track:** CALM

FINOS [CALM](https://calm.finos.org) architectures in [Backstage](https://backstage.io). Developers see the CALM
architectures from CALM Hub in the Backstage catalog and see each architecture as a diagram on its service page. They
can also create a new service from a CALM pattern: the pattern's options become form choices, and a template bundle
renders the code. The new service can then be built and deployed to a local Kubernetes cluster, with network
policies made from its architecture, and its architecture and deployment are recorded in CALM Hub.

## Demo

[![CALM Backstage deployment demo](https://img.youtube.com/vi/XhFmQQTT6-k/maxresdefault.jpg)](https://youtu.be/XhFmQQTT6-k)

▶ [Watch the full walkthrough on YouTube](https://youtu.be/XhFmQQTT6-k): from a CALM pattern to a service running on
local Kubernetes, with its architecture and deployment in CALM Hub.

▶ [The first walkthrough](https://youtu.be/zQ1cLPv3Fmk) covers the catalog, the diagrams and creating a service,
without the deployment.

## Features so far

- **CALM Hub in the catalog.** An entity provider reads the configured CALM Hub namespaces and adds:
  - architectures as Components (`calm-architecture`);
  - patterns, controls and template bundles as Resources;
  - one software template per pattern.

  The catalog graph links architecture → pattern → controls.
- **Architecture diagrams on entity pages.** A CALM card shows the pattern, the controls it references, node and
  relationship counts, and a Mermaid diagram. It works for architectures read live from the Hub and for services
  created from a pattern.
- **Pattern pages.** Each pattern page lists its decisions (`oneOf` and `anyOf`) with their choices and the template
  bundles that fit, and links straight to "create from this pattern".
- **Create a service from a pattern:**
  - The pattern's decisions become form choices: pick one data store, any add-ons, and a template bundle version.
  - A **Details** step runs `calm generate` and asks for the values it leaves open (hosts, ports, owner, service
    name).
  - The run fills the architecture, checks it with `calm validate` against the Hub's controls, renders the chosen
    bundle with `calm template`, writes the service to `output/<name>/` and registers it in the catalog. The new
    service page shows its own architecture diagram.
- **Template bundles with versions, from an OCI registry.** `web-service@1.0.0`, `@2.0.0` and `@3.0.0` render
  different code from the same pattern. Bundles are pushed to a local OCI registry as versioned artifacts, and a newly
  pushed version shows up in the catalog and the form without a restart. Version 3.0.0 renders a small runnable Node
  service, a `Dockerfile` and Kubernetes manifests.
- **Deploy to local Kubernetes.** With bundle 3.0.0 the run builds the service's image in a local minikube cluster
  (its own profile, with its own kubeconfig in the repository) and deploys the service, its data store, add-ons and
  gateway to their own namespace.
- **Network policies from CALM.** Each `connects` relationship in the architecture becomes an allow rule on top of a
  default deny, so the gateway cannot reach the database directly. The card lists the policies, and a
  **Kubernetes** tab shows the pods.
- **Recorded in CALM Hub.** The generated architecture is stored in CALM Hub, and each deployment is recorded on it
  as a deployment decorator, which the Hub's own UI shows on its Deployments tab with a link back to Backstage.
- **Published CALM only.** Every CALM step runs the published `@finos/calm-cli`. The few parts the CLI does not offer
  as an API live in one small package and are written up as requests to the CALM project.
- **Runs locally in a few minutes.** CALM Hub, MongoDB and the bundle registry run in Docker with seed content: a
  pattern with a `oneOf` and an `anyOf` decision, two architectures and a controls domain.

## CALM Hub deployment extension

[`calm-hub-deploy-extension/`](calm-hub-deploy-extension/README.md) is a
[CALM Hub extension](https://calm.finos.org/tutorials/advanced/hub-extension/) that deploys an architecture version
from CALM Hub itself: a **Deployment** tab and a **Deploy this version** action, plus the same operations as CLI
commands and MCP tools. It checks the version against its pattern and controls, re-renders the service's deployment
rules, opens a pull request in Gitea and lets Flux apply it, recording every step as a deployment decorator. It is a
reference for a firm plugging its own deployment platform into CALM Hub ([PROFILE.md](calm-hub-deploy-extension/PROFILE.md)),
and runs on this stack without changing Backstage.

## draw.io, C4 and Mermaid import

[`calm-import/`](calm-import/README.md) converts a draw.io, C4 or Mermaid diagram into a CALM architecture (the Backstage Template "Import a diagram" has a Format field for the three): boxes become nodes,
arrows become relationships, and every place where the two don't match is listed as a guess. It is copied from the
experimental calm-import converter in finos/architecture-as-code.

## Installation

You need Docker, Node 26 (Node 22 and 24 are allowed but untested) and the Yarn version bundled in the project. The
deployment also needs `minikube` and `kubectl`.

```sh
(cd calm-import && npm ci)      # the diagram converter, linked into Backstage; builds its dist/
cd calm-backstage
yarn install
yarn hub:up && yarn hub:seed    # CALM Hub on http://localhost:8090, bundle registry on 5050
yarn k8s:up                     # optional: minikube profile calm-backstage, for deployments
yarn start                      # Backstage on http://localhost:3100 (backend on 7107)
```

Open http://localhost:3100 and choose **Enter** to sign in as a guest.

## Usage example

1. **Catalog:** filter on the `calm` tag to see the seeded architectures `orders-service` and `catalog-service` and
   the services created so far.
2. **`orders-service`:** the CALM architecture card with its diagram.
3. **`pattern-web-service`:** the decisions, the bundles that fit, and the link to create a service.
4. **Create → Web Service (CALM pattern):** name the service, choose its options, fill in the details, then create
   it. The task page links to the new service. With `web-service@3.0.0` and the deploy box ticked, the run also
   deploys it to the local cluster; the service page then shows its network policies, its pods on the
   **Kubernetes** tab and the deployment recorded in CALM Hub.

[`calm-backstage/README.md`](calm-backstage/README.md) has the full guide and the package layout.

## Development setup

```sh
cd calm-backstage
yarn tsc
yarn test            # options reader, Hub clients, placeholders, Mermaid transform, OCI client, actions
yarn build:backend
```

- [`calm-backstage/FINDINGS.md`](calm-backstage/FINDINGS.md): what we learnt about the CALM CLI, CALM Hub and
  Backstage, and requests to the CALM project.
- [`calm-backstage/docs/superpowers/`](calm-backstage/docs/superpowers/): the design and one plan per build step.

## Roadmap

The remaining work is cut into independent tracks. [`calm-backstage/TRACKS.md`](calm-backstage/TRACKS.md) has the
details.

1. **Catalog:** flows, decorators, every version, and pattern → architecture implementations.
2. **Entity page:** a richer diagram, control status from evidence, and a flows tab.
3. **Pattern options:** better `anyOf` UX, a description for each choice, and nested patterns.
4. **Template bundles:** bundles now come from an OCI registry; still to do: a "bundle update available" notice.
5. **Publish:** the generated architecture is now stored in CALM Hub; still to do: publish to GitHub.
6. **Provisioning:** local Kubernetes deployment works; still to do: redeploying an existing service, recording
   failed deployments, and connecting an existing provisioning flow as an extension.

## Contributing

Coding agents should follow [AGENTS.md](./AGENTS.md), which requires a Developer Certificate of Origin sign-off on every commit.

**All commits** must be signed with a DCO signature to avoid being flagged by the DCO Bot. This means that your commit log message must contain a line that looks like the following one, with your actual name and email address:

```
Signed-off-by: John Doe <john.doe@example.com>
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more information.

## License

Copyright 2026 FINOS

Distributed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).

SPDX-License-Identifier: [Apache-2.0](https://spdx.org/licenses/Apache-2.0)
