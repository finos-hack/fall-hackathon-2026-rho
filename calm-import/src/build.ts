// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import { subjectOf, type Decision, type Note } from './decide';
import type { Box, Diagram } from './diagram';

const CALM_SCHEMA = 'https://calm.finos.org/release/1.3/meta/calm.json';

export interface BuildResult {
  architecture: Record<string, unknown>;
  notes: Note[];
  nodeCount: number;
  relationshipCount: number;
}

export function build(diagram: Diagram, decisions: Decision[]): BuildResult {
  const valueOf = (kind: Decision['kind'], targetId: string) =>
    decisions.find(d => d.kind === kind && d.targetId === targetId)?.value;
  const notes: Note[] = [];
  const used = new Set<string>();
  // The next suffix to try for each base, so that many ids with one base do not each count up from 2 again.
  const nextSuffix = new Map<string, number>();
  const unique = (base: string, subject: string) => {
    let id = base;
    if (used.has(id)) {
      let n = nextSuffix.get(base) ?? 2;
      while (used.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
      nextSuffix.set(base, n + 1);
    }
    if (id !== base)
      notes.push({
        subject,
        message: `id "${base}" was taken, used "${id}"`,
        kind: 'adjusted',
      });
    used.add(id);
    return id;
  };

  const ids = new Map<string, string>();
  const unnamed = new Map<string, number>();
  const nodes = diagram.boxes.map(box => {
    const nodeType = valueOf('node-type', box.id) ?? 'system';
    const [first, ...rest] = box.label.split('\n');
    let name = first ?? '';
    if (!name) {
      const n = (unnamed.get(nodeType) ?? 0) + 1;
      unnamed.set(nodeType, n);
      name = `${nodeType.charAt(0).toUpperCase()}${nodeType.slice(1)} ${n}`;
      notes.push({
        subject: subjectOf(box),
        message: `no label, named "${name}"`,
        kind: 'adjusted',
      });
    }
    const id = unique(slug(name) || slug(nodeType) || 'node', subjectOf(box));
    ids.set(box.id, id);
    return {
      'unique-id': id,
      'node-type': nodeType,
      name,
      description: rest.join(' ') || name,
    };
  });

  const relationships: Array<Record<string, unknown>> = [];
  for (const arrow of diagram.arrows) {
    const source = ids.get(arrow.sourceId ?? '');
    const destination = ids.get(arrow.targetId ?? '');
    if (!source || !destination) continue;
    const protocol = valueOf('protocol', arrow.id);
    relationships.push({
      'unique-id': unique(
        `${source}-to-${destination}`,
        `${source} → ${destination}`,
      ),
      ...(arrow.label ? { description: arrow.label.replace(/\n/g, ' ') } : {}),
      ...(protocol && protocol !== 'none' ? { protocol } : {}),
      'relationship-type': {
        connects: {
          source: { node: source },
          destination: { node: destination },
        },
      },
    });
  }
  for (const container of diagram.boxes.filter(box => box.isContainer)) {
    const kind = valueOf('containment', container.id) ?? 'composed-of';
    const children = diagram.boxes
      .filter(box => box.containerId === container.id)
      .map(box => ids.get(box.id)!);
    if (children.length === 0) continue;
    const containerId = ids.get(container.id)!;
    relationships.push({
      'unique-id': unique(`${containerId}-${kind}`, subjectOf(container)),
      'relationship-type': {
        [kind]: { container: containerId, nodes: children },
      },
    });
  }

  const byId = new Map(diagram.boxes.map(box => [box.id, box]));
  // Readers of text formats (Mermaid, C4) have no positions: they give every box a zero geometry and no layout.
  const positioned = diagram.boxes.some(
    ({ geometry: g }) =>
      g.x !== 0 || g.y !== 0 || g.width !== 0 || g.height !== 0,
  );
  const layout = Object.fromEntries(
    diagram.boxes.map(box => [
      ids.get(box.id)!,
      layoutOf(box, byId.get(box.containerId ?? '')),
    ]),
  );

  return {
    architecture: {
      $schema: CALM_SCHEMA,
      nodes,
      relationships,
      ...(positioned ? { metadata: { _layout: layout } } : {}),
    },
    notes,
    nodeCount: nodes.length,
    relationshipCount: relationships.length,
  };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function layoutOf(box: Box, container: Box | undefined) {
  const { x, y, width, height } = box.geometry;
  return {
    x: Math.round(x - (container?.geometry.x ?? 0)),
    y: Math.round(y - (container?.geometry.y ?? 0)),
    w: Math.round(width),
    h: Math.round(height),
  };
}
