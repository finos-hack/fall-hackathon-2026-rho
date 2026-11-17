import {
  NODE_TYPES,
  OTHER,
  PROTOCOLS,
  type Decision,
  type DecisionKind,
  type Note,
} from '../decide';
import {
  firstStatement,
  formatHint,
  looksLike,
  mermaidBlocks,
  type MermaidBlock,
} from '../markdown';
import { toResult, type ConvertResult } from '../result';
import {
  parseC4,
  stripFrontMatter,
  type C4Boundary,
  type C4Element,
} from './parse';

const CALM_SCHEMA = 'https://calm.finos.org/release/1.3/meta/calm.json';

// The words draw.io's label rule uses for a web client (WORD_RULES in ../decide.ts, which this file must not edit).
const WEB_CLIENT_WORDS = /\b(browser|web.?app|frontend|ui|spa|portal)\b/i;
// The words draw.io's container rule uses for a place things run in (DEPLOYED_IN in ../decide.ts, not exported).
const PLACE_WORDS = /\b(cluster|vpc|network|subnet|zone|region|k8s|kubernetes)\b/i;
// A node type of an organisation, such as the "acme:worker" that upstream's c4-diagram widget writes.
const CUSTOM_NODE_TYPE = /^[a-z][a-z0-9_-]*:[a-z0-9_-]+$/;
// The node type a boundary that has no element of its own becomes, when C4 fixes it.
const BOUNDARY_TYPES: Partial<Record<C4Boundary['kind'], string>> = {
  enterprise: 'ecosystem',
  system: 'system',
};
const C4_HEADERS = ['C4Context', 'C4Container', 'C4Component', 'C4Deployment'];
const COUNT_SUFFIX = ' relationships)';

interface NodeRec {
  id: string;
  type: string;
  name: string;
  description: string;
  person: boolean;
}

interface Found {
  text: string;
  firstLine: number;
  later: MermaidBlock[];
}

/**
 * Converts a C4 model (Mermaid C4 or C4-PlantUML, plain or inside a Markdown file) into a CALM architecture: the
 * inverse of the mapping in CALM's C4 standard. Every unsure choice keeps its guess and is listed in the result.
 */
