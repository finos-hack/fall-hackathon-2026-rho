import { looksLike, mermaidBlocks } from './markdown';

const FENCE = '```';

describe('mermaidBlocks', () => {
  it('returns every mermaid block with the line of its first body line', () => {
    const md = [
      '# Title',
      `${FENCE}mermaid`,
      'flowchart LR',
      '  a --> b',
      FENCE,
      'text',
      `${FENCE}mermaid`,
      'C4Context',
      FENCE,
    ].join('\n');
    expect(mermaidBlocks(md)).toEqual([
      { body: 'flowchart LR\n  a --> b', line: 3 },
      { body: 'C4Context', line: 8 },
    ]);
  });

  it('handles CRLF and skips other fences', () => {
    const md = `${FENCE}ts\nx\n${FENCE}\r\n${FENCE}mermaid\r\ngraph TD\r\n${FENCE}\r\n`;
    expect(mermaidBlocks(md)).toEqual([{ body: 'graph TD', line: 5 }]);
  });

  it('is empty without a mermaid fence', () => {
    expect(mermaidBlocks('flowchart LR\na-->b')).toEqual([]);
  });
});

describe('looksLike', () => {
  it.each([
    ['<mxfile><diagram/></mxfile>', 'drawio'],
    ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'drawio'],
    ['C4Container\n  Person(a, "A")', 'c4'],
    ['﻿%% a comment\r\nC4Context', 'c4'],
    [`${FENCE}mermaid\nC4Deployment\n${FENCE}`, 'c4'],
    [`${FENCE}mermaid\nC4Dynamic\n${FENCE}`, 'c4'],
    [
      '@startuml\n!include <C4/C4_Container>\nPerson(a, "A")\n@enduml',
      'plantuml',
    ],
    ['flowchart LR\n a --> b', 'mermaid'],
    [`${FENCE}mermaid\ngraph TD\n a --> b\n${FENCE}`, 'mermaid'],
    ['sequenceDiagram\n a->>b: hi', undefined],
    ['hello', undefined],
  ])('%j is %s', (text, kind) => {
    expect(looksLike(text)).toBe(kind);
  });
});
