/*
 * Runs the published CALM CLI (`@finos/calm-cli`, a dependency of this package) with the backend's own Node.
 *
 * The package has `bin: { calm: 'dist/index.js' }` and no `exports` map, so its package.json resolves and the bin is
 * `<package dir>/dist/index.js`. Running it with `process.execPath` avoids a PATH lookup (and any other `calm` on it).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { ProcessError, runProcess } from './process';

let cachedBin: string | undefined;

/** Absolute path of the `calm` bin from the `@finos/calm-cli` dependency. */
export function calmBin(): string {
  if (!cachedBin) {
    const pkgJson = require.resolve('@finos/calm-cli/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.calm;
    if (typeof bin !== 'string') {
      throw new Error(`No calm bin in ${pkgJson}`);
    }
    cachedBin = path.resolve(path.dirname(pkgJson), bin);
  }
  return cachedBin;
}

export class CalmCliError extends Error {
  constructor(readonly exitCode: number | null, readonly tail: string[]) {
    super(
      `calm exited with code ${exitCode}${
        tail.length ? `:\n${tail.join('\n')}` : ''
      }`,
    );
    this.name = 'CalmCliError';
  }
}

/**
 * Runs `node <calm bin> ...args`. Each output line of stdout and stderr goes to the logger at info: the CLI writes its
 * progress lines to stderr as well as its errors. Rejects with the exit code and the last lines of output on a non-zero
 * exit.
 */
export async function runCalm(
  args: string[],
  opts: { cwd: string; logger: LoggerService; signal?: AbortSignal },
): Promise<void> {
  try {
    await runProcess(process.execPath, [calmBin(), ...args], {
      cwd: opts.cwd,
      env: { NO_COLOR: '1', FORCE_COLOR: '0' },
      logger: opts.logger,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof ProcessError) {
      throw new CalmCliError(e.exitCode, e.tail);
    }
    throw e;
  }
}