export async function convertC4(text: string): Promise<ConvertResult> {
  const found = findDiagram(text);
  const model = parseC4(found.text, found.firstLine);
  if (model.elements.length + model.boundaries.length === 0) {
    throw new Error('The C4 diagram has no elements to convert');
  }

  const decisions: Decision[] = [];
  const notes: Note[] = [];
  const decide = (
    kind: DecisionKind,
    targetId: string,
    subject: string,
    value: string,
    certain: boolean,
    reason: string,
    options: string[] = [value],
  ) => {
    decisions.push({
      kind,
      targetId,
      subject,
      value,
      options,
      certain,
      reason,
      source: certain ? 'rule' : 'guess',
    });
  };
  const nodeType = (
    rec: NodeRec,
    value: string,
    certain: boolean,
    reason: string,
  ) => {
    rec.type = value;
    decide('node-type', rec.id, rec.name, value, certain, reason, [
      value,
      ...NODE_TYPES.filter(type => type !== value),
      OTHER,
    ]);
  };

  const byAlias = new Map<string, NodeRec>();
  const order: NodeRec[] = [];
  const recOfElement: Array<NodeRec | undefined> = [];
  const elementOfAlias = new Map<string, number>();

  // Elements first, so a boundary can reuse the element that has its alias.
  model.elements.forEach((element, index) => {
    if (byAlias.has(element.alias)) {
      notes.push({
        subject: element.name || element.alias,
        message: `alias "${element.alias}" is already used, kept the first`,
        kind: 'adjusted',
      });
      return;
    }
    const rec = elementNode(element, nodeType, notes);
    byAlias.set(element.alias, rec);
    elementOfAlias.set(element.alias, index);
    recOfElement[index] = rec;
  });

  // The nodes made from elements, for a set lookup per boundary (a scan of recOfElement per boundary is quadratic).
  const elementRecs = new Set(recOfElement);

  // Then every node in the order it is written.
  const recOfBoundary: Array<NodeRec | undefined> = [];
  type Item = { line: number; run: () => void };
  const items: Item[] = [];
  model.elements.forEach((element, index) => {
    const rec = recOfElement[index];
    if (rec) items.push({ line: element.line, run: () => order.push(rec) });
  });
  model.boundaries.forEach((boundary, index) => {
    items.push({
      line: boundary.line,
      run: () => {
        const existing = byAlias.get(boundary.alias);
        const mergedWith = mergedElement(
          boundary,
          index,
          model.elements,
          elementOfAlias,
          recOfElement,
        );
        if (mergedWith) {
          recOfBoundary[index] = mergedWith;
          byAlias.set(boundary.alias, mergedWith);
        } else if (existing) {
          if (!elementRecs.has(existing)) {
            notes.push({
              subject: boundary.name || boundary.alias,
              message: `alias "${boundary.alias}" is already used, kept the first`,
              kind: 'adjusted',
            });
          } else if (existing.type !== BOUNDARY_TYPES[boundary.kind]) {
            const expected = BOUNDARY_TYPES[boundary.kind];
            if (expected) {
              notes.push({
                subject: boundary.name || boundary.alias,
                message: `${boundary.macro} reuses the element ${boundary.alias}; kept it as ${existing.type}`,
                kind: 'adjusted',
              });
            }
          }
          recOfBoundary[index] = existing;
        } else {
          const rec = boundaryNode(boundary, nodeType);
          byAlias.set(boundary.alias, rec);
          recOfBoundary[index] = rec;
          order.push(rec);
        }
      },
    });
  });
  items.sort((a, b) => a.line - b.line).forEach(item => item.run());

  const used = new Set(order.map(rec => rec.id));
  const next = new Map<string, number>();
  // As build.ts does for draw.io and Mermaid: a taken id gets the next free number, and the report says so.
  const unique = (base: string, subject: string): string => {
    let id = base;
    if (used.has(id)) {
      let n = next.get(base) ?? 2;
      while (used.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
      next.set(base, n + 1);
      notes.push({
        subject,
        message: `id "${base}" was taken, used "${id}"`,
        kind: 'adjusted',
      });
    }
    used.add(id);
    return id;
  };

  const relationships: Array<Record<string, unknown>> = [];
  for (const rel of model.rels) {
    const known = [rel.from, rel.to].map(alias => byAlias.get(alias));
    const names = [rel.from, rel.to].map((alias, i) => known[i]?.name ?? alias);
    const unknown = known.findIndex(rec => !rec);
    if (unknown >= 0) {
      notes.push({
        subject: `${names[0]} → ${names[1]}`,
        message: `unknown alias "${unknown === 0 ? rel.from : rel.to}"`,
        kind: 'skipped',
      });
      continue;
    }
    const [source, destination] = rel.back
      ? [known[1]!, known[0]!]
      : [known[0]!, known[1]!];
    const subject = `${source.name} → ${destination.name}`;
    if (rel.both) {
      notes.push({
        subject: `${source.name} ↔ ${destination.name}`,
        message: 'two-way relationship, kept the written direction',
        kind: 'adjusted',
      });
    }
    const { label, count } = stripCount(rel.label || rel.description);
    if (count !== undefined) {
      notes.push({
        subject,
        message: `stood for ${count} relationships`,
        kind: 'adjusted',
      });
    }
    const id = unique(`${source.id}-to-${destination.id}`, subject);
    const technology = rel.technology.trim();
    const protocol = PROTOCOLS.find(
      known => known.toLowerCase() === technology.toLowerCase(),
    );
    let description = label;
    if (protocol) {
      decide(
        'protocol',
        id,
        subject,
        protocol,
        true,
        'technology is a CALM protocol',
      );
    } else if (technology) {
      decide(
        'protocol',
        id,
        subject,
        'none',
        false,
        `"${technology}" is not a CALM protocol`,
        ['none', ...PROTOCOLS],
      );
      description = withTechnology(label, technology);
    }
    relationships.push({
      'unique-id': id,
      ...(description ? { description } : {}),
      ...(protocol ? { protocol } : {}),
      'relationship-type': source.person
        ? { interacts: { actor: source.id, nodes: [destination.id] } }
        : {
            connects: {
              source: { node: source.id },
              destination: { node: destination.id },
            },
          },
    });
  }

  // Containment: each boundary holds what is written inside its block.
  const contents = new Map<NodeRec, { kind: string; nodes: Set<string> }>();
  const hold = (index: number, child: NodeRec | undefined) => {
    const holder = recOfBoundary[index];
    if (!holder || !child || holder === child) return;
    const boundary = model.boundaries[index]!;
    const kind =
      boundary.kind === 'deployment' || namesAPlace(boundary)
        ? 'deployed-in'
        : 'composed-of';
    const entry = contents.get(holder) ?? { kind, nodes: new Set<string>() };
    entry.nodes.add(child.id);
    contents.set(holder, entry);
  };
  model.elements.forEach((element, index) => {
    if (element.parent !== undefined) hold(element.parent, recOfElement[index]);
  });
  model.boundaries.forEach((boundary, index) => {
    if (boundary.parent !== undefined) hold(boundary.parent, recOfBoundary[index]);
  });
  model.boundaries.forEach((boundary, index) => {
    const rec = recOfBoundary[index]!;
    const entry = contents.get(rec);
    if (!entry || boundary.kind !== 'generic' || namesAPlace(boundary)) return;
    decide(
      'containment',
      rec.id,
      rec.name,
      'composed-of',
      false,
      'C4 boundary; could mean "runs in" or "is part of"',
      ['composed-of', 'deployed-in'],
    );
  });
  // In the order the boundaries are written; a duplicate alias shares its first boundary's entry.
  for (const holder of new Set(recOfBoundary)) {
    const entry = holder && contents.get(holder);
    if (!holder || !entry) continue;
    relationships.push({
      'unique-id': unique(`${holder.id}-${entry.kind}`, holder.name),
      'relationship-type': {
        [entry.kind]: { container: holder.id, nodes: [...entry.nodes] },
      },
    });
  }

  for (const skipped of model.skipped) {
    notes.push({
      subject: `line ${skipped.line}: ${skipped.text}`,
      message: 'not a C4 element or relationship this import reads',
      kind: 'skipped',
    });
  }
  for (const block of found.later) {
    notes.push({
      subject: `C4 diagram at line ${block.line}`,
      message: 'only the first C4 diagram of a file is imported',
      kind: 'skipped',
    });
  }

  return toResult({
    architecture: {
      $schema: CALM_SCHEMA,
      nodes: order.map(rec => ({
        'unique-id': rec.id,
        'node-type': rec.type,
        name: rec.name,
        description: rec.description,
      })),
      relationships,
    },
    nodeCount: order.length,
    relationshipCount: relationships.length,
    decisions,
    notes,
  });
}

type NodeTypeDecider = (
  rec: NodeRec,
  value: string,
  certain: boolean,
  reason: string,
) => void;

function elementNode(
  element: C4Element,
  nodeType: NodeTypeDecider,
  notes: Note[],
): NodeRec {
  const technology = element.technology.trim();
  const rec: NodeRec = {
    id: element.alias,
    type: '',
    name: element.name,
    description: '',
    person: element.kind === 'person',
  };
  if (!rec.name) {
    rec.name = element.alias;
    notes.push({
      subject: element.alias,
      message: 'no name, used the alias',
      kind: 'adjusted',
    });
  }
  const declared = calmNodeType(technology);
  if (element.queue) {
    nodeType(rec, 'system', false, 'C4 queue; CALM has no queue type');
  } else if (element.kind === 'person') {
    nodeType(rec, 'actor', true, 'C4 person');
  } else if (element.db) {
    nodeType(rec, 'database', true, `C4 ${element.kind} database`);
  } else if (element.kind === 'system') {
    nodeType(rec, 'system', true, 'C4 software system');
  } else if (declared) {
    nodeType(rec, declared, true, `technology is the CALM node type "${declared}"`);
  } else if (WEB_CLIENT_WORDS.test(`${rec.name} ${technology}`)) {
    nodeType(rec, 'webclient', false, 'name or technology looks like a web client');
  } else {
    nodeType(
      rec,
      'service',
      false,
      technology
        ? `technology "${technology}" is not a CALM node type`
        : 'no CALM node type given',
    );
  }
  const keep = technology && technology.toLowerCase() !== rec.type;
  rec.description = keepTechnology(
    element.description || rec.name,
    keep && !(declared && !element.queue && !element.db) ? technology : '',
  );
  if (element.external) {
    notes.push({
      subject: rec.name,
      message: 'external in C4; CALM marks external by position',
      kind: 'adjusted',
    });
  }
  return rec;
}

function boundaryNode(
  boundary: C4Boundary,
  nodeType: NodeTypeDecider,
): NodeRec {
  const technology = boundary.technology.trim();
  const rec: NodeRec = {
    id: boundary.alias,
    type: '',
    name: boundary.name || boundary.alias,
    description: '',
    person: false,
  };
  const declared = calmNodeType(technology);
  switch (boundary.kind) {
    case 'enterprise':
      nodeType(rec, 'ecosystem', true, 'C4 enterprise boundary');
      break;
    case 'system':
      nodeType(rec, 'system', true, 'C4 system boundary');
      break;
    case 'container':
      nodeType(
        rec,
        'service',
        false,
        'C4 container boundary with no container of its own',
      );
      break;
    case 'generic':
      if (namesAPlace(boundary)) {
        nodeType(
          rec,
          'network',
          true,
          'C4 boundary whose name or type names a place things run in',
        );
      } else {
        nodeType(rec, 'system', false, 'C4 boundary; CALM has no boundary type');
      }
      break;
    case 'deployment':
      if (declared) {
        nodeType(rec, declared, true, `type is the CALM node type "${declared}"`);
      } else {
        nodeType(
          rec,
          'network',
          false,
          technology
            ? `C4 deployment node; "${technology}" is not a CALM node type`
            : 'C4 deployment node with no node type',
        );
      }
      break;
  }
  rec.description = keepTechnology(
    boundary.description || rec.name,
    boundary.kind === 'deployment' && !declared ? technology : '',
  );
  return rec;
}

/** A generic Boundary whose name or type argument names a place things run in, as draw.io's container rule reads a label. */
function namesAPlace(boundary: C4Boundary): boolean {
  return (
    boundary.kind === 'generic' &&
    PLACE_WORDS.test(`${boundary.name} ${boundary.technology}`)
  );
}

/**
 * The widget writes a deployment node that a relationship names as `Deployment_Node(deployment_<id>, …)` holding an
 * element `<id>` of the same name; the two are one node.
 */
function mergedElement(
  boundary: C4Boundary,
  index: number,
  elements: C4Element[],
  elementOfAlias: Map<string, number>,
  recOfElement: Array<NodeRec | undefined>,
): NodeRec | undefined {
  if (boundary.kind !== 'deployment' || !boundary.alias.startsWith('deployment_')) {
    return undefined;
  }
  const elementIndex = elementOfAlias.get(boundary.alias.slice('deployment_'.length));
  const element = elementIndex === undefined ? undefined : elements[elementIndex];
  if (!element || element.parent !== index || element.name !== boundary.name) {
    return undefined;
  }
  return recOfElement[elementIndex!];
}

/** A CALM node type written as C4 technology: one of the built-in types, or a namespaced one. */
function calmNodeType(technology: string): string | undefined {
  const lower = technology.toLowerCase();
  const builtIn = NODE_TYPES.find(type => type === lower);
  if (builtIn) return builtIn;
  return CUSTOM_NODE_TYPE.test(technology) ? technology : undefined;
}

/** `Pays (2 relationships)`: the widget merges parallel relationships into one labelled with their count. */
function stripCount(label: string): { label: string; count?: number } {
  if (!label.endsWith(COUNT_SUFFIX)) return { label };
  const open = label.lastIndexOf(' (');
  const digits = label.slice(open + 2, label.length - COUNT_SUFFIX.length);
  if (open < 0 || digits === '' || digits.length > 6) return { label };
  for (let i = 0; i < digits.length; i++) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return { label };
  }
  return { label: label.slice(0, open).trim(), count: Number(digits) };
}

