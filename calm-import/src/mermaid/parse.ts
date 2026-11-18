import type { Arrow, Box, Diagram, ShapeHint } from '../diagram';
import { formatHint, looksLike } from '../markdown';

/*
 * A small reader for Mermaid flowcharts. Every scan moves forward over the text once (no regular expression runs over
 * unbounded user text with nested quantifiers), so crafted input costs time in proportion to its size.
 */

/** What the converter needs besides the diagram: the classes of each node and the italic type line of its label. */
export interface FlowchartExtras {
  /** `:::name` and `class a,b name`, by node id. */
  classes: Map<string, string[]>;
  /** The last label line when it is written in italics, as this repo's entity card writes the node type. */
  typeLines: Map<string, string>;
  /** The ids of the dotted arrows (`-.->`, `-.-`, `-.-o`, `-. text .->`). */
  dotted: Set<string>;
  /** The ids of the arrows whose head at the target is a circle (`--o`, `-.-o`). */
  circleHead: Set<string>;
}

const extras = new WeakMap<Diagram, FlowchartExtras>();

export function flowchartExtras(diagram: Diagram): FlowchartExtras {
  return (
    extras.get(diagram) ?? {
      classes: new Map(),
      typeLines: new Map(),
      dotted: new Set(),
      circleHead: new Set(),
    }
  );
}

export const MAX_DEPTH = 50;
export const MAX_NODES = 5_000;
export const MAX_EDGES = 10_000;

const SHAPES: Array<[string, Array<[string, ShapeHint]>]> = [
  ['(((', [[')))', 'ellipse']]],
  ['((', [['))', 'ellipse']]],
  ['([', [['])', 'rounded-rectangle']]],
  ['(', [[')', 'rounded-rectangle']]],
  ['[(', [[')]', 'cylinder']]],
  ['[[', [[']]', 'rectangle']]],
  [
    '[/',
    [
      ['/]', 'parallelogram'],
      ['\\]', 'unknown'],
    ],
  ],
  [
    '[\\',
    [
      ['\\]', 'parallelogram'],
      ['/]', 'unknown'],
    ],
  ],
  ['[', [[']', 'rectangle']]],
  ['{{', [['}}', 'hexagon']]],
  ['{', [['}', 'diamond']]],
  ['>', [[']', 'rectangle']]],
];

const NAMED_SHAPES: Record<string, ShapeHint> = {
  cyl: 'cylinder',
  cylinder: 'cylinder',
  database: 'cylinder',
  db: 'cylinder',
  'lin-cyl': 'cylinder',
  'h-cyl': 'queue',
  das: 'queue',
  'horizontal-cylinder': 'queue',
  doc: 'document',
  document: 'document',
  'lin-doc': 'document',
  cloud: 'cloud',
  circle: 'ellipse',
  circ: 'ellipse',
  'dbl-circ': 'ellipse',
  diamond: 'diamond',
  diam: 'diamond',
  decision: 'diamond',
  hex: 'hexagon',
  hexagon: 'hexagon',
  prepare: 'hexagon',
  rounded: 'rounded-rectangle',
  event: 'rounded-rectangle',
  stadium: 'rounded-rectangle',
  pill: 'rounded-rectangle',
  terminal: 'rounded-rectangle',
  rect: 'rectangle',
  rectangle: 'rectangle',
  proc: 'rectangle',
  process: 'rectangle',
  'lean-r': 'parallelogram',
  'lean-l': 'parallelogram',
  parallelogram: 'parallelogram',
};

const IGNORED = new Set([
  'classDef',
  'style',
  'linkStyle',
  'click',
  'direction',
  'accTitle',
  'accDescr',
]);

const EMOJI_PREFIXES = ['👤', '🗄️', '🗄', '💻', '⚙️', '⚙', '🏢', '📨'];

interface Statement {
  text: string;
  line: number;
}

interface Operator {
  startHead: boolean;
  endHead: boolean;
  invisible: boolean;
  label?: string;
  dotted?: boolean;
  /** The head at the end is `o`. */
  circle?: boolean;
}

