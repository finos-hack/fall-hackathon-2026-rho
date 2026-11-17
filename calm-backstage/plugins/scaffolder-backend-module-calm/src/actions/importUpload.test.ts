import { IMPORT_FORMAT_LABELS } from '@internal/backstage-plugin-calm-common';
import { convertC4, convertMermaid } from '@internal/calm-import';
import { MAX_DIAGRAM_BYTES, parseDataUrl, uploadText } from './importUpload';

const url = (text: string | Buffer, name?: string) =>
  `data:text/plain;${
    name !== undefined ? `name=${encodeURIComponent(name)};` : ''
  }base64,${Buffer.from(text).toString('base64')}`;

const DRAWIO = '<mxfile><diagram/></mxfile>';
const C4 = 'C4Context\n  Person(a, "A")\n';
const MERMAID = 'flowchart LR\n  a --> b\n';
const PLANTUML = '@startuml\nPerson(a, "A")\n@enduml\n';

describe('uploadText', () => {
  it('has a 2 MB limit', () => {
    expect(MAX_DIAGRAM_BYTES).toBe(2 * 1024 * 1024);
  });

  it.each([
    ['drawio', DRAWIO, ['.drawio', '.xml', '.svg']],
    ['c4', C4, ['.md', '.mmd', '.puml', '.plantuml', '.txt']],
    ['mermaid', MERMAID, ['.md', '.mmd', '.txt']],
  ] as const)('accepts the %s extensions', (kind, text, extensions) => {
    for (const ext of extensions) {
      expect(uploadText(url(text, `a${ext.toUpperCase()}`), kind)).toBe(text);
    }
    expect(uploadText(url(text), kind)).toBe(text);
  });

  it('accepts PlantUML as C4', () => {
    expect(uploadText(url(PLANTUML, 'a.puml'), 'c4')).toBe(PLANTUML);
  });

  it.each([
    ['drawio', DRAWIO, 'a.md', 'The file is not a draw.io diagram'],
    ['c4', C4, 'a.xml', 'The file is not a C4 model'],
    ['mermaid', MERMAID, 'a.puml', 'The file is not a Mermaid flowchart'],
  ] as const)('refuses another extension for %s', (kind, text, name, msg) => {
    expect(() => uploadText(url(text, name), kind)).toThrow(msg);
    expect(() => uploadText(url(text, name), kind)).toThrow(
      `got ${JSON.stringify(name)}`,
    );
  });

  it.each(['drawio', 'c4', 'mermaid'] as const)('refuses an empty %s', kind => {
    expect(() => uploadText(url(''), kind)).toThrow('The file is empty');
  });

  it.each(['drawio', 'c4', 'mermaid'] as const)(
    'refuses over 2 MB from the base64 length for %s',
    kind => {
      const big = 'A'.repeat(Math.ceil(MAX_DIAGRAM_BYTES / 3) * 4 + 4);
      const from = jest.spyOn(Buffer, 'from');
      try {
        expect(() => uploadText(`data:text/plain;base64,${big}`, kind)).toThrow(
          'the limit is 2 MB',
        );
        expect(
          from.mock.calls.some(c => (c as unknown[])[1] === 'base64'),
        ).toBe(false);
      } finally {
        from.mockRestore();
      }
    },
  );

  it('refuses what is not a data-url', () => {
    expect(() => uploadText('a.md', 'c4')).toThrow(
      'The file is not a C4 model (.md, .mmd, .puml, .plantuml or .txt): the upload is not a file',
    );
  });

  it.each([
    ['drawio', 'c4', C4],
    ['drawio', 'c4', PLANTUML],
    ['drawio', 'mermaid', MERMAID],
    ['c4', 'drawio', DRAWIO],
    ['c4', 'mermaid', MERMAID],
    ['mermaid', 'drawio', DRAWIO],
    ['mermaid', 'c4', C4],
    ['mermaid', 'c4', PLANTUML],
  ] as const)(
    'hints when a %s upload looks like %s, naming the formats as the form does',
    (kind, other, text) => {
      const label = IMPORT_FORMAT_LABELS[kind];
      const otherLabel = IMPORT_FORMAT_LABELS[other];
      expect(() => uploadText(url(text, 'a.txt'), kind)).toThrow(
        `The file does not match the chosen format "${label}"; it looks like ${otherLabel}: choose "${otherLabel}" as the format`,
      );
    },
  );

  describe('a Markdown file with several diagrams', () => {
    const block = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\`\n`;
    const FLOWCHART_THEN_C4 = `# Design\n\n${block(MERMAID)}\n${block(C4)}`;
    const C4_THEN_FLOWCHART = `# Design\n\n${block(C4)}\n${block(MERMAID)}`;
    const SVG_AND_FLOWCHART = `# Design\n\n<svg width="8"><rect/></svg>\n\n${block(
      MERMAID,
    )}`;

    it('accepts a flowchart-then-C4 file as C4 and converts its C4 block', async () => {
      const text = uploadText(url(FLOWCHART_THEN_C4, 'design.md'), 'c4');
      const result = await convertC4(text);
      expect(result.nodes).toBe(1);
      expect((result.architecture.nodes as any[])[0]['unique-id']).toBe('a');
    });

    it('accepts a C4-then-flowchart file as Mermaid and converts its flowchart', async () => {
      const text = uploadText(url(C4_THEN_FLOWCHART, 'design.md'), 'mermaid');
      const result = await convertMermaid(text);
      expect(result.nodes).toBe(2);
    });

    it('accepts a file with an inline <svg and a flowchart block as Mermaid', async () => {
      const text = uploadText(url(SVG_AND_FLOWCHART, 'design.md'), 'mermaid');
      expect((await convertMermaid(text)).nodes).toBe(2);
    });

    it('still refuses a pure draw.io file as C4, with the hint', () => {
      expect(() => uploadText(url(DRAWIO, 'a.txt'), 'c4')).toThrow(
        'it looks like draw.io: choose "draw.io" as the format',
      );
    });
  });

  it('leaves an unrecognised c4 or mermaid text to the converter', () => {
    expect(uploadText(url('hello', 'a.md'), 'c4')).toBe('hello');
    expect(uploadText(url('hello', 'a.md'), 'mermaid')).toBe('hello');
  });
});

describe('parseDataUrl', () => {
  it('reads the name and bytes', () => {
    const p = parseDataUrl('data:text/plain;name=a%20b.md;base64,aGk=', 'c4');
    expect(p.fileName).toBe('a b.md');
    expect(p.bytes.toString()).toBe('hi');
  });
});
