import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  convertC4,
  convertDrawio,
  convertMermaid,
} from '@internal/calm-import';
import { runCalm } from './cli';
import { validateArchitecture } from './validate';

jest.mock('./cli', () => ({
  ...jest.requireActual('./cli'),
  runCalm: jest.fn(),
}));

const logger = { info: jest.fn() } as any;
const hubUrl = 'http://localhost:8090';
let dir: string;
const mockedRun = runCalm as jest.MockedFunction<typeof runCalm>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-validate-'));
  mockedRun.mockReset();
  mockedRun.mockImplementation(async args => {
    await fs.writeFile(args[args.indexOf('-o') + 1], '{}');
  });
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('validateArchitecture args', () => {
  const base = {
    architecturePath: '/w/architecture.json',
    hubUrl,
    dir: '/w',
    logger,
  };

  it('passes -p with a pattern, exactly as before', async () => {
    const outputPath = path.join(dir, 'r.json');
    await validateArchitecture({
      ...base,
      patternUrl: 'http://hub/pattern',
      outputPath,
    });
    expect(mockedRun.mock.calls[0][0]).toEqual([
      'validate',
      '-p',
      'http://hub/pattern',
      '-a',
      '/w/architecture.json',
      '-c',
      hubUrl,
      '-f',
      'json',
      '-o',
      outputPath,
    ]);
  });

  it('has no -p without a pattern', async () => {
    const outputPath = path.join(dir, 'r.json');
    await validateArchitecture({ ...base, outputPath });
    expect(mockedRun.mock.calls[0][0]).toEqual([
      'validate',
      '-a',
      '/w/architecture.json',
      '-c',
      hubUrl,
      '-f',
      'json',
      '-o',
      outputPath,
    ]);
  });
});

describe('validateArchitecture with the real CLI and no pattern', () => {
  it.each([
    ['draw.io', 'trading.drawio', convertDrawio],
    ['C4', 'trading.c4.md', convertC4],
    ['Mermaid', 'trading.mmd', convertMermaid],
  ])(
    'finds no errors in the converted %s sample',
    async (_, sample, convert) => {
      const { runCalm: realRunCalm } = jest.requireActual('./cli');
      mockedRun.mockImplementation(realRunCalm);
      const text = await fs.readFile(
        path.resolve(__dirname, '../../../../calm-import/examples', sample),
        'utf8',
      );
      const { architecture } = await convert(text);
      const architecturePath = path.join(dir, 'architecture.json');
      await fs.writeFile(architecturePath, JSON.stringify(architecture));
      const result = await validateArchitecture({
        architecturePath,
        hubUrl,
        dir,
        outputPath: path.join(dir, 'report.json'),
        logger,
      });
      expect(result.errors).toEqual([]);
      expect(result.hasErrors).toBe(false);
    },
    120_000,
  );
});
