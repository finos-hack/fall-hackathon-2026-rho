import { build } from '../build';
import {
  decide,
  NODE_TYPES,
  subjectOf,
  type Decision,
  type Note,
} from '../decide';
import type { Diagram } from '../diagram';
import { firstStatement, mermaidBlocks } from '../markdown';
import { resolve } from '../resolve';
import { toResult, type ConvertResult } from '../result';
import { flowchartExtras, otherFormatHint, parseFlowchart } from './parse';

// The headers of Mermaid diagrams (C4 ones start with "C4"). A text that starts with none of them is not Mermaid.
const MERMAID_HEADERS = [
  'flowchart',
  'flowchart-elk',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'classDiagram-v2',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantChart',
  'requirementDiagram',
  'gitGraph',
  'mindmap',
  'timeline',
  'zenuml',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'kanban',
  'architecture-beta',
  'radar-beta',
  'treemap-beta',
];

const WRITTEN_BY_CALM_TOOL = 'node type written by a CALM tool';

/**
 * Converts a Mermaid flowchart (a whole file, or the first flowchart block of a Markdown file) into a CALM
 * architecture, with draw.io's rules for node types, containers and protocols. A flowchart drawn by a CALM tool (the
 * entity card's type line, the block-architecture widget's classes) gets its node types back with certainty.
 */
export async function convertMermaid(text: string): Promise<ConvertResult> {
  const { body, line, skipped } = pickDiagram(text);
  const parsed = parseFlowchart(body, line);
  const { diagram: withEdges, notes: interfaceNotes } =
    withoutInterfaces(parsed);
  if (withEdges.boxes.length === 0) {
    throw new Error('The flowchart has no nodes to convert');
  }
  const { diagram, groups } = withoutContainmentEdges(parsed, withEdges);
  const { decisions, notes } = decide(diagram);
  const resolved = await resolve(writtenTypes(parsed, decisions));
  const result = build(diagram, resolved);
  const containment = addContainment(diagram, result.architecture, groups);
  const interacts = interactsFromActors(parsed, diagram, result.architecture);
  // The label of an interacts is its description, as the card writes it: a guess that it is no protocol says nothing.
  const kept = resolved.filter(
    d =>
      !(d.kind === 'protocol' && d.source === 'guess' && interacts.has(d.targetId)),
  );
  const unlabelled = new Set(
    diagram.boxes.filter(box => !box.label).map(box => box.id),
  );
  const mermaidWording = <T extends { subject: string }>(item: T): T => {
    const id = item.subject.startsWith('cell ') ? item.subject.slice(5) : '';
    return unlabelled.has(id) ? { ...item, subject: `node ${id}` } : item;
  };
  return toResult({
    architecture: result.architecture,
    nodeCount: result.nodeCount,
    relationshipCount: result.relationshipCount + containment.length,
    decisions: [...kept, ...containment].map(mermaidWording),
    notes: [...skipped, ...interfaceNotes, ...notes, ...result.notes].map(
      mermaidWording,
    ),
  });
}

/** The Mermaid source to read: the first flowchart block of a Markdown file, or the whole text when it has no block. */
function pickDiagram(text: string): {
  body: string;
  line: number;
  skipped: Note[];
} {
  const blocks = mermaidBlocks(text);
  if (blocks.length === 0) {
    const header = firstStatement(text).split(/\s/)[0]!;
    if (!MERMAID_HEADERS.includes(header) && !header.startsWith('C4')) {
      throw new Error(
        `No Mermaid flowchart found (flowchart or graph)${otherFormatHint(text)}`,
      );
    }
    return { body: text, line: 1, skipped: [] };
  }
  const isFlowchart = (body: string) =>
    /^(flowchart|graph)(\s|$)/.test(firstStatement(body));
  const chosen = blocks.find(block => isFlowchart(block.body)) ?? blocks[0]!;
  return {
    body: chosen.body,
    line: chosen.line,
    skipped: blocks
      .filter(block => block !== chosen)
      .map(
        (block): Note => ({
          subject: `diagram block at line ${block.line}`,
          message: 'not converted (only the first flowchart is)',
          kind: 'skipped',
        }),
      ),
  };
}

/** The `:::iface` nodes of the block-architecture widget are interfaces, which CALM keeps on a node: left out. */
function withoutInterfaces(diagram: Diagram): {
  diagram: Diagram;
  notes: Note[];
} {
  const { classes } = flowchartExtras(diagram);
  const interfaces = new Set(
    diagram.boxes
      .filter(box => classes.get(box.id)?.includes('iface'))
      .map(box => box.id),
  );
  if (interfaces.size === 0) return { diagram, notes: [] };
  return {
    diagram: {
      ...diagram,
      boxes: diagram.boxes.filter(box => !interfaces.has(box.id)),
      arrows: diagram.arrows.filter(
        arrow =>
          !interfaces.has(arrow.sourceId ?? '') &&
          !interfaces.has(arrow.targetId ?? ''),
      ),
    },
    notes: diagram.boxes
      .filter(box => interfaces.has(box.id))
      .map(
        (box): Note => ({
          subject: box.label.split('\n')[0] || box.id,
          message: 'interface',
          kind: 'skipped',
        }),
      ),
  };
}

