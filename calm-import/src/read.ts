// Ported from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc) to fast-xml-parser.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  Annotation,
  Arrow,
  Box,
  Diagram,
  Geometry,
  ShapeHint,
} from './diagram';
import { decodeDrawio } from './decode';

interface XmlNode {
  '#name': string;
  $?: Record<string, string>;
  $$?: XmlNode[];
}

/** fast-xml-parser's `preserveOrder` output: one key per element (its name, holding the children) plus `:@`. */
type OrderedNode = Record<string, unknown> & { ':@'?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Keep attribute values as written (xml2js does not trim them) and decode &#xa; and the other character references.
  trimValues: false,
  htmlEntities: true,
});

interface Cell {
  id: string;
  label: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  geometry?: Geometry;
  /** x and y are fractions of the parent's size (draw.io ports and badges). */
  relative: boolean;
}

export async function readDrawio(content: string): Promise<Diagram> {
  const { graphModelXml, pageNames } = await decodeDrawio(content);
  const parsed = parseModel(graphModelXml).find(
    node => node['#name'] === 'mxGraphModel',
  );
  const root = parsed?.$$?.find(child => child['#name'] === 'root');
  const cells = (root?.$$ ?? [])
    .map(toCell)
    .filter((cell): cell is Cell => cell !== undefined);
  const byId = new Map(cells.map(cell => [cell.id, cell]));

  const absolute = new Map<string, Geometry>();
  const absoluteGeometry = (cell: Cell): Geometry | undefined => {
    if (!cell.geometry || cell.attrs.vertex !== '1') return undefined;
    const known = absolute.get(cell.id);
    if (known) return known;
    absolute.set(cell.id, cell.geometry);
    const parent = byId.get(cell.attrs.parent ?? '');
    const offset = parent ? absoluteGeometry(parent) : undefined;
    const { x, y } =
      cell.relative && offset
        ? {
            x: cell.geometry.x * offset.width,
            y: cell.geometry.y * offset.height,
          }
        : cell.geometry;
    const geometry = offset
      ? { ...cell.geometry, x: x + offset.x, y: y + offset.y }
      : cell.geometry;
    absolute.set(cell.id, geometry);
    return geometry;
  };

  const edgeLabels = new Map<string, string[]>();
  const annotations: Annotation[] = [];
  const candidates: Array<{ cell: Cell; geometry: Geometry }> = [];
  const legends: Geometry[] = [];

  for (const cell of cells) {
    if (cell.attrs.vertex !== '1') continue;
    const parent = byId.get(cell.attrs.parent ?? '');
    if (parent?.attrs.edge === '1') {
      if (cell.label)
        edgeLabels.set(parent.id, [
          ...(edgeLabels.get(parent.id) ?? []),
          cell.label,
        ]);
      continue;
    }
    const geometry = absoluteGeometry(cell);
    if (!geometry || (cell.style.group === '1' && !cell.label)) continue;
    const kind = annotationKind(cell);
    if (kind) {
      annotations.push({ id: cell.id, label: cell.label, kind });
    } else if (/^legend\b/i.test(cell.label)) {
      annotations.push({ id: cell.id, label: cell.label, kind: 'legend' });
      legends.push(geometry);
    } else {
      candidates.push({ cell, geometry });
    }
  }

  const boxes: Box[] = [];
  for (const { cell, geometry } of candidates) {
    if (legends.some(legend => holds(legend, geometry))) {
      annotations.push({ id: cell.id, label: cell.label, kind: 'legend' });
    } else {
      boxes.push({
        id: cell.id,
        label: cell.label,
        shape: shapeHint(cell.style),
        geometry,
        isContainer: false,
      });
    }
  }

  const boxById = new Map(boxes.map(box => [box.id, box]));
  const drawioParent = (box: Box): Box | undefined => {
    let parent = byId.get(byId.get(box.id)?.attrs.parent ?? '');
    // Non-box cells that are each other's parent (draw.io never writes that) give no box parent.
    const seen = new Set<string>();
    while (parent && !boxById.has(parent.id)) {
      if (seen.has(parent.id)) return undefined;
      seen.add(parent.id);
      parent = byId.get(parent.attrs.parent ?? '');
    }
    return parent ? boxById.get(parent.id) : undefined;
  };
  for (const { cell } of candidates) {
    const box = boxById.get(cell.id);
    if (
      box &&
      looksLikeContainer(cell) &&
      boxes.some(
        other =>
          other !== box &&
          (holds(box.geometry, other.geometry) || drawioParent(other) === box),
      )
    ) {
      box.isContainer = true;
    }
  }
  const containers = boxes.filter(box => box.isContainer);
  for (const box of boxes) {
    const parent = drawioParent(box);
    const nearest = parent?.isContainer
      ? parent
      : containers
          .filter(
            container =>
              container !== box && holds(container.geometry, box.geometry),
          )
          .sort((a, b) => area(a.geometry) - area(b.geometry))[0];
    if (nearest) box.containerId = nearest.id;
  }

  const boxIds = new Set(boxes.map(box => box.id));
  const arrows: Arrow[] = cells
    .filter(cell => cell.attrs.edge === '1')
    .map(cell => {
      const sourceId = boxIds.has(cell.attrs.source ?? '')
        ? cell.attrs.source
        : undefined;
      const targetId = boxIds.has(cell.attrs.target ?? '')
        ? cell.attrs.target
        : undefined;
      const startHead =
        cell.style.startArrow !== undefined && cell.style.startArrow !== 'none';
      const endHead = cell.style.endArrow !== 'none';
      // eslint-disable-next-line no-nested-ternary -- copied as is
      const heads: Arrow['heads'] = startHead
        ? endHead
          ? 'both'
          : 'start'
        : endHead
        ? 'end'
        : 'none';
      return {
        id: cell.id,
        label: [cell.label, ...(edgeLabels.get(cell.id) ?? [])]
          .filter(Boolean)
          .join('\n'),
        ...(heads === 'start'
          ? { sourceId: targetId, targetId: sourceId }
          : { sourceId, targetId }),
        heads,
      };
    });

  return { boxes, arrows, annotations, pageNames };
}

