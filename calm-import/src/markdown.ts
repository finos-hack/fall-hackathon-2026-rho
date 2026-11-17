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

/** The first statement of a Mermaid text: its first line that is neither blank nor a `%%` comment. */
export function firstStatement(text: string): string {
  for (const raw of text.replace(/^﻿/, '').split('\n')) {
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

/** Which import format a text looks like, for a hint when the chosen format is wrong. */
export function looksLike(
  text: string,
): 'drawio' | 'c4' | 'mermaid' | 'plantuml' | undefined {
  if (['<mxfile', '<mxGraphModel', '<svg'].some(m => text.includes(m))) {
    return 'drawio';
  }
  if (firstStatement(text).startsWith('@startuml')) return 'plantuml';
  const blocks = mermaidBlocks(text);
  if (blocks.length === 0) return mermaidKind(text);
  for (const block of blocks) {
    const kind = mermaidKind(block.body);
    if (kind) return kind;
  }
  return undefined;
}
