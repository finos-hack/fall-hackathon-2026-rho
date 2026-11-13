/*
 * A small CALM architecture -> Mermaid flowchart transform, for the entity page diagram. The published CALM packages
 * have no browser-side diagram API, so this is ours (see FINDINGS.md). It reads only what it draws: nodes, and the
 * `connects`, `interacts`, `composed-of` and `deployed-in` relationships. Decision records (`options`) and anything
 * else are skipped.
 */

export interface MermaidOptions {
  /** Flowchart direction. Default `LR`. */
  direction?: 'LR' | 'TB';
}

export interface MermaidResult {
  /** The Mermaid `flowchart` source. */
  source: string;
  nodeCount: number;
  /** Relationships drawn (as edges or subgraphs). */
  drawnRelationships: number;
  /** Relationships not drawn: other types (e.g. `options`), or ones naming a node the architecture lacks. */
  skippedRelationships: number;
}

const isRecord = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ENTITIES: Record<string, string> = {
  '#': '#35;',
  '"': '#quot;',
  '<': '#lt;',
  '>': '#gt;',
  '&': '#amp;',
  '|': '#124;',
  '`': '#96;',
};

/** Escapes text for a quoted Mermaid label: Mermaid entity codes, one pass, no HTML from the document. */
export function escapeMermaidLabel(text: string): string {
  return text.replace(/[#"<>&|`]/g, c => ENTITIES[c]).replace(/\s+/g, ' ');
}

/** The node shape for a CALM node type: `[open, close]` around the quoted label. */
function shape(nodeType: string): [string, string] {
  switch (nodeType.toLowerCase()) {
    case 'database':
    case 'datastore':
    case 'data-asset':
      return ['[(', ')]'];
    case 'actor':
    case 'webclient':
    case 'person':
      return ['(', ')'];
    case 'system':
      return ['[[', ']]'];
    case 'network':
    case 'ecosystem':
    case 'ldap':
      return ['{{', '}}'];
    default:
      return ['[', ']'];
  }
}

function label(name: string, nodeType: string): string {
  const typeLine = nodeType
    ? `<br/><i>${escapeMermaidLabel(nodeType)}</i>`
    : '';
  return `"${escapeMermaidLabel(name)}${typeLine}"`;
}

const edgeLabel = (text: unknown) =>
  typeof text === 'string' && text.trim()
    ? `|"${escapeMermaidLabel(text.trim())}"|`
    : '';

/**
 * A Mermaid `flowchart` for a CALM architecture: one node per CALM node (name and node type, shape by type), a solid
 * edge per `connects` (labelled with the protocol), dotted edges per `interacts`, and `composed-of` / `deployed-in` as
 * subgraphs when every contained node has one container and containers do not nest (dotted edges otherwise).
 * Mermaid ids are generated (`n0`, `n1`, ...), so CALM unique-ids never clash with Mermaid syntax.
 */
export function toMermaid(
  architecture: unknown,
  options: MermaidOptions = {},
): MermaidResult {
  const arch = isRecord(architecture) ? architecture : {};
  const nodes = (Array.isArray(arch.nodes) ? arch.nodes : []).filter(
    (n: unknown): n is Record<string, any> =>
      isRecord(n) && typeof n['unique-id'] === 'string',
  );
  const relationships = (
    Array.isArray(arch.relationships) ? arch.relationships : []
  ).filter(isRecord);

  const ids = new Map<string, string>();
  for (const n of nodes) {
    if (!ids.has(n['unique-id'])) {
      ids.set(n['unique-id'], `n${ids.size}`);
    }
  }
  const idOf = (ref: unknown) =>
    typeof ref === 'string' ? ids.get(ref) : undefined;

  // Containment: composed-of and deployed-in. Subgraphs only when the structure is flat and unambiguous.
  const containment = relationships
    .map(r => {
      const t = r['relationship-type'] ?? {};
      const c = t['composed-of'] ?? t['deployed-in'];
      return isRecord(c)
        ? {
            kind: t['composed-of'] ? 'composed of' : 'deployed in',
            container: c.container,
            nodes: Array.isArray(c.nodes) ? c.nodes : [],
          }
        : undefined;
    })
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  const parentOf = new Map<string, string>();
  let simple = true;
  for (const c of containment) {
    if (!idOf(c.container) || c.nodes.some((n: unknown) => !idOf(n))) {
      simple = false;
      continue;
    }
    for (const n of c.nodes as string[]) {
      if (parentOf.has(n) && parentOf.get(n) !== c.container) {
        simple = false;
      }
      parentOf.set(n, c.container);
    }
  }
  const containers = new Set(containment.map(c => c.container));
  if ([...containers].some(c => parentOf.has(c))) {
    simple = false; // nested containers
  }
  const asSubgraphs = simple && containment.length > 0;

  const lines: string[] = [`flowchart ${options.direction ?? 'LR'}`];
  const nodeLine = (n: Record<string, any>, indent: string) => {
    const nodeType = typeof n['node-type'] === 'string' ? n['node-type'] : '';
    const name = typeof n.name === 'string' && n.name ? n.name : n['unique-id'];
    const [open, close] = shape(nodeType);
    return `${indent}${idOf(n['unique-id'])}${open}${label(
      name,
      nodeType,
    )}${close}`;
  };

  const byId = new Map(nodes.map(n => [n['unique-id'] as string, n]));
  const emitted = new Set<string>();
  if (asSubgraphs) {
    for (const container of containers) {
      const c = byId.get(container)!;
      const name = typeof c.name === 'string' && c.name ? c.name : container;
      lines.push(
        `  subgraph ${idOf(container)}["${escapeMermaidLabel(name)}"]`,
      );
      for (const [child, parent] of parentOf) {
        if (parent === container && !emitted.has(child)) {
          lines.push(nodeLine(byId.get(child)!, '    '));
          emitted.add(child);
        }
      }
      lines.push('  end');
      emitted.add(container);
    }
  }
  for (const n of nodes) {
    if (!emitted.has(n['unique-id'])) {
      lines.push(nodeLine(n, '  '));
      emitted.add(n['unique-id']);
    }
  }

  let drawn = 0;
  let skipped = 0;
  for (const r of relationships) {
    const t = isRecord(r['relationship-type']) ? r['relationship-type'] : {};
    if (isRecord(t.connects)) {
      const s = idOf(t.connects.source?.node);
      const d = idOf(t.connects.destination?.node);
      if (s && d) {
        lines.push(`  ${s} -->${edgeLabel(r.protocol)} ${d}`);
        drawn++;
      } else {
        skipped++;
      }
    } else if (isRecord(t.interacts)) {
      const a = idOf(t.interacts.actor);
      const targets = (
        Array.isArray(t.interacts.nodes) ? t.interacts.nodes : []
      ).map(idOf);
      if (a && targets.length && targets.every(Boolean)) {
        for (const d of targets) {
          lines.push(`  ${a} -.->${edgeLabel(r.description)} ${d}`);
        }
        drawn++;
      } else {
        skipped++;
      }
    } else if (isRecord(t['composed-of']) || isRecord(t['deployed-in'])) {
      if (asSubgraphs) {
        drawn++;
        continue;
      }
      const c = t['composed-of'] ?? t['deployed-in'];
      const kind = t['composed-of'] ? 'composed of' : 'deployed in';
      const p = idOf(c.container);
      const children = (Array.isArray(c.nodes) ? c.nodes : []).map(idOf);
      if (p && children.length && children.every(Boolean)) {
        for (const child of children) {
          lines.push(`  ${p} -.-o|"${kind}"| ${child}`);
        }
        drawn++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }

  return {
    source: `${lines.join('\n')}\n`,
    nodeCount: nodes.length,
    drawnRelationships: drawn,
    skippedRelationships: skipped,
  };
}
