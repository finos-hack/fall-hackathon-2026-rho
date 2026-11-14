/*
 * Runs a program and logs its output line by line. `runCalm` (the CALM CLI) and the Kubernetes helpers (`kubectl`,
 * `minikube`) run on top of this.
 */
import { spawn } from 'node:child_process';
import type { LoggerService } from '@backstage/backend-plugin-api';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TAIL_LINES = 20;

/** A program that exited with a non-zero code; `tail` holds its last output lines. */
export class ProcessError extends Error {
  constructor(
    readonly bin: string,
    readonly exitCode: number | null,
    readonly tail: string[],
  ) {
    super(
      `${bin} exited with code ${exitCode}${
        tail.length ? `:\n${tail.join('\n')}` : ''
      }`,
    );
    this.name = 'ProcessError';
  }
}

export interface RunProcessOptions {
  cwd: string;
  /** Extra environment variables, on top of the backend's own. */
  env?: Record<string, string>;
  logger: LoggerService;
  signal?: AbortSignal;
  /**
   * Keep stdout out of the log and the error tail (it is still returned): for output that is data, such as
   * `kubectl get -o json`.
   */
  quietStdout?: boolean;
}

/**
 * Runs `bin ...args` without a shell. Each non-empty output line of stdout and stderr goes to the logger at info,
 * with ANSI colour removed (many tools write progress to stderr). Resolves with the whole of stdout; rejects with a
 * `ProcessError` (exit code and the last lines of output) on a non-zero exit, and with a plain error when the
 * program is not on the backend's PATH.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      signal: opts.signal,
    });
    const tail: string[] = [];
    const stdout: Buffer[] = [];
    const sink = (log: boolean) => {
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
          if (!log || !l.trim()) {
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
    const out = sink(!opts.quietStdout);
    const err = sink(true);
    child.stdout.on('data', c => {
      stdout.push(c);
      out.write(c);
    });
    child.stderr.on('data', c => err.write(c));
    child.on('error', e => {
      reject(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(
              `${bin} was not found: it must be on the PATH of the Backstage backend`,
            )
          : e,
      );
    });
    child.on('close', code => {
      out.flush();
      err.flush();
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString('utf8') });
      } else {
        reject(new ProcessError(bin, code, tail));
      }
    });
  });
}