function keepTechnology(text: string, technology: string): string {
  return technology ? withTechnology(text, technology) : text;
}

function withTechnology(text: string, technology: string): string {
  if (!text) return `Technology: ${technology}`;
  const stop = ['.', '!', '?'].some(mark => text.endsWith(mark));
  return `${text}${stop ? ' ' : '. '}Technology: ${technology}`;
}

/** The diagram to read: the first C4 block of a Markdown file, a C4-PlantUML text, or a whole Mermaid C4 file. */
function findDiagram(text: string): Found {
  const c4Blocks = mermaidBlocks(text).filter(block =>
    isC4Header(block.body),
  );
  if (c4Blocks.length > 0) {
    const [first, ...later] = c4Blocks;
    return { text: first!.body, firstLine: first!.line, later };
  }
  if (text.split('\n').some(line => line.trim().startsWith('@startuml'))) {
    return { text, firstLine: 1, later: [] };
  }
  if (isC4Header(text)) return { text, firstLine: 1, later: [] };

  const found = looksLike(text);
  throw new Error(
    `No C4 diagram found; expected C4Context, C4Container, C4Component or C4Deployment${formatHint(
      found === 'drawio' || found === 'mermaid' ? found : undefined,
    )}`,
  );
}

function isC4Header(text: string): boolean {
  const word = firstStatement(stripFrontMatter(text)).split(/\s/)[0]!;
  return C4_HEADERS.includes(word) || word === 'C4Dynamic';
}
