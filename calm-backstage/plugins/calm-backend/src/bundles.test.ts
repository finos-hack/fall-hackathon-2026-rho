import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBundleMeta } from '@internal/backstage-plugin-calm-common';
import { bundleDiff, bundleFile, bundleFiles, groupBundles } from './bundles';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-explorer-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function folder(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  for (const [f, t] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), t);
  }
  return dir;
}

const reg = (
  name: string,
  version: string,
  kind: string,
  annotations: Record<string, string> = {},
) => ({
  ...readBundleMeta({
    name,
    version,
    kind,
    patterns: [{ patternId: 'web-service' }],
  }),
  ref: `localhost:5050/calm-bundles/${name}:${version}`,
  digest: `sha256:${name}${version}`,
  annotations,
});

describe('groupBundles', () => {
  it('groups registry tags by name with kind and annotations, starters first and newest version first', () => {
    const grouped = groupBundles([
      reg('web-service', '3.0.0', 'full'),
      reg('k8s-deploy', '1.0.0', 'deployment'),
      reg('k8s-deploy', '1.1.0', 'deployment', {
        'org.opencontainers.image.source':
          'http://localhost:3300/calm-templates/bundles/src/commit/abc/k8s-deploy/1.1.0',
        'org.opencontainers.image.revision': 'abc',
        'org.opencontainers.image.created': '2026-11-14T17:44:12Z',
      }),
      reg('spring-boot-service', '1.0.0', 'starter'),
    ]);
    expect(grouped.map(g => [g.name, g.kind])).toEqual([
      ['spring-boot-service', 'starter'],
      ['k8s-deploy', 'deployment'],
      ['web-service', 'full'],
    ]);
    expect(grouped[1].versions.map(v => v.version)).toEqual(['1.1.0', '1.0.0']);
    expect(grouped[1].versions[0]).toMatchObject({
      source:
        'http://localhost:3300/calm-templates/bundles/src/commit/abc/k8s-deploy/1.1.0',
      revision: 'abc',
      created: '2026-11-14T17:44:12Z',
    });
    expect(grouped[1].versions[1].source).toBeUndefined();
  });

  it('drops a source annotation that is not an http(s) URL', () => {
    const [g] = groupBundles([
      reg('x', '1.0.0', 'starter', {
        'org.opencontainers.image.source': 'javascript:alert(1)',
      }),
    ]);
    expect(g.versions[0].source).toBeUndefined();
  });
});

describe('bundle files', () => {
  it('lists the files and refuses a path not listed in the bundle', async () => {
    const dir = await folder('b', {
      'index.json': '{}',
      'templates/app.hbs': 'hello',
    });
    await folder('secret', { 'x.txt': 'no' });
    expect(await bundleFiles(dir)).toEqual([
      { path: 'index.json', size: 2 },
      { path: 'templates/app.hbs', size: 5 },
    ]);
    expect(await bundleFile(dir, 'templates/app.hbs')).toBe('hello');
    expect(await bundleFile(dir, '../secret/x.txt')).toBeUndefined();
    expect(await bundleFile(dir, '/etc/passwd')).toBeUndefined();
  });

  it('reports added, removed and changed files with a unified patch', async () => {
    const a = await folder('a', {
      'same.txt': 's',
      'gone.txt': 'g',
      'app.js': 'one\ntwo\n',
    });
    const b = await folder('b', {
      'same.txt': 's',
      'new.txt': 'n',
      'app.js': 'one\nthree\n',
    });
    const diff = await bundleDiff(a, b, '1.0.0', '1.1.0');
    expect(diff.map(d => [d.path, d.status])).toEqual([
      ['app.js', 'changed'],
      ['gone.txt', 'removed'],
      ['new.txt', 'added'],
    ]);
    expect(diff[0].patch).toContain('-two');
    expect(diff[0].patch).toContain('+three');
    expect(diff[0].patch).toContain('1.0.0/app.js');
  });
});
