import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  git,
  gitCheckoutBranch,
  gitClone,
  gitCommitAll,
  gitHead,
  gitInit,
  gitPush,
} from './git';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-git-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function bareRemote(): Promise<string> {
  const dir = path.join(root, 'remote.git');
  await fs.mkdir(dir);
  await git(dir, ['init', '-q', '--bare', '-b', 'main']);
  return `file://${dir}`;
}

async function workingCopy(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), text);
  }
  await gitInit(dir);
  return dir;
}

describe('git', () => {
  it('gitCommitAll returns the new sha, then undefined when nothing changed', async () => {
    const dir = await workingCopy('a', { 'README.md': 'hello' });
    const sha = await gitCommitAll(dir, 'first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitHead(dir)).toBe(sha);
    expect(await gitCommitAll(dir, 'again')).toBeUndefined();
    expect(await git(dir, ['log', '-1', '--format=%an <%ae>'])).toBe(
      'CALM Backstage <calm-backstage@localhost>',
    );
  });

  it('gives the same sha for the same tree, message and fixed date', async () => {
    const date = '2026-11-14T00:00:00Z';
    const a = await workingCopy('a', { 'x.txt': '1' });
    const b = await workingCopy('b', { 'x.txt': '1' });
    expect(await gitCommitAll(a, 'sync', { date })).toBe(
      await gitCommitAll(b, 'sync', { date }),
    );
  });

  it('gitPush then a clone of the remote has the commit', async () => {
    const remote = await bareRemote();
    const dir = await workingCopy('a', { 'src/app.js': 'x' });
    const sha = await gitCommitAll(dir, 'first');
    await gitPush(dir, remote, 'main');
    const clone = path.join(root, 'clone');
    await gitClone(remote, clone, 'main');
    expect(await gitHead(clone)).toBe(sha);
  });

  it('gitPush is refused when the remote has a commit the working copy lacks', async () => {
    const remote = await bareRemote();
    const earlier = await workingCopy('earlier', { 'a.txt': 'old service' });
    await gitCommitAll(earlier, 'old');
    await gitPush(earlier, remote, 'main');

    const dir = await workingCopy('a', { 'a.txt': 'new service' });
    await gitCommitAll(dir, 'new');
    await expect(gitPush(dir, remote, 'main')).rejects.toThrow(/rejected/);
  });

  it('pushes a new branch', async () => {
    const remote = await bareRemote();
    const dir = await workingCopy('a', { 'a.txt': '1' });
    await gitCommitAll(dir, 'first');
    await gitPush(dir, remote, 'main');
    await gitCheckoutBranch(dir, 'upgrade/deploy-1.1.0', true);
    await fs.writeFile(path.join(dir, 'a.txt'), '2');
    const sha = await gitCommitAll(dir, 'upgrade');
    await gitPush(dir, remote, 'upgrade/deploy-1.1.0');
    const bare = remote.replace('file://', '');
    expect(await git(bare, ['rev-parse', 'upgrade/deploy-1.1.0'])).toBe(sha);
  });

  it('does not write the auth header to .git/config', async () => {
    const remote = await bareRemote();
    const dir = await workingCopy('a', { 'a.txt': '1' });
    await gitCommitAll(dir, 'first');
    await gitPush(dir, remote, 'main', {
      username: 'calm',
      password: 'secret-pw',
    });
    const config = await fs.readFile(path.join(dir, '.git', 'config'), 'utf8');
    expect(config).not.toContain('secret-pw');
    expect(config).not.toContain('Authorization');
  });
});