/**
 * Parses the model XML. fast-xml-parser does not check well-formedness itself (xml2js did, and an unclosed cell would
 * swallow the cells after it), and it refuses attribute names such as `constructor` with a message about prototype
 * pollution; both become messages about the diagram.
 */
function parseModel(xml: string): XmlNode[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new Error(
      `The diagram is not well-formed XML (line ${valid.err.line}): ${valid.err.msg}`,
    );
  }
  let parsed: OrderedNode[];
  try {
    parsed = parser.parse(xml) as OrderedNode[];
  } catch (error) {
    const name = /^\[SECURITY\] Invalid name: "([^"]*)"/.exec(
      error instanceof Error ? error.message : '',
    )?.[1];
    if (name === undefined) throw error;
    throw new Error(
      `The diagram has an attribute name that cannot be read: ${name}`,
    );
  }
  return toXmlNodes(parsed);
}

/** The element nodes in document order, in the shape xml2js gives with `explicitChildren` (text nodes dropped). */
function toXmlNodes(nodes: OrderedNode[]): XmlNode[] {
  return nodes.flatMap(node => {
    const name = Object.keys(node).find(key => key !== ':@');
    if (!name || name === '#text' || name.startsWith('?')) return [];
    const children = toXmlNodes(node[name] as OrderedNode[]);
    return [
      {
        '#name': name,
        ...(node[':@'] ? { $: node[':@'] } : {}),
        ...(children.length > 0 ? { $$: children } : {}),
      },
    ];
  });
}

function toCell(node: XmlNode): Cell | undefined {
  const wrapped = node['#name'] === 'object' || node['#name'] === 'UserObject';
  const mxCell = wrapped
    ? node.$$?.find(child => child['#name'] === 'mxCell')
    : node;
  if (!mxCell || mxCell['#name'] !== 'mxCell') return undefined;
  const attrs = { ...(mxCell.$ ?? {}) };
  const id = (wrapped ? node.$?.id : undefined) ?? attrs.id ?? '';
  if (id === '0' || id === '1') return undefined;
  const style = parseStyle(attrs.style ?? '');
  const geometryAttrs = mxCell.$$?.find(
    child => child['#name'] === 'mxGeometry',
  )?.$;
  return {
    id,
    label: cleanLabel(
      wrapped ? node.$?.label ?? '' : attrs.value ?? '',
      style.html === '1',
    ),
    attrs,
    style,
    relative: geometryAttrs?.relative === '1',
    geometry:
      geometryAttrs && (geometryAttrs.relative !== '1' || attrs.vertex === '1')
        ? {
            x: Number(geometryAttrs.x ?? 0),
            y: Number(geometryAttrs.y ?? 0),
            width: Number(geometryAttrs.width ?? 0),
            height: Number(geometryAttrs.height ?? 0),
          }
        : undefined,
  };
}

