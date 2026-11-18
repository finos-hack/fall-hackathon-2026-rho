// A line-oriented reader for Mermaid C4 and C4-PlantUML. Every scan is linear in the text: statements are split on
// newlines, arguments are split by one quote-aware pass, and blocks are tracked with a stack. No regular expression
// runs over the text of a line.

export type C4Level = 'context' | 'container' | 'component' | 'deployment';

export interface C4Element {
  /** The macro as written, e.g. `ContainerDb_Ext`. */
  macro: string;
  kind: 'person' | 'system' | 'container' | 'component';
  db: boolean;
  queue: boolean;
  external: boolean;
  alias: string;
  name: string;
  /** The technology argument of a container or component; empty for a person or a system. */
  technology: string;
  description: string;
  /** Index into `boundaries` of the block this element is written in. */
  parent?: number;
  line: number;
}

export interface C4Boundary {
  macro: string;
  kind: 'enterprise' | 'system' | 'container' | 'generic' | 'deployment';
  alias: string;
  name: string;
  /** The type argument of a deployment node or generic boundary; empty otherwise. */
  technology: string;
  description: string;
  parent?: number;
  line: number;
}

export interface C4Rel {
  macro: string;
  from: string;
  to: string;
  label: string;
  technology: string;
  description: string;
  /** `Rel_Back`: the arrow points from `to` to `from`. */
  back: boolean;
  /** `BiRel`: the relationship goes both ways. */
  both: boolean;
  line: number;
}

export interface C4Skipped {
  line: number;
  text: string;
}

export interface C4Model {
  level: C4Level;
  elements: C4Element[];
  boundaries: C4Boundary[];
  rels: C4Rel[];
  skipped: C4Skipped[];
}

const MAX_DEPTH = 50;
const MAX_SKIPPED_TEXT = 100;

const HEADERS: Record<string, C4Level | 'dynamic'> = {
  C4Context: 'context',
  C4Container: 'container',
  C4Component: 'component',
  C4Deployment: 'deployment',
  C4Dynamic: 'dynamic',
};
const INCLUDE_LEVELS: Array<[string, C4Level | 'dynamic']> = [
  ['C4_Context', 'context'],
  ['C4_Container', 'container'],
  ['C4_Component', 'component'],
  ['C4_Deployment', 'deployment'],
  ['C4_Dynamic', 'dynamic'],
];
const DYNAMIC_MESSAGE =
  'C4Dynamic diagrams are not supported: they describe a flow, not structure';

const IGNORED = new Set([
  'title',
  'SHOW_LEGEND',
  'SHOW_FLOATING_LEGEND',
  'skinparam',
  'hide',
  'scale',
  'left',
  'top',
  'UpdateLayoutConfig',
]);
const IGNORED_PREFIXES = ['LAYOUT_', 'Lay_', 'Update', 'Add'];
// `!include`, `!includeurl`, `!include_many`… are ignored and never fetched; `!theme` and `!pragma` only style.
const HARMLESS_DIRECTIVES = ['include', 'theme', 'pragma'];

const BOUNDARIES: Record<string, C4Boundary['kind']> = {
  Enterprise_Boundary: 'enterprise',
  System_Boundary: 'system',
  Container_Boundary: 'container',
  Boundary: 'generic',
  Deployment_Node: 'deployment',
  Node: 'deployment',
  Node_L: 'deployment',
  Node_R: 'deployment',
};
const DIRECTIONS = [
  '',
  '_U',
  '_D',
  '_L',
  '_R',
  '_Up',
  '_Down',
  '_Left',
  '_Right',
  '_Neighbor',
];

interface Arg {
  name?: string;
  value: string;
}

/**
 * Reads a Mermaid C4 or C4-PlantUML text. `firstLine` is the line number of the text's first line in its file.
 * Throws an Error with a user-facing message on a C4Dynamic diagram, the PlantUML preprocessor, unbalanced braces
 * or nesting deeper than 50 levels; anything else it does not understand is listed in `skipped`.
 */
