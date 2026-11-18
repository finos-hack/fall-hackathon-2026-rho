import {
  FORMAT_LABELS,
  firstStatement,
  kindsIn,
  looksLike,
  mermaidBlocks,
} from './markdown';

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

  it('reads tilde fences, longer fences and an info string with more after the language (#71)', () => {
    const md = [
      '~~~mermaid',
      'flowchart LR',
      '~~~',
      '````mermaid title="Trading"',
      'C4Context',
      '```',
      'still inside: a shorter fence does not close it',
      '````',
      '```  mermaid',
      'graph TD',
      '```',
    ].join('\n');
    expect(mermaidBlocks(md)).toEqual([
      { body: 'flowchart LR', line: 2 },
      {
        body: 'C4Context\n```\nstill inside: a shorter fence does not close it',
        line: 5,
      },
      { body: 'graph TD', line: 10 },
    ]);
  });

  it('does not close a backtick fence with tildes, or a fence with an info string', () => {
    const md = ['```mermaid', 'flowchart LR', '~~~', '```js', '```'].join('\n');
    expect(mermaidBlocks(md)).toEqual([
      { body: 'flowchart LR\n~~~\n```js', line: 2 },
    ]);
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

describe('looksLike with front matter', () => {
  it('sees the header after a --- front matter block', () => {
    expect(looksLike('---\ntitle: x\n---\nC4Context\nPerson(a, "A")')).toBe(
      'c4',
    );
    expect(firstStatement('---\ntitle: x\n---\nflowchart LR')).toBe(
      'flowchart LR',
    );
  });
});

describe('kindsIn', () => {
  const block = (body: string) => `${FENCE}mermaid\n${body}\n${FENCE}`;

  it('lists every kind of block in a Markdown file, in order', () => {
    const md = [
      '# Design',
      block('flowchart LR\n a --> b'),
      block('C4Context\nPerson(a, "A")'),
    ].join('\n');
    expect(kindsIn(md)).toEqual(['mermaid', 'c4']);
    expect(kindsIn([block('C4Context'), block('graph TD')].join('\n'))).toEqual(
      ['c4', 'mermaid'],
    );
  });

  it('does not count an inline <svg in a Markdown file with a diagram block as draw.io', () => {
    const md = `<svg width="10"></svg>\n${block('flowchart LR\n a --> b')}`;
    expect(kindsIn(md)).toEqual(['mermaid']);
    expect(looksLike(md)).toBe('mermaid');
  });

  it('counts a PlantUML diagram inside a Markdown file', () => {
    expect(
      kindsIn(`${block('flowchart LR')}\n${FENCE}plantuml\n@startuml\nPerson(a, "A")\n@enduml\n${FENCE}`),
    ).toEqual(['mermaid', 'plantuml']);
  });

  it('is draw.io for a draw.io file and empty for plain text', () => {
    expect(kindsIn('<mxfile><diagram/></mxfile>')).toEqual(['drawio']);
    expect(kindsIn('hello')).toEqual([]);
  });
});

describe('FORMAT_LABELS', () => {
  it('names the formats as the import form shows them', () => {
    expect(FORMAT_LABELS).toEqual({
      drawio: 'draw.io',
      c4: 'C4 (Mermaid or PlantUML)',
      mermaid: 'Mermaid flowchart',
    });
  });
});