function parseStyle(style: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const part of style.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) props[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    else props[trimmed] = '1';
  }
  return props;
}

function annotationKind(cell: Cell): Annotation['kind'] | undefined {
  const shape = cell.style.shape ?? '';
  if (shape === 'note') return 'note';
  if (shape === 'image' || cell.style.image !== undefined) return 'image';
  if (cell.style.text === '1' || cell.style.edgeLabel === '1') return 'text';
  return undefined;
}

function shapeHint(style: Record<string, string>): ShapeHint {
  const shape = style.shape ?? '';
  if (
    shape === 'queue' ||
    (shape.startsWith('mxgraph.') && /queue|topic/i.test(shape))
  )
    return 'queue';
  if (
    shape === 'cylinder' ||
    shape === 'cylinder3' ||
    shape.includes('database')
  )
    return 'cylinder';
  if (
    shape === 'actor' ||
    shape === 'umlActor' ||
    shape.includes('general.user') ||
    shape.includes('person')
  )
    return 'person';
  if (shape === 'cloud') return 'cloud';
  if (shape === 'hexagon') return 'hexagon';
  if (shape === 'rhombus' || style.rhombus === '1') return 'diamond';
  if (shape === 'document' || shape === 'mxgraph.basic.document')
    return 'document';
  if (shape === 'parallelogram') return 'parallelogram';
  if (shape === 'ellipse' || style.ellipse === '1') return 'ellipse';
  if (shape && shape !== 'rect' && shape !== 'rectangle') return 'unknown';
  if (style.rounded === '1') return 'rounded-rectangle';
  return 'rectangle';
}

function looksLikeContainer(cell: Cell): boolean {
  if (
    cell.style.container === '1' ||
    cell.style.swimlane === '1' ||
    cell.style.shape === 'swimlane' ||
    cell.style.group === '1'
  )
    return true;
  const unfilled = (cell.style.fillColor ?? 'none') === 'none';
  const geometry = cell.geometry!;
  return (
    cell.style.dashed === '1' &&
    unfilled &&
    geometry.width >= 200 &&
    geometry.height >= 150
  );
}

function holds(outer: Geometry, inner: Geometry): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height &&
    area(inner) < area(outer)
  );
}

function area(geometry: Geometry): number {
  return geometry.width * geometry.height;
}

function cleanLabel(raw: string, html: boolean): string {
  if (!html) return tidyLines(raw);
  let text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|h[1-6]|li)>/gi, '\n');
  text = stripTags(divOpenersToNewlines(text));
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ');
  return tidyLines(text);
}

/*
 * Linear scans in place of `/<div[^>]*>/gi` and `/<[^>]*>/g`, which took quadratic time on a label with many openers
 * and no `>` (a label can be most of the upload). They give what the regexes gave.
 */

/** `text.replace(/<div[^>]*>/gi, '\n')`. */
function divOpenersToNewlines(text: string): string {
  const opener = /<div/gi;
  let out = '';
  let from = 0;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const end = text.indexOf('>', match.index + match[0].length);
    // With no '>' after this opener, none comes after a later one.
    if (end === -1) break;
    out += `${text.slice(from, match.index)}\n`;
    from = end + 1;
    opener.lastIndex = from;
  }
  return out + text.slice(from);
}

/**
 * `text.replace(/<[^>]*>/g, '')`, which calm-import repeated until nothing changed. One pass is enough: a '<' left
 * after it has no '>' anywhere after it, so a second pass changes nothing.
 */
function stripTags(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<', from);
    if (start === -1) break;
    const end = text.indexOf('>', start + 1);
    // A '<' with no '>' after it keeps the rest as text.
    if (end === -1) break;
    out += text.slice(from, start);
    from = end + 1;
  }
  return out + text.slice(from);
}

function tidyLines(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}
