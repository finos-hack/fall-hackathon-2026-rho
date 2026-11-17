import { performance } from 'node:perf_hooks';
import { convertMermaid } from './index';

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

const flowchart = (body: string) => `flowchart LR\n${body}`;

describe('hostile Mermaid uploads', () => {
  it('reads 9,999 dotted containment edges from one container quickly', async () => {
    const edges = Array.from(
      { length: 4_999 },
      (_, n) => `c -.-o|"composed of"| n${n}\nc -.-o|"deployed in"| n${n}`,
    ).join('\n');
    const { ms, error } = await timed(async () => {
      const result = await convertMermaid(flowchart(edges));
      expect(result.relationships).toBe(2);
    });
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of A[ with no ] quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('A['.repeat(MB / 2))),
    );
    expect(error?.message).toMatch(/Unclosed \[ at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses many A[ openers spread over lines quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('A[x\n'.repeat(100_000))),
    );
    expect(error?.message).toMatch(/line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of --> quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('-->'.repeat(MB / 3))),
    );
    expect(error?.message).toMatch(/Cannot read .* at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of " quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('"'.repeat(MB))),
    );
    expect(error?.message).toMatch(/at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of an unclosed quoted label quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart(`A["${'x'.repeat(MB)}`)),
    );
    expect(error?.message).toMatch(/at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of unclosed | labels quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('A -->|x '.repeat(MB / 8))),
    );
    expect(error?.message).toMatch(/at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 1 MB of <br and < with no > quickly', async () => {
    const { ms } = await timed(() =>
      convertMermaid(flowchart(`A["${'<br '.repeat(MB / 4)}"]`)),
    );
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses a 100 000-edge chain with a clear message', async () => {
    const chain = Array.from({ length: 100_001 }, (_, i) => `n${i}`).join(
      ' --> ',
    );
    const { ms, error } = await timed(() => convertMermaid(flowchart(chain)));
    expect(error?.message).toMatch(/More than \d+ (nodes|edges) at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses more than 5000 nodes with the node message', async () => {
    const lines = Array.from(
      { length: 2_501 },
      (_, i) => `n${2 * i} --> n${2 * i + 1}`,
    );
    const { error } = await timed(() =>
      convertMermaid(flowchart(lines.join('\n'))),
    );
    expect(error?.message).toBe('More than 5000 nodes at line 2502');
  });

  it('refuses 100 000 edges between two nodes with a clear message', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('A-->B'.repeat(1) + '-->A-->B'.repeat(50_000))),
    );
    expect(error?.message).toMatch(/More than \d+ edges at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('converts the most it accepts quickly', async () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, i) => `n${i} --> n${i + 1}`,
    );
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart(lines.join('\n'))),
    );
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS * 3);
  });

  it('converts the most parallel edges it accepts quickly', async () => {
    const edges = Array.from({ length: 9_999 }, () => 'A --> B');
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart(edges.join('\n'))),
    );
    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses nesting of 51 subgraphs', async () => {
    const depth = 51;
    const text = flowchart(
      [
        ...Array.from({ length: depth }, (_, i) => `subgraph s${i}`),
        'A',
        ...Array.from({ length: depth }, () => 'end'),
      ].join('\n'),
    );
    const { ms, error } = await timed(() => convertMermaid(text));
    expect(error?.message).toMatch(/Nesting deeper than 50 levels at line 52/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('refuses 100 000 subgraphs that are never closed quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(
        flowchart(
          Array.from({ length: 100_000 }, (_, i) => `subgraph s${i}`).join(
            '\n',
          ),
        ),
      ),
    );
    expect(error?.message).toMatch(/Nesting deeper than 50 levels|no end/);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('reads many end lines with no subgraph quickly', async () => {
    const { ms, error } = await timed(() =>
      convertMermaid(flowchart('end\n'.repeat(100_000))),
    );
    expect(error?.message).toMatch(/"end" with no subgraph at line 2/);
    expect(ms).toBeLessThan(FAST_MS);
  });
});
