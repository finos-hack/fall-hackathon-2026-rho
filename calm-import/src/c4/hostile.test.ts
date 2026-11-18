import { performance } from 'node:perf_hooks';
import { convertC4 } from './index';

// Uploads reach the converter from the scaffolder, so hostile input must fail fast and clearly, never block the event
// loop. A linear scan of these takes well under a second even while vitest runs other files in parallel; a
// quadratic one takes minutes. The bound sits between the two, so a loaded machine does not flake it.
const FAST_MS = 2000;
const MB = 1024 * 1024;

async function timed(run: () => Promise<unknown>): Promise<{
  ms: number;
  error?: Error;
}> {
  const start = performance.now();
  let error: Error | undefined;
  try {
    await run();
  } catch (e) {
    error = e as Error;
  }
  return { ms: performance.now() - start, error };
}

const diagram = (body: string) => `C4Container\nPerson(p, "P")\n${body}\n`;

describe('hostile C4 uploads', () => {
  it('lists 1 MB of "Container(" with no ")" as one skipped line, quickly', async () => {
    const { ms, error } = await timed(async () => {
      const result = await convertC4(diagram('Container('.repeat(MB / 10)));
      expect(result.nodes).toBe(1);
      expect(result.report).toContain('Skipped:');
      // The report keeps a short excerpt of the line, not the megabyte.
      expect(result.report.length).toBeLessThan(2_000);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads one 1 MB line, quickly', async () => {
    const { ms, error } = await timed(async () => {
      const result = await convertC4(
        diagram(`Container(a, "A", "service", "${'x'.repeat(MB)}")`),
      );
      expect(result.nodes).toBe(2);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 1 MB of quotes, quickly', async () => {
    const { ms, error } = await timed(async () => {
      await convertC4(diagram(`Container(${'"'.repeat(MB)}`));
      await convertC4(diagram(`Container(a, ${'"'.repeat(MB + 1)})`));
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 100 000 Rel lines, quickly', async () => {
    const rels = 'Rel(p, a, "Calls")\n'.repeat(100_000);
    const { ms, error } = await timed(async () => {
      const result = await convertC4(
        diagram(`Container(a, "A", "service", "")\n${rels}`),
      );
      expect(result.relationships).toBe(100_000);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('skips 100 000 Rel lines that name unknown aliases, quickly', async () => {
    const { ms, error } = await timed(async () => {
      const result = await convertC4(
        diagram('Rel(nobody, nowhere, "Calls")\n'.repeat(100_000)),
      );
      expect(result.relationships).toBe(0);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses nesting of 51 levels with the line, quickly', async () => {
    const body = 'Boundary(b, "B") {\n'.repeat(51) + '}\n'.repeat(51);
    const { ms, error } = await timed(() => convertC4(diagram(body)));
    expect(error?.message).toBe('Nesting deeper than 50 levels at line 53');
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of "{" with the nesting error, not a hang', async () => {
    const { ms, error } = await timed(() =>
      convertC4(diagram(`Boundary(b, "B") {\n${'Boundary(b, "B") {'.repeat(1000)}`)),
    );
    expect(error?.message).toMatch(/Nesting deeper than 50 levels|Unbalanced/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of "}" with the line, quickly', async () => {
    const { ms, error } = await timed(() =>
      convertC4(diagram('}'.repeat(MB))),
    );
    expect(error?.message).toBe('Unbalanced "}" at line 3');
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 1 MB of comment openers and closers, quickly', async () => {
    const { ms, error } = await timed(async () => {
      await convertC4(diagram("/''/".repeat(MB / 4)));
      await convertC4(diagram("/'\n".repeat(MB / 3)));
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 1 MB of "$" and of ",", quickly', async () => {
    const { ms, error } = await timed(async () => {
      await convertC4(diagram(`Container(a, ${'$'.repeat(MB)})`));
      await convertC4(diagram(`Container(a${','.repeat(MB)})`));
      await convertC4(diagram(`Container(${'$a '.repeat(MB / 3)})`));
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses a file with no C4 diagram, 1 MB of text, quickly', async () => {
    const { ms, error } = await timed(() => convertC4('x '.repeat(MB / 2)));
    expect(error?.message).toMatch(/^No C4 diagram found/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 40 000 boundaries that reuse the alias of the last of 40 000 persons, quickly', async () => {
    const people = Array.from(
      { length: 40_000 },
      (_, n) => `Person(p${n},"")`,
    ).join('\n');
    const boundaries = 'Boundary(p39999,"x"){\n}\n'.repeat(40_000);
    const { ms, error } = await timed(async () => {
      const result = await convertC4(`C4Context\n${people}\n${boundaries}`);
      expect(result.nodes).toBe(40_000);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 1 MB of one-line blocks on a single line, quickly', async () => {
    const { ms, error } = await timed(async () => {
      const result = await convertC4(
        diagram('Boundary(b,"B"){ Person(q,"Q") }'.repeat(MB / 32)),
      );
      expect(result.nodes).toBe(3);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads 1 MB of a web-client word with no boundary, quickly', async () => {
    const { ms, error } = await timed(() =>
      convertC4(diagram(`Container(a, "${'web '.repeat(MB / 4)}x")`)),
    );
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });
});