/** The flowchart in `text` as a Diagram with zero geometry; `firstLine` is the line number of its first line. */
export function parseFlowchart(text: string, firstLine = 1): Diagram {
  const statements = statementsOf(text, firstLine);
  const header = statements.shift();
  if (!header) {
    throw new Error(
      'Only Mermaid flowcharts are supported here (flowchart or graph); got nothing',
    );
  }
  const word = firstWord(header.text);
  if (word !== 'flowchart' && word !== 'graph' && word !== 'flowchart-elk') {
    const hint = otherFormatHint(text);
    throw new Error(
      `Only Mermaid flowcharts are supported here (flowchart or graph); got ${word}${hint}`,
    );
  }

  const boxes = new Map<string, Box>();
  const arrows: Arrow[] = [];
  const classes = new Map<string, string[]>();
  const typeLines = new Map<string, string>();
  const dotted = new Set<string>();
  const circleHead = new Set<string>();
  const stack: Array<{ id: string; title: string; line: number }> = [];
  const open = new Set<string>();

  const fail = (message: string, line: number): never => {
    throw new Error(`${message} at line ${line}`);
  };
  const addClass = (id: string, name: string) => {
    const known = classes.get(id) ?? [];
    if (!known.includes(name)) classes.set(id, [...known, name]);
  };
  const tooDeep = (line: number) =>
    fail(`Nesting deeper than ${MAX_DEPTH} levels`, line);

  const boxFor = (id: string, line: number): Box => {
    let box = boxes.get(id);
    if (!box) {
      if (boxes.size >= MAX_NODES) {
        fail(`More than ${MAX_NODES} nodes`, line);
      }
      box = {
        id,
        label: id,
        shape: 'rectangle',
        geometry: { x: 0, y: 0, width: 0, height: 0 },
        isContainer: false,
      };
      boxes.set(id, box);
    }
    return box;
  };

  /** A node named inside a subgraph belongs to it, unless that would make a container hold itself. */
  const place = (box: Box, line: number) => {
    const parent = stack[stack.length - 1]?.id;
    if (!parent || box.containerId || open.has(box.id)) return;
    let depth = 0;
    for (let up = boxes.get(parent); up; up = boxes.get(up.containerId ?? '')) {
      if (up.id === box.id) return;
      if (++depth > MAX_DEPTH) tooDeep(line);
    }
    box.containerId = parent;
  };

  const define = (box: Box, label: string, shape: ShapeHint) => {
    const cleaned = cleanLabel(label);
    box.label = cleaned.label;
    box.shape = shape;
    if (cleaned.typeLine) typeLines.set(box.id, cleaned.typeLine);
    else typeLines.delete(box.id);
  };

  const chain = (st: Statement) => {
    const s = st.text;
    const { line } = st;
    let i = 0;
    const skipSpace = () => {
      while (s[i] === ' ' || s[i] === '\t') i++;
    };
    const here = () => `"${s.slice(i, i + 12)}"`;

    const readNode = (): string => {
      const start = i;
      while (i < s.length && !stopsId(s, i)) i++;
      const id = s.slice(start, i);
      if (!id) fail(`Cannot read ${here()}`, line);
      const box = boxFor(id, line);
      const opener = SHAPES.find(([o]) => s.startsWith(o, i));
      if (opener) {
        const [open_, closers] = opener;
        const [label, shape] = readBracketed(
          s,
          i + open_.length,
          open_,
          closers,
          line,
        );
        i = label.end;
        define(box, label.text, shape);
      } else if (s.startsWith('@{', i)) {
        const end = closingBrace(s, i + 2);
        if (end === -1) fail('Unclosed @{', line);
        const props = readProps(s.slice(i + 2, end));
        i = end + 1;
        define(
          box,
          props.label ?? box.label,
          NAMED_SHAPES[props.shape ?? ''] ?? 'unknown',
        );
      }
      while (s.startsWith(':::', i)) {
        const from = i + 3;
        i = from;
        while (i < s.length && /[\w-]/.test(s[i]!)) i++;
        if (i === from) fail(`Expected a class name after ":::"`, line);
        addClass(id, s.slice(from, i));
      }
      place(box, line);
      return id;
    };

    const readGroup = (): string[] => {
      const ids = [readNode()];
      for (;;) {
        skipSpace();
        if (s[i] !== '&') return ids;
        i++;
        skipSpace();
        ids.push(readNode());
      }
    };

    let sources = readGroup();
    for (;;) {
      skipSpace();
      if (i >= s.length) return;
      const operator = readOperator(s, i, line, end => {
        i = end;
      });
      if (!operator) fail(`Cannot read ${here()}`, line);
      let label = operator!.label;
      skipSpace();
      if (s[i] === '|') {
        const [piped, end] = readPipes(s, i, line);
        label = piped;
        i = end;
      }
      skipSpace();
      if (i >= s.length) fail('The arrow has no target', line);
      const targets = readGroup();
      if (!operator!.invisible) {
        const reversed = operator!.startHead && !operator!.endHead;
        const heads: Arrow['heads'] =
          operator!.startHead && operator!.endHead
            ? 'both'
            : operator!.startHead || operator!.endHead
            ? 'end'
            : 'none';
        for (const from of sources) {
          for (const to of targets) {
            if (arrows.length >= MAX_EDGES) {
              fail(`More than ${MAX_EDGES} edges`, line);
            }
            const id = `e${arrows.length}`;
            if (operator!.dotted) dotted.add(id);
            if (operator!.circle && !reversed) circleHead.add(id);
            arrows.push({
              id,
              label: cleanLabel(label ?? '').label,
              sourceId: reversed ? to : from,
              targetId: reversed ? from : to,
              heads,
            });
          }
        }
      }
      sources = targets;
    }
  };

  const subgraph = (st: Statement) => {
    const rest = st.text.slice('subgraph'.length).trim();
    if (!rest) fail('A subgraph needs a title', st.line);
    const bracket = rest.indexOf('[');
    let id = rest;
    let title = rest;
    if (bracket !== -1) {
      const close = rest.lastIndexOf(']');
      if (close < bracket) fail('Unclosed [', st.line);
      id = rest.slice(0, bracket).trim();
      title = rest.slice(bracket + 1, close);
      if (!id) id = unquote(title);
    }
    id = unquote(id);
    if (open.has(id)) fail(`Subgraph "${id}" is inside itself`, st.line);
    if (stack.length >= MAX_DEPTH) tooDeep(st.line);
    const box = boxFor(id, st.line);
    box.isContainer = true;
    box.label = cleanLabel(unquote(title)).label || id;
    box.shape = 'rectangle';
    place(box, st.line);
    stack.push({ id, title: box.label, line: st.line });
    open.add(id);
  };

  for (const st of statements) {
    const keyword = firstWord(st.text);
    if (keyword === 'subgraph') {
      subgraph(st);
    } else if (keyword === 'end') {
      const closed = stack.pop();
      if (!closed) fail('"end" with no subgraph', st.line);
      open.delete(closed!.id);
    } else if (keyword === 'class') {
      const [ids, name] = st.text.slice(5).trim().split(/\s+/);
      for (const id of (ids ?? '').split(',')) {
        if (id && name) addClass(id, name);
      }
    } else if (!IGNORED.has(keyword)) {
      chain(st);
    }
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw new Error(
      `The subgraph "${unclosed.title}" at line ${unclosed.line} has no end`,
    );
  }

  const diagram: Diagram = {
    boxes: [...boxes.values()],
    arrows,
    annotations: [],
    pageNames: [],
  };
  extras.set(diagram, { classes, typeLines, dotted, circleHead });
  return diagram;
}

