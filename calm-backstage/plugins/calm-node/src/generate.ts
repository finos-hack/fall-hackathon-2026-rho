import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { runCalm } from './cli';

/** Name of the `--option-choices` file written next to the output. */
export const CHOICES_FILE = 'calm-option-choices.json';

/**
 * Normalises choices to the `--option-choices` shape: drops unanswered decisions (undefined, null, empty string, empty
 * list). Values are passed on as given; the CLI checks them against the pattern.
 */
export function normaliseChoices(
  choices: Record<string, unknown>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [id, value] of Object.entries(choices ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      const list = value.filter(v => v !== undefined && v !== null && v !== '');
      if (list.length) {
        out[id] = list.map(String);
      }
    } else if (typeof value === 'string') {
      out[id] = value;
    } else {
      throw new Error(
        `Choice for [${id}] must be a string or a list of strings, got ${JSON.stringify(
          value,
        )}`,
      );
    }
  }
  return out;
}

export interface GenerateArchitectureOptions {
  /** Pattern URL in CALM Hub (the pattern `$id`). */
  patternUrl: string;
  /** CALM Hub base URL (`calm generate -c`). */
  hubUrl: string;
  /** Decision (relationship) id -> choice description (`oneOf`) or list of descriptions (`anyOf`). */
  choices: Record<string, unknown>;
  /** Folder the CLI runs in; the choices file is written here. */
  dir: string;
  /** Absolute path of the architecture file. Default `<dir>/architecture.json`. */
  outputPath?: string;
  logger: LoggerService;
  signal?: AbortSignal;
}

export interface GenerateArchitectureResult {
  /** Absolute path of the architecture file. */
  architecturePath: string;
  architecture: any;
  /** The `--option-choices` JSON that was passed. */
  choices: Record<string, string | string[]>;
  nodeCount: number;
  relationshipCount: number;
}

/**
 * Runs `calm generate -p <patternUrl> -c <hubUrl> -o <outputPath> --option-choices <dir>/calm-option-choices.json`
 * in `dir` and reads the result.
 */
export async function generateArchitecture(
  opts: GenerateArchitectureOptions,
): Promise<GenerateArchitectureResult> {
  const target = opts.outputPath ?? path.join(opts.dir, 'architecture.json');
  await fs.mkdir(path.dirname(target), { recursive: true });

  const choices = normaliseChoices(opts.choices ?? {});
  const choicesFile = path.join(opts.dir, CHOICES_FILE);
  await fs.writeFile(choicesFile, JSON.stringify(choices, null, 2));
  opts.logger.info(`--option-choices ${JSON.stringify(choices)}`);

  const args = [
    'generate',
    '-p',
    opts.patternUrl,
    '-c',
    opts.hubUrl,
    '-o',
    target,
    '--option-choices',
    choicesFile,
  ];
  opts.logger.info(`calm ${args.join(' ')}`);
  await runCalm(args, {
    cwd: opts.dir,
    logger: opts.logger,
    signal: opts.signal,
  });

  const architecture = JSON.parse(await fs.readFile(target, 'utf8'));
  return {
    architecturePath: target,
    architecture,
    choices,
    nodeCount: Array.isArray(architecture.nodes)
      ? architecture.nodes.length
      : 0,
    relationshipCount: Array.isArray(architecture.relationships)
      ? architecture.relationships.length
      : 0,
  };
}