/** Makes the node type certain where a CALM tool wrote it: an italic type line, or a class that is a node type. */
function writtenTypes(diagram: Diagram, decisions: Decision[]): Decision[] {
  const { classes, typeLines } = flowchartExtras(diagram);
  return decisions.map(decision => {
    if (decision.kind !== 'node-type') return decision;
    const value =
      typeLines.get(decision.targetId) ??
      classes
        .get(decision.targetId)
        ?.find(name => (NODE_TYPES as readonly string[]).includes(name));
    if (!value) return decision;
    return {
      ...decision,
      value,
      options: [value],
      certain: true,
      source: 'rule',
      reason: WRITTEN_BY_CALM_TOOL,
    };
  });
}

const DRAWN_CONTAINMENT: Record<string, 'composed-of' | 'deployed-in'> = {
  'composed of': 'composed-of',
  'deployed in': 'deployed-in',
};

/** Containment the entity card drew as dotted edges: one container, one kind, its nodes in the order drawn. */
interface ContainmentGroup {
  container: string;
  kind: 'composed-of' | 'deployed-in';
  nodes: Set<string>;
}

/**
 * The entity card draws containment that is not a flat subgraph (containers that nest, a node with two containers) as
 * dotted circle-headed edges labelled `composed of` or `deployed in`, from the container to each node. Those edges are
 * containment, not connections: they are taken out of the diagram before the draw.io rules see them.
 */
function withoutContainmentEdges(
  parsed: Diagram,
  diagram: Diagram,
): { diagram: Diagram; groups: ContainmentGroup[] } {
  const { dotted, circleHead } = flowchartExtras(parsed);
  const groups = new Map<string, ContainmentGroup>();
  const arrows = diagram.arrows.filter(arrow => {
    const kind = DRAWN_CONTAINMENT[arrow.label.trim().toLowerCase()];
    if (
      !kind ||
      !dotted.has(arrow.id) ||
      !circleHead.has(arrow.id) ||
      arrow.sourceId === arrow.targetId
    ) {
      return true;
    }
    const container = arrow.sourceId!;
    const key = `${kind} ${container}`;
    const group = groups.get(key) ?? { container, kind, nodes: new Set() };
    group.nodes.add(arrow.targetId!);
    groups.set(key, group);
    return false;
  });
  if (groups.size === 0) return { diagram, groups: [] };
  return { diagram: { ...diagram, arrows }, groups: [...groups.values()] };
}

/**
 * Appends one `composed-of` / `deployed-in` relationship per group to the built architecture, with ids made unique
 * against those already there; returns the containment decisions, which are rules.
 */
function addContainment(
  diagram: Diagram,
  architecture: Record<string, unknown>,
  groups: ContainmentGroup[],
): Decision[] {
  if (groups.length === 0) return [];
  // build writes one node per box, in order.
  const nodes = architecture.nodes as Array<Record<string, string>>;
  const idOf = new Map(
    diagram.boxes.map((box, i) => [box.id, nodes[i]!['unique-id']!]),
  );
  const relationships = architecture.relationships as Array<
    Record<string, unknown>
  >;
  const used = new Set(relationships.map(r => r['unique-id'] as string));
  const boxes = new Map(diagram.boxes.map(box => [box.id, box]));
  const decisions: Decision[] = [];
  for (const group of groups) {
    const container = idOf.get(group.container)!;
    const base = `${container}-${group.kind}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    relationships.push({
      'unique-id': id,
      'relationship-type': {
        [group.kind]: {
          container,
          nodes: [...group.nodes].map(node => idOf.get(node)!),
        },
      },
    });
    decisions.push({
      kind: 'containment',
      targetId: group.container,
      subject: subjectOf(boxes.get(group.container)!),
      value: group.kind,
      options: [group.kind],
      certain: true,
      source: 'rule',
      reason: `dotted edges labelled "${group.kind.replace('-', ' ')}", as CALM's entity card draws containment`,
    });
  }
  return decisions;
}

/**
 * Rule: a dotted edge from an actor is an `interacts`, as CALM's entity card draws one. A solid edge from an actor
 * stays `connects`, so a card's `connects` from an actor comes back as it was. Returns the ids of those arrows.
 */
function interactsFromActors(
  parsed: Diagram,
  diagram: Diagram,
  architecture: Record<string, unknown>,
): Set<string> {
  const { dotted } = flowchartExtras(parsed);
  const nodes = architecture.nodes as Array<Record<string, string>>;
  const byBox = new Map(diagram.boxes.map((box, i) => [box.id, nodes[i]!]));
  const relationships = architecture.relationships as Array<
    Record<string, unknown>
  >;
  const rewritten = new Set<string>();
  // build writes one relationship per arrow, in order: every Mermaid arrow has both ends.
  diagram.arrows.forEach((arrow, i) => {
    const source = byBox.get(arrow.sourceId!);
    const target = byBox.get(arrow.targetId!);
    if (!dotted.has(arrow.id) || source?.['node-type'] !== 'actor') return;
    rewritten.add(arrow.id);
    relationships[i]!['relationship-type'] = {
      interacts: {
        actor: source['unique-id'],
        nodes: [target!['unique-id']],
      },
    };
  });
  return rewritten;
}