/** The statements of a flowchart: lines (comments and front matter dropped) split on `;` outside quotes and brackets. */
function statementsOf(text: string, firstLine: number): Statement[] {
  const lines = text.replace(/^﻿/, '').split('\n');
  const out: Statement[] = [];
  let index = 0;
  if (lines[0]?.trim() === '---') {
    index = lines.findIndex((l, n) => n > 0 && l.trim() === '---') + 1;
    if (index === 0) {
      throw new Error(`The front matter at line ${firstLine} is not closed`);
    }
  }
  for (; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith('%%')) continue;
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i <= line.length; i++) {
      const c = line[i];
      if (c === undefined || (c === ';' && depth === 0 && !quoted)) {
        const piece = line.slice(start, i).trim();
        if (piece) out.push({ text: piece, line: firstLine + index });
        start = i + 1;
      } else if (c === '"') {
        quoted = !quoted;
      } else if (!quoted) {
        if (c === '[' || c === '(' || c === '{') depth++;
        else if (c === ']' || c === ')' || c === '}') {
          depth = Math.max(0, depth - 1);
        }
      }
    }
  }
  return out;
}

/** Whether the node id that is being read ends at `i`. */
function stopsId(s: string, i: number): boolean {
  const c = s[i]!;
  const next = s[i + 1] ?? '';
  switch (c) {
    case ' ':
    case '\t':
    case '[':
    case '(':
    case '{':
    case '>':
    case '&':
    case '|':
    case '"':
    case ']':
    case ')':
    case '}':
      return true;
    case ':':
      return s.startsWith(':::', i);
    case '@':
      return next === '{';
    case '-':
      return next === '-' || next === '.' || next === '>';
    case '=':
      return next === '=';
    case '~':
      return next === '~';
    case '<':
      return next === '-' || next === '=';
    default:
      return false;
  }
}

