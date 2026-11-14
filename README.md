# CALM Backstage

**Hackathon Track:** _to be confirmed_

FINOS [CALM](https://calm.finos.org) architectures in [Backstage](https://backstage.io). Developers see the CALM
architectures from CALM Hub in the Backstage catalog and see each architecture as a diagram on its service page. They
can also create a new service from a CALM pattern: the pattern's options become form choices, and a template bundle
renders the code.

## Demo

[![CALM Backstage demo](https://img.youtube.com/vi/zQ1cLPv3Fmk/maxresdefault.jpg)](https://youtu.be/zQ1cLPv3Fmk)

▶ [Watch the walkthrough on YouTube](https://youtu.be/zQ1cLPv3Fmk)

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
- **Template bundles with versions.** `web-service@1.0.0` and `@2.0.0` render different code from the same pattern.
  Version 2.0.0 adds a `Dockerfile` and a `deploy/` folder, and the choices change the compose services.
- **Published CALM only.** Every CALM step runs the published `@finos/calm-cli`. The few parts the CLI does not offer
  as an API live in one small package and are written up as requests to the CALM project.
- **Runs locally in a few minutes.** CALM Hub and MongoDB run in Docker with seed content: a pattern with a `oneOf`
  and an `anyOf` decision, two architectures and a controls domain.

## Installation

You need Docker, Node 26 (Node 22 and 24 are allowed but untested) and the Yarn version bundled in the project.

```sh
cd calm-backstage
yarn install
yarn hub:up && yarn hub:seed    # CALM Hub on http://localhost:8090
yarn start                      # Backstage on http://localhost:3100 (backend on 7107)
```

Open http://localhost:3100 and choose **Enter** to sign in as a guest.

## Usage example

1. **Catalog:** filter on the `calm` tag to see the seeded architectures `orders-service` and `catalog-service` and
   the services created so far.
2. **`orders-service`:** the CALM architecture card with its diagram.
3. **`pattern-web-service`:** the decisions, the bundles that fit, and the link to create a service.
4. **Create → Web Service (CALM pattern):** name the service, choose its options, fill in the details, then create
   it. The task page links to the new service.

[`calm-backstage/README.md`](calm-backstage/README.md) has the full guide and the package layout.

## Development setup

```sh
cd calm-backstage
yarn tsc
yarn test            # options reader, Hub client, placeholders, Mermaid transform
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
4. **Template bundles:** bundles from Git, npm or CALM Hub, and a "bundle update available" notice.
5. **Publish:** publish to GitHub, and register the generated architecture in CALM Hub.
6. **Provisioning:** connect an existing provisioning flow as an extension.

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
