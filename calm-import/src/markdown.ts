import { stripFrontMatter } from './c4/parse';

export type ImportKind = 'drawio' | 'c4' | 'mermaid';

/**
 * The import formats as the import form names them. calm-backstage keeps the same labels (calm-common
 * importFormats.ts) for the form and the action's hint; keep the two in step.
 */
export const FORMAT_LABELS: Record<ImportKind, string> = {
  drawio: 'draw.io',
  c4: 'C4 (Mermaid or PlantUML)',
  mermaid: 'Mermaid flowchart',
};

/** The end of a reader's error when the text is in another format: `; this looks like draw.io: choose "draw.io" as the format`. */
export function formatHint(kind: ImportKind | undefined): string {
  if (!kind) return '';
  const label = FORMAT_LABELS[kind];
  return `; this looks like ${label}: choose "${label}" as the format`;
}

/** A fenced mermaid block: its body, and the 1-based line of the body's first line. */
export interface MermaidBlock {
  body: string;
  line: number;
}

/** The bodies of every ```mermaid fenced block, in order; empty when the text has none. */
export function mermaidBlocks(text: string): MermaidBlock[] {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const blocks: MermaidBlock[] = [];
  let open: { info: string; start: number; body: string[] } | undefined;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!open) {
      if (line.startsWith('```')) {
        open = { info: line.slice(3).trim(), start: i + 2, body: [] };
      }
    } else if (line.startsWith('```')) {
      if (open.info === 'mermaid') {
        blocks.push({ body: open.body.join('\n'), line: open.start });
      }
      open = undefined;
    } else {
      open.body.push(raw);
    }
  });
  return blocks;
}

const C4_HEADERS = [
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Deployment',
  'C4Dynamic',
];

/**
 * The first statement of a Mermaid text: its first line that is neither blank nor a `%%` comment, after any `---`
 * front matter.
 */
export function firstStatement(text: string): string {
  for (const raw of stripFrontMatter(text.replace(/^﻿/, '')).split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('%%')) return line;
  }
  return '';
}

/** The diagram kind a Mermaid header names: `c4`, `mermaid` (a flowchart) or undefined. */
function mermaidKind(text: string): 'c4' | 'mermaid' | undefined {
  const word = firstStatement(text).split(/\s/)[0];
  if (C4_HEADERS.includes(word)) return 'c4';
  if (word === 'flowchart' || word === 'graph') return 'mermaid';
  return undefined;
}

export type FoundKind = ImportKind | 'plantuml';

const DRAWIO_MARKERS = ['<mxfile', '<mxGraphModel', '<svg'];

/**
 * Every import format found in a text, in the order found: the kind of each mermaid block of a Markdown file (or of
 * the whole text when it has none), then `plantuml` for a `@startuml` line. draw.io markers count only when the text
 * holds none of those, so an inline `<svg` in a Markdown file with a diagram is not a draw.io file.
 */
export function kindsIn(text: string): FoundKind[] {
  const kinds: FoundKind[] = [];
  const add = (kind: FoundKind | undefined) => {
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  };
  const blocks = mermaidBlocks(text);
  if (blocks.length === 0) add(mermaidKind(text));
  for (const block of blocks) add(mermaidKind(block.body));
  if (text.split('\n').some(line => line.trim().startsWith('@startuml'))) {
    add('plantuml');
  }
  if (kinds.length === 0 && DRAWIO_MARKERS.some(m => text.includes(m))) {
    add('drawio');
  }
  return kinds;
}

/** Which import format a text looks like, for a hint when the chosen format is wrong: the first one found. */
export function looksLike(text: string): FoundKind | undefined {
  return kindsIn(text)[0];
}
