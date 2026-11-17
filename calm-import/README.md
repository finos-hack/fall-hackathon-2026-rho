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
