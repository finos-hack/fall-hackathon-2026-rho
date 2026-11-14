/*
 * The git CLI, for the working copies of services (`output/<name>`) and the bundle sources. Every call runs `git`
 * without a shell in the given folder. Credentials are passed per call as an HTTP header (`-c http.extraHeader`), so
 * they are never written to `.git/config` or a remote URL.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { runProcess } from './process';

export interface GitAuth {
  username: string;
  password: string;
}

/** The author and committer of every commit the CALM plugins make. */
export const GIT_AUTHOR = {
  name: 'CALM Backstage',
  email: 'calm-backstage@localhost',
};

export interface GitOptions {
  logger?: LoggerService;
  signal?: AbortSignal;
  /** Fixed author and committer date (ISO 8601), for commits that must have the same SHA every time. */
  date?: string;
}

const SILENT = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return SILENT;
  },
} as unknown as LoggerService;

/** `-c` options that make git behave the same on every machine: no user config, no prompts, no hooks. */
const BASE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'credential.helper=',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'commit.gpgsign=false',
];

function authConfig(auth?: GitAuth): string[] {
  if (!auth) {
    return [];
  }
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString(
    'base64',
  );
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

/** Runs `git <args>` in `dir` and returns stdout, trimmed. */
export async function git(
  dir: string,
  args: string[],
  opts: GitOptions & { auth?: GitAuth; quiet?: boolean } = {},
): Promise<string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: GIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: GIT_AUTHOR.email,
    GIT_COMMITTER_NAME: GIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: GIT_AUTHOR.email,
    ...(opts.date
      ? { GIT_AUTHOR_DATE: opts.date, GIT_COMMITTER_DATE: opts.date }
      : {}),
  };
  const { stdout } = await runProcess(
    'git',
    [...BASE_CONFIG, ...authConfig(opts.auth), ...args],
    {
      cwd: dir,
      env,
      logger: opts.logger ?? SILENT,
      signal: opts.signal,
      quietStdout: opts.quiet ?? true,
    },
  );
  return stdout.trim();
}

/** Makes `dir` a git repository on `branch`; nothing happens when it already is one. */
export async function gitInit(
  dir: string,
  branch = 'main',
  opts: GitOptions = {},
): Promise<void> {
  const exists = await fs
    .stat(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await git(dir, ['init', '-q', '-b', branch], opts);
  }
}

/** Stages everything and commits. Returns the new commit's SHA, or undefined when there was nothing to commit. */
export async function gitCommitAll(
  dir: string,
  message: string,
  opts: GitOptions = {},
): Promise<string | undefined> {
  await git(dir, ['add', '-A'], opts);
  const status = await git(dir, ['status', '--porcelain'], opts);
  if (!status) {
    return undefined;
  }
  await git(dir, ['commit', '-q', '-m', message], opts);
  return gitHead(dir, opts);
}

/** The SHA of HEAD. */
export function gitHead(dir: string, opts: GitOptions = {}): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD'], opts);
}

/** The current branch name. */
export function gitCurrentBranch(
  dir: string,
  opts: GitOptions = {},
): Promise<string> {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
}

/** Checks out `branch`, creating it from the current HEAD (and replacing a branch of that name) when `create`. */
export async function gitCheckoutBranch(
  dir: string,
  branch: string,
  create: boolean,
  opts: GitOptions = {},
): Promise<void> {
  await git(dir, ['checkout', '-q', ...(create ? ['-B'] : []), branch], opts);
}

/** Deletes a local branch; nothing happens when it does not exist. */
export async function gitDeleteBranch(
  dir: string,
  branch: string,
  opts: GitOptions = {},
): Promise<void> {
  const list = await git(dir, ['branch', '--list', branch], opts);
  if (list) {
    await git(dir, ['branch', '-q', '-D', branch], opts);
  }
}

/** Discards uncommitted changes and untracked files (a working copy a failed run left half-written). */
export async function gitReset(
  dir: string,
  opts: GitOptions = {},
): Promise<void> {
  await git(dir, ['reset', '-q', '--hard'], opts);
  await git(dir, ['clean', '-q', '-fd'], opts);
}

/** `git diff --stat <from>` for the PR body. */
export function gitDiffStat(
  dir: string,
  from: string,
  opts: GitOptions = {},
): Promise<string> {
  return git(dir, ['diff', '--stat', from], opts);
}

/**
 * Pushes `branch` to `remoteUrl`. Never forced: a remote that has commits the working copy lacks refuses the push,
 * and the error says so.
 */
export async function gitPush(
  dir: string,
  remoteUrl: string,
  branch: string,
  auth?: GitAuth,
  opts: GitOptions = {},
): Promise<void> {
  try {
    await git(dir, ['push', '-q', remoteUrl, `${branch}:${branch}`], {
      ...opts,
      auth,
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/rejected|non-fast-forward|fetch first/.test(msg)) {
      throw new Error(
        `${remoteUrl} has commits on ${branch} that ${dir} does not have, so the push was refused (rejected). It was probably made by an earlier service of the same name: delete that repository or pick another name.`,
      );
    }
    throw e;
  }
}

/** Fetches `branch` from `remoteUrl` and fast-forwards the current branch to it (fails when it cannot). */
export async function gitPull(
  dir: string,
  remoteUrl: string,
  branch: string,
  auth?: GitAuth,
  opts: GitOptions = {},
): Promise<void> {
  await git(dir, ['pull', '-q', '--ff-only', remoteUrl, branch], {
    ...opts,
    auth,
  });
}

/** Clones `remoteUrl` (branch `branch`) into `dir`, which must not exist or be empty. */
export async function gitClone(
  remoteUrl: string,
  dir: string,
  branch?: string,
  auth?: GitAuth,
  opts: GitOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(
    path.dirname(dir),
    [
      'clone',
      '-q',
      ...(branch ? ['-b', branch] : []),
      remoteUrl,
      path.basename(dir),
    ],
    { ...opts, auth },
  );
}
