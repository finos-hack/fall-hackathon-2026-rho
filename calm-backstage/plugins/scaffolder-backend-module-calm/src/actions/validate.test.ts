import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCalmValidateAction } from './validate';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-validate-action-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const run = async (architecture: object) => {
  await fs.writeFile(
    path.join(dir, 'architecture.json'),
    JSON.stringify(architecture),
  );
  const outputs: Record<string, any> = {};
  const action: any = createCalmValidateAction({
    hubUrl: 'http://localhost:8090',
  });
  await action.handler({
    input: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: (k: string, v: unknown) => {
      outputs[k] = v;
    },
    workspacePath: dir,
  });
  return outputs;
};

const schema = 'https://calm.finos.org/release/1.3/meta/calm.json';

describe('calm:validate without patternUrl', () => {
  it('validates a valid architecture against the CALM schema', async () => {
    const outputs = await run({
      $schema: schema,
      nodes: [
        {
          'unique-id': 'api',
          'node-type': 'service',
          name: 'API',
          description: 'An API',
        },
      ],
      relationships: [],
    });
    expect(outputs.errorCount).toBe(0);
  }, 120_000);

  it('fails on a node without unique-id', async () => {
    await expect(
      run({
        $schema: schema,
        nodes: [{ 'node-type': 'service', name: 'API', description: 'x' }],
        relationships: [],
      }),
    ).rejects.toThrow(/calm validate: [1-9]\d* errors/);
  }, 120_000);
});