export function parseC4(text: string, firstLine = 1): C4Model {
  const lines = text.replace(/^﻿/, '').split('\n');
  let start = 0;
  let end = lines.length;
  const startUml = lines.findIndex(l => l.trim().startsWith('@startuml'));
  if (startUml >= 0) {
    start = startUml + 1;
    const endUml = lines.findIndex(
      (l, i) => i > startUml && l.trim().startsWith('@enduml'),
    );
    if (endUml >= 0) end = endUml;
  } else {
    start = afterFrontMatter(lines);
  }

  const model: C4Model = {
    level: 'context',
    elements: [],
    boundaries: [],
    rels: [],
    skipped: [],
  };
  let declared: C4Level | undefined;
  let included: C4Level | undefined;
  // One entry per open `{`: the boundary the block belongs to (undefined for the top level) and where it opened.
  const stack: Array<{ boundary: number | undefined; line: number }> = [];
  const parent = () => stack[stack.length - 1]?.boundary;
  let inComment = false;

  /** Reads one statement of a line; returns what follows it on the same line that is still to be read. */
  const statement = (line: string, lineNo: number): string => {
    while (line.startsWith('}')) {
      if (stack.length === 0) {
        throw new Error(`Unbalanced "}" at line ${lineNo}`);
      }
      stack.pop();
      line = line.slice(1).trim();
    }
    if (!line || line.startsWith('%%')) return '';

    if (line.startsWith('!')) {
      const name = line.slice(1, identEnd(line, 1));
      if (HARMLESS_DIRECTIVES.some(d => name.startsWith(d))) {
        if (name.startsWith('include')) {
          const level = INCLUDE_LEVELS.find(([word]) => line.includes(word));
          if (level) {
            if (level[1] === 'dynamic') throw new Error(DYNAMIC_MESSAGE);
            included ??= level[1];
          }
        }
        return '';
      }
      throw new Error(
        `The PlantUML preprocessor is not supported (line ${lineNo})`,
      );
    }

    const nameEnd = identEnd(line, 0);
    const name = line.slice(0, nameEnd);
    const header = HEADERS[name];
    if (header && nameEnd === line.length) {
      if (header === 'dynamic') throw new Error(DYNAMIC_MESSAGE);
      declared ??= header;
      return '';
    }
    let open = nameEnd;
    while (line[open] === ' ' || line[open] === '\t') open++;
    if (!name || line[open] !== '(') {
      if (name && isIgnored(name)) return '';
      skip(model, lineNo, line);
      return '';
    }
    if (name === 'RelIndex') throw new Error(DYNAMIC_MESSAGE);
    if (isIgnored(name)) {
      // An ignored macro may still open a block, so its braces stay balanced.
      const parsed = readArgs(line, open + 1);
      const after = parsed ? line.slice(parsed.end).trim() : '';
      if (after.startsWith('{')) {
        pushBlock(stack, parent(), lineNo);
        return after.slice(1);
      }
      return after.startsWith('}') ? after : '';
    }

    const parsed = readArgs(line, open + 1);
    if (!parsed) {
      skip(model, lineNo, line);
      return '';
    }
    const after = line.slice(parsed.end).trim();
    const opens = after.startsWith('{');
    // What follows on the same line: the statements inside a block opened here, or the braces that close blocks.
    const rest = opens ? after.slice(1) : after.startsWith('}') ? after : '';
    const fields = new Fields(parsed.args);
    const element = elementKind(name);
    const boundary = BOUNDARIES[name];
    const rel = relKind(name);
    if (element) {
      const alias = fields.get(0, '$alias');
      if (!alias) skip(model, lineNo, line);
      else {
        const deep = element.kind === 'container' || element.kind === 'component';
        model.elements.push({
          macro: name,
          ...element,
          alias,
          name: fields.get(1, '$label'),
          technology: deep ? fields.get(2, '$techn') : '',
          description: fields.get(deep ? 3 : 2, '$descr'),
          parent: parent(),
          line: lineNo,
        });
      }
      if (opens) pushBlock(stack, parent(), lineNo);
    } else if (boundary) {
      const alias = fields.get(0, '$alias');
      if (!alias) {
        skip(model, lineNo, line);
        if (opens) pushBlock(stack, parent(), lineNo);
      } else {
        const typed = boundary === 'deployment' || boundary === 'generic';
        model.boundaries.push({
          macro: name,
          kind: boundary,
          alias,
          name: fields.get(1, '$label'),
          technology: typed ? fields.get(2, '$type') : '',
          description: boundary === 'deployment' ? fields.get(3, '$descr') : '',
          parent: parent(),
          line: lineNo,
        });
        if (opens) pushBlock(stack, model.boundaries.length - 1, lineNo);
      }
    } else if (rel) {
      const from = fields.get(0, '$from');
      const to = fields.get(1, '$to');
      if (!from || !to) skip(model, lineNo, line);
      else {
        model.rels.push({
          macro: name,
          from,
          to,
          label: fields.get(2, '$label'),
          technology: fields.get(3, '$techn'),
          description: fields.get(4, '$descr'),
          back: rel === 'back',
          both: rel === 'both',
          line: lineNo,
        });
      }
      if (opens) pushBlock(stack, parent(), lineNo);
    } else {
      skip(model, lineNo, line);
      if (opens) pushBlock(stack, parent(), lineNo);
    }
    if (stack.length > MAX_DEPTH) {
      throw new Error(`Nesting deeper than ${MAX_DEPTH} levels at line ${lineNo}`);
    }
    return rest;
  };

  for (let i = start; i < end; i++) {
    const lineNo = firstLine + i;
    let line = lines[i]!;
    if (inComment) {
      const close = line.indexOf("'/");
      if (close < 0) continue;
      inComment = false;
      line = line.slice(close + 2);
    }
    line = line.trim();
    while (line.startsWith("/'")) {
      const close = line.indexOf("'/", 2);
      if (close < 0) {
        inComment = true;
        line = '';
      } else line = line.slice(close + 2).trim();
    }
    if (!line || line.startsWith('%%') || line.startsWith("'")) continue;
    while (line) line = statement(line, lineNo).trim();
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) throw new Error(`Unbalanced "{" opened at line ${unclosed.line}`);
  model.level = declared ?? included ?? inferLevel(model);
  return model;
}

