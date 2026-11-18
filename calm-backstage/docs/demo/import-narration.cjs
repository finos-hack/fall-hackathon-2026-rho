// The import demo's voiceover, as data: one beat per step, in the order record-import-demo.cjs speaks them. The words
// are also the caption. Keep file names out of the spoken text, and respell words the voice gets wrong in
// pronunciation.cjs (the caption keeps the real spelling).
//
// ctx: { drawio, c4 } — the guesses each import listed, read from the run, so the narration says what the screen shows.
const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const count = n => WORDS[n] ?? String(n);
const Count = n => count(n).replace(/^./, c => c.toUpperCase());

module.exports = function narration(ctx = { drawio: 2, c4: 5 }) {
  return [
    // ---- 1. Diagrams already exist
    {
      id: 'intro',
      text: 'Most teams already have architecture diagrams: in draw.io, in C4, or as Mermaid in a README. This demo turns them into CALM architectures, from Backstage, in one step.',
    },
    // ---- 2. The diagram
    {
      id: 'diagram',
      text: 'Here is a trading platform in draw.io. A trader uses a web UI, which calls an order service over HTTPS. The order service publishes to a Kafka queue, a risk service reads it, and trades go to a database. Some of it runs in a Kubernetes cluster. There is also a legend and a TODO note, as real diagrams have.',
    },
    // ---- 3. The Template
    {
      id: 'template',
      text: 'In Backstage, there is one Template: Import a diagram.',
    },
    {
      id: 'form',
      text: 'It asks for a name, the format: draw.io, C4, or a Mermaid flowchart, and the file.',
    },
    // ---- 4. Import the draw.io file
    { id: 'drawio-import', text: 'We import the draw.io file.' },
    {
      id: 'drawio-steps',
      text: 'The Template converts it to CALM, validates it against the CALM schema, and stores it in CALM Hub.',
    },
    {
      id: 'drawio-result',
      text: `Seven nodes and seven relationships. Where draw.io and CALM don't match one to one, the import makes a guess and lists it. ${Count(
        ctx.drawio,
      )} here: CALM has no queue type, so the queue becomes a system, and Kafka isn't a CALM protocol. The legend and the note are left out.`,
    },
    // ---- 5. The same platform in C4
    {
      id: 'c4-source',
      text: 'Many teams write C4 instead. This is the same platform as a Mermaid C4 diagram: persons, containers, a database, a queue, and relationships with their technology.',
    },
    {
      id: 'c4-import',
      text: "Import a diagram reads it too. It applies CALM's own C4 standard in reverse: a person becomes an actor, a container becomes the node type its technology names, and a boundary becomes a composed-of relationship. Because it's the exact reverse, a C4 diagram that CALM generated imports back to the same architecture.",
    },
    {
      id: 'c4-result',
      text: `Again seven nodes and seven relationships. ${Count(
        ctx.c4,
      )} guesses this time: technologies like Java and Spring Boot aren't CALM node types, so those containers become services.`,
    },
    // ---- 6. In CALM Hub
    {
      id: 'hub',
      text: 'And here is the draw.io import in CALM Hub itself, the FINOS architecture repository: a CALM architecture like any other, with its nodes and relationships, ready for patterns, controls and the rest of the CALM tooling.',
    },
    // ---- 7. Mermaid flowcharts
    {
      id: 'mermaid',
      text: 'A plain Mermaid flowchart works the same way, with the draw.io rules: shapes and labels decide the node types, subgraphs the containment.',
    },
    // ---- 8. In the catalog
    {
      id: 'catalog-drawio',
      text: 'Each import is a Component in the catalog, drawn from CALM Hub.',
    },
    { id: 'catalog-c4', text: 'And the C4 one draws the same architecture.' },
    // ---- 9. The wrong file
    {
      id: 'wrong',
      text: 'Choose the wrong format, and the import stops before anything is stored, and says which format the file looks like.',
    },
    // ---- 10. Recap
    {
      id: 'recap',
      text: 'So: draw.io, C4 or Mermaid in; a valid CALM architecture out, in CALM Hub and the catalog, with every guess listed for review. No new dependencies, and the same checks for every format.',
    },
  ];
};
