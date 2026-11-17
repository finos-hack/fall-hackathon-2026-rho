# calm-import

Converts a draw.io diagram into a CALM architecture. The Backstage app uses it to import a diagram into CALM Hub.

The converter is copied from [calm-import](https://github.com/finos/architecture-as-code), an experimental draw.io →
CALM converter in finos/architecture-as-code (`experimental/calm-import`, branch `feat/calm-import`, commit 590a3dcc).
It isn't on npm, so its core is copied here; each file names its source. Changes from the original:
- the reader uses `fast-xml-parser` instead of `xml2js`;
- crafted input can't make it slow or hang: linear scans instead of regular expressions, a guard against cycles in
  container parents, a size cap on compressed diagrams, malformed XML refused;
- there is no command line and no questions: every unsure choice keeps its guess (calm-import's `--yes`);
- `$schema` is CALM release 1.3, the one the calm CLI in calm-backstage validates against.

## Use

```ts
import { convertDrawio } from '@internal/calm-import';

const { architecture, report, guesses, nodes, relationships } = await convertDrawio(drawioText);
```

Inputs: `.drawio` and `.xml` (plain or compressed) and draw.io `.svg` exports. Only the first page is converted.
Boxes become nodes, arrows become `connects` relationships (the protocol comes from the label), boxes drawn around
others become `deployed-in` or `composed-of`, and positions go in `metadata._layout`. `guesses` lists, one line each,
every place where draw.io and CALM don't match one to one and the converter used its best guess.

`examples/trading.drawio` is a sample: 7 boxes and 7 arrows.

## C4

```ts
import { convertC4 } from '@internal/calm-import';

const result = await convertC4(c4Text); // the same result shape as convertDrawio
```

`convertC4` reads a C4 model and gives the CALM it stands for. It is built as the inverse of CALM's own C4 output
(the [C4 standard](https://calm.finos.org/standards/c4/1.1/) and the `c4-diagram` widget in
finos/architecture-as-code), so a diagram that CALM drew comes back as the CALM it was drawn from.

Inputs: Mermaid C4 (`C4Context`, `C4Container`, `C4Component`, `C4Deployment`) as a whole file or as the first such
```` ```mermaid ```` block of a Markdown file, and C4-PlantUML (`@startuml … @enduml`), including named arguments
(`$techn=`, `$descr=`). One diagram per import (later blocks are reported as skipped). `C4Dynamic`, `RelIndex` and
the PlantUML preprocessor (`!define`, `!if`…) are refused; `!include` lines are ignored and never fetched. Unknown
macros are listed as skipped. A block may be written on one line (`Boundary(b, "B") { Container(c, "C") }`).
Nesting is capped at 50 levels and every scan is linear, so crafted input stays fast.

| C4 | CALM | Certain? |
|---|---|---|
| `Person` | `actor` | yes |
| `System`, `SystemDb` | `system`, `database` | yes |
| `Container`/`Component` whose technology is a CALM node type (`"service"`, `"acme:worker"`) | that node type | yes |
| `ContainerDb`, `ComponentDb` | `database` | yes |
| `Container`/`Component` with other technology | `webclient` if the name or technology says browser/UI/SPA/portal, else `service`; the technology is kept in the description (`Technology: Java, Spring Boot`) | guess |
| `*Queue` | `system` (as for draw.io) | guess |
| `Enterprise_Boundary`, `System_Boundary` | `ecosystem` / `system` node, `composed-of` its contents | yes |
| `Container_Boundary` | the container node of that alias, created as `service` if missing | guess when created |
| `Boundary` whose name or type has draw.io's place words (cluster, k8s, kubernetes, vpc, network, subnet, zone, region) | `network` node, `deployed-in` its contents | yes |
| other `Boundary` | `system` node, `composed-of` | guess |
| `Deployment_Node`, `Node` | the node type in its third argument if that is a CALM node type, else `network`; `deployed-in` its contents | yes / guess |
| `Rel` from a `Person` | `interacts` | yes |
| other `Rel` | `connects`, the label as description | yes |
| `Rel` technology that is a CALM protocol (any case) | `protocol` | yes |
| `Rel` technology that is not (`Kafka`, `gRPC`) | no protocol, the technology kept in the description | guess |
| `Rel_Back` | direction reversed | yes |
| `BiRel` | one `connects` in the written direction | reported under "Changed" |
| label `… (N relationships)` | suffix stripped, one relationship | reported under "Changed" |
| `_Ext` | the same element; CALM marks external by position | reported under "Changed" |

Ids: a node's `unique-id` is its C4 alias; relationships are `<source>-to-<target>`, as in the draw.io import (numbered on a clash, which the report lists). The widget's
`Deployment_Node(deployment_x, …)` that wraps an element `x` of the same name is merged into one node. An empty
description becomes the name. There is no `metadata._layout`: C4 has no positions.

Round trip with upstream: the tests feed `convertC4` the expected output of the `c4-diagram` widget's own test cases
(`src/c4/__fixtures__/widget-cases.ts`, from commit b6d71d52) and compare node ids, node types, relationship
endpoints, descriptions and protocols with the CALM the widget was given; and upstream's docify C4 fixtures (older
generator, weak check: same elements, parents and endpoints). `examples/trading.c4.md` is the trading platform of
`trading.drawio` as a Mermaid C4 diagram.

## Development

This is its own npm project, separate from calm-backstage's Yarn workspaces. calm-backstage links it
(`link:../../../calm-import`) and uses the built JavaScript in `dist/`, so install it first:

```sh
cd calm-import
npm ci          # also builds dist/
npm test
npm run tsc
npm run build   # after changing the converter, before calm-backstage sees the change
```