function pushBlock(
  stack: Array<{ boundary: number | undefined; line: number }>,
  boundary: number | undefined,
  line: number,
) {
  stack.push({ boundary, line });
}

function skip(model: C4Model, line: number, text: string) {
  model.skipped.push({
    line,
    text:
      text.length > MAX_SKIPPED_TEXT
        ? `${text.slice(0, MAX_SKIPPED_TEXT)}…`
        : text,
  });
}

/** The text without a `---` front matter block at its start, which Mermaid allows before the header. */
export function stripFrontMatter(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const start = afterFrontMatter(lines);
  return start === 0 ? text : lines.slice(start).join('\n');
}

/** Where the diagram starts when the file opens with `---` front matter. */
function afterFrontMatter(lines: string[]): number {
  const first = lines.findIndex(l => l.trim() !== '');
  if (first < 0 || lines[first]!.trim() !== '---') return 0;
  const close = lines.findIndex((l, i) => i > first && l.trim() === '---');
  return close < 0 ? 0 : close + 1;
}

function isIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function identEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isIdentChar(text.charCodeAt(i))) i++;
  return i;
}

function isIgnored(name: string): boolean {
  return IGNORED.has(name) || IGNORED_PREFIXES.some(p => name.startsWith(p));
}

function elementKind(
  macro: string,
): Pick<C4Element, 'kind' | 'db' | 'queue' | 'external'> | undefined {
  let base = macro;
  const external = base.endsWith('_Ext');
  if (external) base = base.slice(0, -4);
  if (base === 'Person') {
    return { kind: 'person', db: false, queue: false, external };
  }
  for (const kind of ['System', 'Container', 'Component'] as const) {
    if (!base.startsWith(kind)) continue;
    const rest = base.slice(kind.length);
    if (rest === '' || rest === 'Db' || rest === 'Queue') {
      return {
        kind: kind.toLowerCase() as C4Element['kind'],
        db: rest === 'Db',
        queue: rest === 'Queue',
        external,
      };
    }
  }
  return undefined;
}

function relKind(macro: string): 'rel' | 'back' | 'both' | undefined {
  if (macro === 'Rel_Back') return 'back';
  if (macro.startsWith('Rel') && DIRECTIONS.includes(macro.slice(3))) {
    return 'rel';
  }
  if (macro.startsWith('BiRel') && DIRECTIONS.includes(macro.slice(5))) {
    return 'both';
  }
  return undefined;
}

/** The arguments of one macro: positional ones by index, named ones (`$techn="x"`) by name. */
class Fields {
  private readonly positional: string[] = [];
  private readonly named = new Map<string, string>();

  constructor(args: Arg[]) {
    for (const arg of args) {
      if (arg.name) this.named.set(arg.name, arg.value);
      else this.positional.push(arg.value);
    }
  }

  get(index: number, name: string): string {
    return this.named.get(name) ?? this.positional[index] ?? '';
  }
}

/**
 * Reads the arguments that follow a `(`: split on commas outside quotes and nested parentheses, quotes removed
 * (Mermaid and PlantUML have no escapes). Returns where the closing `)` ends, or undefined when there is none.
 */
function readArgs(
  text: string,
  from: number,
): { args: Arg[]; end: number } | undefined {
  const args: Arg[] = [];
  let value = '';
  let name: string | undefined;
  let atStart = true;
  let depth = 0;
  let i = from;
  const finish = () => {
    args.push({ name, value: value.trim() });
    value = '';
    name = undefined;
    atStart = true;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) return undefined;
      value += text.slice(i + 1, close);
      atStart = false;
      i = close + 1;
      continue;
    }
    if (atStart) {
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }
      if (ch === '$' && name === undefined) {
        const nameEnd = identEnd(text, i + 1);
        let eq = nameEnd;
        while (text[eq] === ' ' || text[eq] === '\t') eq++;
        if (nameEnd > i + 1 && text[eq] === '=') {
          name = text.slice(i, nameEnd);
          i = eq + 1;
          continue;
        }
      }
      atStart = false;
    }
    if (ch === ')' && depth === 0) {
      if (value !== '' || name !== undefined || args.length > 0) finish();
      return { args, end: i + 1 };
    }
    if (ch === ',' && depth === 0) finish();
    else {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      value += ch;
    }
    i++;
  }
  return undefined;
}

function inferLevel(model: C4Model): C4Level {
  if (model.boundaries.some(b => b.kind === 'deployment')) return 'deployment';
  if (model.elements.some(e => e.kind === 'component')) return 'component';
  if (model.elements.some(e => e.kind === 'container')) return 'container';
  return 'context';
}
