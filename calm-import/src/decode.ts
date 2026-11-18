// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

const inflateRawAsync = promisify(inflateRaw);

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
// The scaffolder accepts at most 2 MB of diagram; URI-encoding (as draw.io compresses a page) at most triples it.
const MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024;

export interface DecodedDrawio {
  graphModelXml: string;
  pageNames: string[];
}

export async function decodeDrawio(content: string): Promise<DecodedDrawio> {
  if (Buffer.byteLength(content, 'utf-8') > MAX_INPUT_BYTES) {
    throw new Error('The file is too large (more than 5 MB).');
  }
  const svgContent = svgContentAttribute(content);
  const decoded = await decodeXml(
    svgContent !== undefined ? svgXml(svgContent) : content,
  );
  if (!decoded) {
    throw new Error('No draw.io diagram found in the file.');
  }
  return decoded;
}

// Older exports URL-encode the whole attribute; newer ones only HTML-escape it, and %XX inside is literal text.
function svgXml(attribute: string): string {
  const unescaped = decodeEntities(attribute);
  return unescaped.trimStart().startsWith('<')
    ? unescaped
    : urlDecode(unescaped);
}

async function decodeXml(xml: string): Promise<DecodedDrawio | undefined> {
  const pages = diagramPages(xml);
  if (pages.length > 0) {
    const graphModelXml = await pageModel(pages[0]!.body);
    if (!graphModelXml) return undefined;
    const pageNames = pages.map((page, i) => {
      const name = /\bname="([^"]*)"/.exec(page.attributes)?.[1];
      return name ? decodeEntities(name) : `Page-${i + 1}`;
    });
    return { graphModelXml, pageNames };
  }
  const graphModelXml = findModel(xml);
  return graphModelXml ? { graphModelXml, pageNames: ['Page-1'] } : undefined;
}

async function pageModel(page: string): Promise<string | undefined> {
  return findModel(page) ?? findModel(await inflatePage(page.trim()));
}

async function inflatePage(base64: string): Promise<string> {
  let inflated: Buffer;
  try {
    inflated = await inflateRawAsync(Buffer.from(base64, 'base64'), {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        'The diagram is too large (more than 10 MB when decompressed).',
      );
    }
    return '';
  }
  return urlDecode(inflated.toString('utf-8'));
}

function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (reference, hex: string) =>
      codePoint(reference, parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (reference, dec: string) =>
      codePoint(reference, parseInt(dec, 10)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** String.fromCodePoint, with a message about the file instead of a RangeError for a reference out of range. */
function codePoint(reference: string, value: number): string {
  if (value > 0x10ffff) {
    throw new Error(
      `The file has an invalid character reference: ${reference}`,
    );
  }
  return String.fromCodePoint(value);
}

/*
 * Linear scans in place of calm-import's regexes, which took quadratic time on many openers with no closer (a tiny
 * compressed upload could block the event loop). Each one finds what its regex found.
 */

/** Index of the first `open` at or after `from` that is followed by a word boundary (regex `open\b`), or -1. */
function findOpener(text: string, open: string, from: number): number {
  let i = text.indexOf(open, from);
  while (i !== -1 && /\w/.test(text.charAt(i + open.length))) {
    i = text.indexOf(open, i + 1);
  }
  return i;
}

/** `/<svg\b[^>]*?\scontent="([^"]*)"/.exec(text)?.[1]`. */
function svgContentAttribute(text: string): string | undefined {
  const open = '<svg';
  const attribute = 'content="';
  let tagEnd = -1; // the first '>' after the current tag's name, or text.length
  let candidate = -1; // the first whitespace-prefixed `content="` after the current tag's name
  for (
    let i = findOpener(text, open, 0);
    i !== -1;
    i = findOpener(text, open, i + 1)
  ) {
    const body = i + open.length;
    if (tagEnd < body) {
      tagEnd = text.indexOf('>', body);
      if (tagEnd === -1) tagEnd = text.length;
    }
    if (candidate - 1 < body) {
      candidate = text.indexOf(attribute, body + 1);
      while (candidate !== -1 && !/\s/.test(text.charAt(candidate - 1))) {
        candidate = text.indexOf(attribute, candidate + 1);
      }
      // No later tag can have the attribute either.
      if (candidate === -1) return undefined;
    }
    if (candidate - 1 < tagEnd) {
      const start = candidate + attribute.length;
      const end = text.indexOf('"', start);
      // An unclosed value here means every later one is unclosed too.
      return end === -1 ? undefined : text.slice(start, end);
    }
  }
  return undefined;
}

/** The attributes and body of each `/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g` match. */
function diagramPages(
  xml: string,
): Array<{ attributes: string; body: string }> {
  const open = '<diagram';
  const close = '</diagram>';
  const pages: Array<{ attributes: string; body: string }> = [];
  let from = 0;
  for (;;) {
    const i = findOpener(xml, open, from);
    if (i === -1) break;
    const tagEnd = xml.indexOf('>', i + open.length);
    if (tagEnd === -1) break;
    const end = xml.indexOf(close, tagEnd + 1);
    // With no closer after this opener, none comes after a later one.
    if (end === -1) break;
    pages.push({
      attributes: xml.slice(i + open.length, tagEnd),
      body: xml.slice(tagEnd + 1, end),
    });
    from = end + close.length;
  }
  return pages;
}

/** `/<mxGraphModel\b[\s\S]*<\/mxGraphModel>/.exec(text)?.[0]`: from the first opener to the last closer. */
function findModel(text: string): string | undefined {
  const open = '<mxGraphModel';
  const close = '</mxGraphModel>';
  const start = findOpener(text, open, 0);
  if (start === -1) return undefined;
  const end = text.lastIndexOf(close);
  return end >= start + open.length
    ? text.slice(start, end + close.length)
    : undefined;
}
