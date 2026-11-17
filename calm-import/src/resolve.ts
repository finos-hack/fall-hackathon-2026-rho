// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import type { Decision } from './decide';

export type Ask = (decision: Decision) => Promise<string>;

export async function resolve(
  decisions: Decision[],
  ask?: Ask,
): Promise<Decision[]> {
  const resolved: Decision[] = [];
  for (const decision of decisions) {
    if (decision.certain) {
      resolved.push({ ...decision, source: 'rule' });
    } else {
      const value = ask ? await ask(decision) : decision.value;
      resolved.push({
        ...decision,
        value,
        source: value === decision.value ? 'guess' : 'user',
      });
    }
  }
  return resolved;
}
