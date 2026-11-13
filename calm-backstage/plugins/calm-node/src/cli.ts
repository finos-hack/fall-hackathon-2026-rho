/*
 * Runs the published CALM CLI (`@finos/calm-cli`, a dependency of this package) with the backend's own Node.
 *
 * The package has `bin: { calm: 'dist/index.js' }` and no `exports` map, so its package.json resolves and the bin is
 * `<package dir>/dist/index.js`. Running it with `process.execPath` avoids a PATH lookup (and any other `calm` on it).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LoggerService } from '@backstage/backend-plugin-api';

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

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TAIL_LINES = 20;

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
export function runCalm(
  args: string[],
  opts: { cwd: string; logger: LoggerService; signal?: AbortSignal },
): Promise<void> {
  const bin = calmBin();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      signal: opts.signal,
    });
    const tail: string[] = [];
    const sink = () => {
      let partial = '';
      return {
        write(chunk: Buffer) {
          const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
          partial = lines.pop() ?? '';
          lines.forEach(l => this.line(l));
        },
        flush() {
          if (partial) {
            this.line(partial);
            partial = '';
          }
        },
        line(raw: string) {
          const l = raw.replace(ANSI, '').trimEnd();
          if (!l.trim()) {
            return;
          }
          opts.logger.info(l);
          tail.push(l);
          if (tail.length > TAIL_LINES) {
            tail.shift();
          }
        },
      };
    };
    const out = sink();
    const err = sink();
    child.stdout.on('data', c => out.write(c));
    child.stderr.on('data', c => err.write(c));
    child.on('error', reject);
    child.on('close', code => {
      out.flush();
      err.flush();
      if (code === 0) {
        resolve();
      } else {
        reject(new CalmCliError(code, tail));
      }
    });
  });
}
