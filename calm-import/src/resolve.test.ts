// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import type { Decision } from './decide';
import { resolve } from './resolve';

function decision(
  targetId: string,
  certain: boolean,
  value = 'system',
): Decision {
  return {
    kind: 'node-type',
    targetId,
    subject: targetId,
    value,
    options: [value, 'service', 'other…'],
    certain,
    reason: 'queue shape; CALM has no queue type',
  };
}

describe('resolve', () => {
  it('certain decisions are not asked', async () => {
    const ask = vi.fn();
    const [result] = await resolve([decision('a', true)], ask);
    expect(ask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ value: 'system', source: 'rule' });
  });

  it('without ask unsure decisions keep the guess', async () => {
    const [result] = await resolve([decision('a', false)]);
    expect(result).toMatchObject({ value: 'system', source: 'guess' });
  });

  it('answers replace the guess and mark the source user', async () => {
    const [result] = await resolve(
      [decision('a', false)],
      async () => 'service',
    );
    expect(result).toMatchObject({ value: 'service', source: 'user' });
  });

  it('accepting the guess marks the source guess', async () => {
    const [result] = await resolve(
      [decision('a', false)],
      async () => 'system',
    );
    expect(result).toMatchObject({ value: 'system', source: 'guess' });
  });

  it('asks in order and does not change the input', async () => {
    const asked: string[] = [];
    const input = [
      decision('a', false),
      decision('b', true),
      decision('c', false),
    ];
    await resolve(input, async d => {
      asked.push(d.targetId);
      return 'service';
    });
    expect(asked).toEqual(['a', 'c']);
    expect(
      input.every(d => d.source === undefined && d.value === 'system'),
    ).toBe(true);
  });
});