/** The text of a shape that opened with `opener`, from `from`; `end` is just after its closer. */
function readBracketed(
  s: string,
  from: number,
  opener: string,
  closers: Array<[string, ShapeHint]>,
  line: number,
): [{ text: string; end: number }, ShapeHint] {
  let j = from;
  while (s[j] === ' ') j++;
  if (s[j] === '"') {
    const quote = s.indexOf('"', j + 1);
    if (quote === -1) throw new Error(`Unclosed quote at line ${line}`);
    let k = quote + 1;
    while (s[k] === ' ') k++;
    const closer = closers.find(([c]) => s.startsWith(c, k));
    if (!closer) {
      throw new Error(`Expected ${closers[0]![0]} at line ${line}`);
    }
    return [
      { text: s.slice(j + 1, quote), end: k + closer[0].length },
      closer[1],
    ];
  }
  let best: { at: number; closer: [string, ShapeHint] } | undefined;
  for (const closer of closers) {
    const at = s.indexOf(closer[0], from);
    if (at !== -1 && (!best || at < best.at)) best = { at, closer };
  }
  if (!best) throw new Error(`Unclosed ${opener} at line ${line}`);
  return [
    { text: s.slice(from, best.at), end: best.at + best.closer[0].length },
    best.closer[1],
  ];
}

/** The index of the `}` that closes a `@{` body starting at `from`, skipping quoted text; -1 when there is none. */
function closingBrace(s: string, from: number): number {
  let quoted = false;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (s[i] === '}' && !quoted) return i;
  }
  return -1;
}

/** `key: value, key: "value"` of a `@{ }` body. */
function readProps(body: string): Record<string, string> {
  const props: Record<string, string> = {};
  let quoted = false;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (body[i] === '"') quoted = !quoted;
    if (i === body.length || (body[i] === ',' && !quoted)) {
      const part = body.slice(start, i);
      const colon = part.indexOf(':');
      if (colon > 0) {
        props[part.slice(0, colon).trim()] = unquote(part.slice(colon + 1));
      }
      start = i + 1;
    }
  }
  return props;
}

/** `|text|` or `|"text"|` at `from`: the text and the index after the closing bar. */
function readPipes(s: string, from: number, line: number): [string, number] {
  let j = from + 1;
  while (s[j] === ' ') j++;
  if (s[j] === '"') {
    const quote = s.indexOf('"', j + 1);
    const bar = quote === -1 ? -1 : s.indexOf('|', quote + 1);
    if (bar === -1) throw new Error(`Unclosed | at line ${line}`);
    return [s.slice(j + 1, quote), bar + 1];
  }
  const bar = s.indexOf('|', from + 1);
  if (bar === -1) throw new Error(`Unclosed | at line ${line}`);
  return [s.slice(from + 1, bar), bar + 1];
}

/** Whether the character after `--o` / `--x` ends the arrow, so that the `o` is a head and not part of an id. */
const endsHead = (s: string, at: number) => {
  const c = s[at];
  return c === undefined || c === ' ' || c === '\t' || c === '|';
};

/**
 * The edge operator at `from`, or undefined. `done` receives the index after it. Forms: `-->`, `---`, `-.->`, `-.-`,
 * `==>`, `===`, `<-->`, `--o`, `--x`, `o--o`, `~~~`, longer runs of the same character, and `-- text -->`,
 * `-. text .->`, `== text ==>`.
 */
function readOperator(
  s: string,
  from: number,
  line: number,
  done: (end: number) => void,
): Operator | undefined {
  let j = from;
  let startHead = false;
  const first = s[j];
  const lead = s[j + 1] ?? ' ';
  if (
    first === '<' ||
    ((first === 'o' || first === 'x') && '-='.includes(lead))
  ) {
    startHead = true;
    j++;
  }
  const family = s[j];
  const run = (char: string) => {
    let k = j;
    while (s[k] === char) k++;
    return k;
  };
  const result = (
    end: number,
    endHead: boolean,
    label?: string,
    dotted = false,
  ): Operator => {
    done(end);
    if (startHead && !endHead && first === '<') {
      throw new Error(
        `An arrow with only a "<" head is not valid at line ${line}`,
      );
    }
    const circle = endHead && s[end - 1] === 'o';
    return { startHead, endHead, invisible: false, label, dotted, circle };
  };
  const terminal = (k: number): [number, boolean] => {
    if (s[k] === '>') return [k + 1, true];
    if ((s[k] === 'o' || s[k] === 'x') && endsHead(s, k + 1)) {
      return [k + 1, true];
    }
    return [k, false];
  };

  if (family === '~') {
    const end = run('~');
    if (end - j < 3) return undefined;
    done(end);
    return { startHead: false, endHead: false, invisible: true };
  }
  if (family === '-' || family === '=') {
    const k = run(family);
    const n = k - j;
    const isSpace = s[k] === ' ' || s[k] === '\t';
    if (family === '-' && n === 1 && s[k] === '.') {
      // Dotted: -.-> -.- -..-> or -. text .->
      let m = k + 1;
      if (s[m] === ' ' || s[m] === '\t') {
        const at = s.indexOf('.-', m);
        if (at === -1) return undefined;
        const [end, head] = terminal(at + 2);
        return result(end, head, s.slice(m, at), true);
      }
      while (s[m] === '.') m++;
      if (s[m] !== '-') return undefined;
      const [end, head] = terminal(m + 1);
      return result(end, head, undefined, true);
    }
    if (n < 2) return undefined;
    if (s[k] === '>') return result(k + 1, true);
    if (
      family === '-' &&
      (s[k] === 'o' || s[k] === 'x') &&
      endsHead(s, k + 1)
    ) {
      return result(k + 1, true);
    }
    if (n >= 3) return result(k, false);
    if (isSpace) {
      // -- text --> or == text ==>
      const at = s.indexOf(family + family, k);
      if (at === -1) return undefined;
      let m = at;
      while (s[m] === family) m++;
      const [end, head] = terminal(m);
      if (!head && m - at < 3) return undefined;
      return result(end, head, s.slice(k, at));
    }
  }
  return undefined;
}

/** The end of an error for a text in another import format than a Mermaid flowchart; empty when it is not. */
export function otherFormatHint(text: string): string {
  const found = looksLike(text);
  if (found === 'plantuml') return formatHint('c4');
  return found === 'mermaid' ? '' : formatHint(found);
}

function firstWord(text: string): string {
  let end = 0;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return text.slice(0, end);
}

function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"')
    ? t.slice(1, -1)
    : t;
}

/** What a node type looks like: one word, optionally with a namespace (`acme:worker`). */
const TYPE_WORD = /^[A-Za-z][\w-]*(?::[\w.-]+)?$/;

const ENTITY = /#(\d{1,7}|[a-z]{2,6});/g;
const NAMED: Record<string, string> = {
  quot: '"',
  lt: '<',
  gt: '>',
  amp: '&',
  nbsp: ' ',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, code: string) => {
    if (/^\d/.test(code)) {
      const n = Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code] ?? whole;
  });
}

/** `text.replace(/<[^>]*>/g, '')` as one forward scan; a `<` with no `>` after it stays. */
function stripTags(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<', from);
    if (start === -1) break;
    const end = text.indexOf('>', start + 1);
    if (end === -1) break;
    out += text.slice(from, start);
    from = end + 1;
  }
  return out + text.slice(from);
}

/**
 * A label as plain lines: `<br/>` becomes a new line, tags go, entity codes are decoded and the emoji prefix of the
 * block-architecture widget is dropped. A last line that is only `<i>…</i>` is the type line of this repo's entity card.
 */
export function cleanLabel(raw: string): { label: string; typeLine?: string } {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
    text = text.slice(1, -1);
  }
  const lines = text
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map(l => l.trim());
  let typeLine: string | undefined;
  const last = lines[lines.length - 1] ?? '';
  if (
    lines.length > 1 &&
    last.toLowerCase().startsWith('<i>') &&
    last.toLowerCase().endsWith('</i>')
  ) {
    const word = decodeEntities(stripTags(last)).trim();
    if (word.length <= 100 && TYPE_WORD.test(word)) {
      typeLine = word;
      lines.pop();
    }
  }
  const cleaned = lines
    .map(l =>
      decodeEntities(stripTags(l))
        .replace(/\u00a0/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  if (cleaned.length > 0) {
    const first = cleaned[0]!;
    const emoji = EMOJI_PREFIXES.find(e => first.startsWith(`${e} `));
    if (emoji) cleaned[0] = first.slice(emoji.length).trim();
  }
  return {
    label: cleaned.filter(Boolean).join('\n'),
    ...(typeLine ? { typeLine } : {}),
  };
}
