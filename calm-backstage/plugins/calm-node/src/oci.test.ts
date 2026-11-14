import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
  checkBundle,
  BUNDLE_ARTIFACT_TYPE,
  BUNDLE_CONFIG_MEDIA_TYPE,
  OCI_LAYER_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  OciError,
  bundleRef,
  extractBundle,
  listRepositories,
  listTags,
  packBundle,
  parseRef,
  pullBundle,
  pullBundleCached,
  pushBundle,
  readBundleConfig,
} from './oci';
import { listFiles } from './files';

const sha256 = (b: Buffer) =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** An in-process registry: the parts of the registry HTTP API v2 the client uses, held in memory. */
class FakeRegistry {
  readonly blobs = new Map<string, Buffer>();
  readonly manifests = new Map<string, { type: string; body: Buffer }>();
  readonly requests: string[] = [];
  private uploads = 0;
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => this.handle(req, res, Buffer.concat(chunks)));
  });

  async start(): Promise<string> {
    await new Promise<void>(resolve =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    return `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise(resolve => this.server.close(resolve));
  }

  uploadCount(): number {
    return this.requests.filter(r => r.startsWith('PUT /v2/_upload/')).length;
  }

  private handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) {
    const url = new URL(req.url ?? '/', 'http://registry');
    const method = req.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}`);
    const send = (
      status: number,
      headers: Record<string, string> = {},
      data?: Buffer | string,
    ) => {
      res.writeHead(status, headers);
      res.end(method === 'HEAD' ? undefined : data);
    };
    const json = (value: unknown) =>
      send(200, { 'Content-Type': 'application/json' }, JSON.stringify(value));

    if (url.pathname === '/v2/_catalog') {
      const repositories = [
        ...new Set([...this.manifests.keys()].map(k => k.split(':')[0])),
      ];
      return json({ repositories });
    }
    let m = /^\/v2\/(.+)\/tags\/list$/.exec(url.pathname);
    if (m) {
      const tags = [...this.manifests.keys()]
        .filter(k => k.startsWith(`${m![1]}:`))
        .map(k => k.slice(m![1].length + 1));
      return tags.length ? json({ name: m[1], tags }) : send(404);
    }
    m = /^\/v2\/(.+)\/blobs\/uploads\/$/.exec(url.pathname);
    if (m && method === 'POST') {
      // Relative, with a query string of its own, as registry:2 answers.
      return send(202, {
        Location: `/v2/_upload/${++this.uploads}?_state=abc`,
      });
    }
    m = /^\/v2\/_upload\/\d+$/.exec(url.pathname);
    if (m && method === 'PUT') {
      const digest = url.searchParams.get('digest') ?? '';
      if (url.searchParams.get('_state') !== 'abc' || sha256(body) !== digest) {
        return send(400, {}, 'bad upload');
      }
      this.blobs.set(digest, body);
      return send(201, { 'Docker-Content-Digest': digest });
    }
    m = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
    if (m) {
      const blob = this.blobs.get(m[2]);
      return blob
        ? send(200, { 'Content-Length': String(blob.length) }, blob)
        : send(404, {}, 'blob unknown');
    }
    m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
    if (m && method === 'PUT') {
      this.manifests.set(`${m[1]}:${m[2]}`, {
        type: String(req.headers['content-type']),
        body,
      });
      return send(201, { 'Docker-Content-Digest': sha256(body) });
    }
    if (m) {
      const manifest = this.manifests.get(`${m[1]}:${m[2]}`);
      // registry:2 answers 404 for an OCI manifest the client does not accept.
      if (!manifest || !String(req.headers.accept).includes(manifest.type)) {
        return send(404, {}, 'manifest unknown');
      }
      return send(
        200,
        {
          'Content-Type': manifest.type,
          'Docker-Content-Digest': sha256(manifest.body),
        },
        manifest.body,
      );
    }
    return send(404, {}, 'not found');
  }
}

const CONFIG = {
  name: 'web-service',
  version: '2.0.0',
  description: 'A test bundle',
  pattern: { namespace: 'hackathon', patternId: 'web-service' },
};

async function writeBundle(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'deploy'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'calm-backstage.json'),
    JSON.stringify(CONFIG, null, 2),
  );
  await fs.writeFile(path.join(dir, 'index.json'), '{"name":"web-service"}');
  await fs.writeFile(path.join(dir, 'README.md.hbs'), '# {{name}}\n');
  await fs.writeFile(path.join(dir, 'deploy', 'compose.yml.hbs'), 'a: 1\n');
}

async function readAll(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await listFiles(dir)) {
    out[f] = await fs.readFile(path.join(dir, f), 'utf8');
  }
  return out;
}

describe('parseRef', () => {
  it('splits registry, repository and tag, with http for local registries', () => {
    expect(parseRef('localhost:5050/calm-bundles/web-service:2.0.0')).toEqual({
      registry: 'localhost:5050',
      repository: 'calm-bundles/web-service',
      tag: '2.0.0',
      baseUrl: 'http://localhost:5050',
    });
    expect(parseRef('127.0.0.1:5050/a/b:1').baseUrl).toBe(
      'http://127.0.0.1:5050',
    );
  });

  it('uses https for other registries unless http is explicit', () => {
    expect(parseRef('ghcr.io/finos/bundles/web-service:1.0.0')).toEqual({
      registry: 'ghcr.io',
      repository: 'finos/bundles/web-service',
      tag: '1.0.0',
      baseUrl: 'https://ghcr.io',
    });
    expect(parseRef('http://registry.internal:5000/a:1').baseUrl).toBe(
      'http://registry.internal:5000',
    );
    expect(parseRef('localhost:5050/a').tag).toBe('latest');
  });

  it('rejects what is not a reference', () => {
    expect(() => parseRef('web-service')).toThrow(/Not an OCI reference/);
    expect(() => parseRef('localhost:5050/Upper:1')).toThrow(
      /Not an OCI reference/,
    );
    expect(() => parseRef('localhost:5050/a:../b')).toThrow(
      /Not an OCI reference/,
    );
  });
});

describe('bundleRef', () => {
  it('builds a reference parseRef reads back to the same registry', () => {
    expect(
      bundleRef('http://localhost:5050/', 'calm-bundles', 'web-service', '2'),
    ).toBe('localhost:5050/calm-bundles/web-service:2');
    expect(bundleRef('https://ghcr.io', 'finos/bundles', 'a', '1')).toBe(
      'ghcr.io/finos/bundles/a:1',
    );
    const plain = bundleRef('http://registry.internal:5000', 'b', 'a', '1');
    expect(plain).toBe('http://registry.internal:5000/b/a:1');
    expect(parseRef(plain).baseUrl).toBe('http://registry.internal:5000');
  });
});

describe('bundles in a registry', () => {
  let registry: FakeRegistry;
  let host: string;
  let tmp: string;
  let bundleDir: string;

  beforeEach(async () => {
    registry = new FakeRegistry();
    host = await registry.start();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-oci-test-'));
    bundleDir = path.join(tmp, 'bundle');
    await writeBundle(bundleDir);
  });

  afterEach(async () => {
    await registry.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('pushes an OCI artifact and pulls back identical files', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    const pushed = await pushBundle({ dir: bundleDir, ref });
    expect(pushed.ref).toBe(ref);

    const stored = registry.manifests.get('calm-bundles/web-service:2.0.0')!;
    expect(stored.type).toBe(OCI_MANIFEST_MEDIA_TYPE);
    expect(pushed.digest).toBe(sha256(stored.body));
    const manifest = JSON.parse(stored.body.toString('utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST_MEDIA_TYPE,
      artifactType: BUNDLE_ARTIFACT_TYPE,
      config: { mediaType: BUNDLE_CONFIG_MEDIA_TYPE },
      layers: [
        {
          mediaType: OCI_LAYER_MEDIA_TYPE,
          annotations: { 'org.opencontainers.image.title': 'bundle.tar.gz' },
        },
      ],
      annotations: {
        'org.opencontainers.image.version': '2.0.0',
        'org.opencontainers.image.description': 'A test bundle',
      },
    });
    expect(manifest.layers).toHaveLength(1);
    // The config blob is the bundle's calm-backstage.json, byte for byte.
    expect(registry.blobs.get(manifest.config.digest)).toEqual(
      await fs.readFile(path.join(bundleDir, 'calm-backstage.json')),
    );

    const dest = path.join(tmp, 'pulled');
    const pulled = await pullBundle({ ref, destDir: dest });
    expect(pulled).toEqual({ digest: pushed.digest, dir: dest });
    expect(await readAll(dest)).toEqual(await readAll(bundleDir));
  });

  it('gives the same digest for a second push, and for a copy of the folder', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    const first = await pushBundle({ dir: bundleDir, ref });
    const uploads = registry.uploadCount();
    expect(uploads).toBe(2);

    const second = await pushBundle({ dir: bundleDir, ref });
    expect(second.digest).toBe(first.digest);
    // Both blobs were found with HEAD, so nothing was uploaded again.
    expect(registry.uploadCount()).toBe(uploads);

    // A copy has new mtimes; the layer must not depend on them.
    const copy = path.join(tmp, 'copy');
    await writeBundle(copy);
    const past = new Date('2011-11-11T11:11:11Z');
    await fs.utimes(path.join(copy, 'index.json'), past, past);
    expect(sha256(await packBundle(copy))).toBe(
      sha256(await packBundle(bundleDir)),
    );
    const third = await pushBundle({
      dir: copy,
      ref: `${host}/calm-bundles/web-service:copy`,
    });
    expect(third.digest).toBe(first.digest);
  });

  it('writes the given annotations', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    await pushBundle({
      dir: bundleDir,
      ref,
      annotations: {
        'org.opencontainers.image.source': 'http://localhost:3300/calm-templates/bundles/src/commit/abc/web-service/2.0.0',
        'org.opencontainers.image.revision': 'abc',
      },
    });
    const manifest = JSON.parse(
      registry.manifests.get('calm-bundles/web-service:2.0.0')!.body.toString('utf8'),
    );
    expect(manifest.annotations).toMatchObject({
      'org.opencontainers.image.version': '2.0.0',
      'org.opencontainers.image.revision': 'abc',
    });
  });

  it('with immutable, skips an identical layer without touching the manifest', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    const first = await pushBundle({ dir: bundleDir, ref });
    const before = registry.manifests.get('calm-bundles/web-service:2.0.0')!.body;
    const again = await pushBundle({
      dir: bundleDir,
      ref,
      immutable: true,
      annotations: { 'org.opencontainers.image.revision': 'new' },
    });
    expect(again).toEqual({ ref, digest: first.digest, skipped: true });
    expect(registry.manifests.get('calm-bundles/web-service:2.0.0')!.body).toEqual(before);
  });

  it('with immutable, refuses different content for an existing tag', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    await pushBundle({ dir: bundleDir, ref });
    await fs.writeFile(path.join(bundleDir, 'index.json'), '{"changed":true}');
    await expect(pushBundle({ dir: bundleDir, ref, immutable: true })).rejects.toThrow(
      /already published with different content; publish a new version/,
    );
  });

  it('checkBundle says new, same or changed', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    expect(await checkBundle({ dir: bundleDir, ref })).toBe('new');
    await pushBundle({ dir: bundleDir, ref });
    expect(await checkBundle({ dir: bundleDir, ref })).toBe('same');
    await fs.writeFile(path.join(bundleDir, 'index.json'), '{"changed":true}');
    expect(await checkBundle({ dir: bundleDir, ref })).toBe('changed');
  });

  it('with immutable, pushes a tag that is not there yet', async () => {
    const ref = `${host}/calm-bundles/web-service:9.9.9`;
    const pushed = await pushBundle({ dir: bundleDir, ref, immutable: true });
    expect(pushed.skipped).toBeUndefined();
    expect(registry.manifests.has('calm-bundles/web-service:9.9.9')).toBe(true);
  });

  it('lists repositories under a prefix and their tags', async () => {
    await pushBundle({
      dir: bundleDir,
      ref: `${host}/calm-bundles/web-service:1.0.0`,
    });
    await pushBundle({
      dir: bundleDir,
      ref: `${host}/calm-bundles/web-service:2.0.0`,
    });
    await pushBundle({ dir: bundleDir, ref: `${host}/other/thing:1.0.0` });
    await pushBundle({ dir: bundleDir, ref: `${host}/calm-bundles-x/y:1` });

    expect(await listRepositories(`http://${host}`)).toEqual([
      'calm-bundles-x/y',
      'calm-bundles/web-service',
      'other/thing',
    ]);
    expect(await listRepositories(`http://${host}/`, 'calm-bundles')).toEqual([
      'calm-bundles/web-service',
    ]);
    expect(
      (await listTags(`http://${host}`, 'calm-bundles/web-service')).sort(),
    ).toEqual(['1.0.0', '2.0.0']);
    expect(await listTags(`http://${host}`, 'calm-bundles/none')).toEqual([]);
  });

  it('reads the config and the manifest digest', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    const pushed = await pushBundle({ dir: bundleDir, ref });
    expect(await readBundleConfig(ref)).toEqual({
      digest: pushed.digest,
      config: CONFIG,
      annotations: {
        'org.opencontainers.image.version': '2.0.0',
        'org.opencontainers.image.description': 'A test bundle',
      },
      size: expect.any(Number),
    });
    await expect(
      readBundleConfig(`${host}/calm-bundles/web-service:9.9.9`),
    ).rejects.toMatchObject({ name: 'OciError', status: 404 });
  });

  it('refuses a config blob that does not match its digest', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    await pushBundle({ dir: bundleDir, ref });
    const manifest = JSON.parse(
      registry.manifests
        .get('calm-bundles/web-service:2.0.0')!
        .body.toString('utf8'),
    );
    registry.blobs.set(manifest.config.digest, Buffer.from('{"name":"evil"}'));
    await expect(readBundleConfig(ref)).rejects.toThrow(/Digest mismatch/);
  });

  it('fails with a digest error on a corrupted layer and extracts nothing', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    await pushBundle({ dir: bundleDir, ref });
    const manifest = JSON.parse(
      registry.manifests
        .get('calm-bundles/web-service:2.0.0')!
        .body.toString('utf8'),
    );
    const layer = Buffer.from(registry.blobs.get(manifest.layers[0].digest)!);
    layer[layer.length - 1] ^= 0xff;
    registry.blobs.set(manifest.layers[0].digest, layer);

    const dest = path.join(tmp, 'pulled');
    await expect(pullBundle({ ref, destDir: dest })).rejects.toThrow(
      /Digest mismatch/,
    );
    expect(await fs.readdir(tmp)).toEqual(['bundle']);
  });

  it('refuses an artifact that is not a template bundle', async () => {
    registry.manifests.set('calm-bundles/web-service:1', {
      type: OCI_MANIFEST_MEDIA_TYPE,
      body: Buffer.from(
        JSON.stringify({ schemaVersion: 2, config: {}, layers: [] }),
      ),
    });
    await expect(
      readBundleConfig(`${host}/calm-bundles/web-service:1`),
    ).rejects.toThrow(/not a CALM template bundle/);
  });

  it('refuses to pull into a folder that has files', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    await pushBundle({ dir: bundleDir, ref });
    await expect(pullBundle({ ref, destDir: bundleDir })).rejects.toThrow(
      /is not empty/,
    );
  });

  it('pulls once per digest into the cache', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    const pushed = await pushBundle({ dir: bundleDir, ref });
    const cacheDir = path.join(tmp, 'cache');
    const hex = pushed.digest.replace('sha256:', '');

    const first = await pullBundleCached({ ref, cacheDir });
    expect(first).toEqual({
      digest: pushed.digest,
      dir: path.join(cacheDir, hex),
      cached: false,
    });
    expect((await fs.readdir(cacheDir)).sort()).toEqual([hex, `${hex}.json`]);
    expect(await readAll(first.dir)).toEqual(await readAll(bundleDir));

    const blobReads = () =>
      registry.requests.filter(r => /^GET .*\/blobs\//.test(r)).length;
    const before = blobReads();
    const second = await pullBundleCached({ ref, cacheDir });
    expect(second).toEqual({ ...first, cached: true });
    expect(blobReads()).toBe(before);

    // Without its marker the folder counts as incomplete and is pulled again.
    await fs.rm(path.join(cacheDir, `${hex}.json`));
    await fs.rm(path.join(first.dir, 'index.json'));
    const third = await pullBundleCached({ ref, cacheDir });
    expect(third.cached).toBe(false);
    expect(await readAll(third.dir)).toEqual(await readAll(bundleDir));
  });

  it('shares one pull between runs that ask for the same digest at once', async () => {
    const ref = `${host}/calm-bundles/web-service:2.0.0`;
    await pushBundle({ dir: bundleDir, ref });
    const cacheDir = path.join(tmp, 'cache');
    const layerReads = () =>
      registry.requests.filter(r => /^GET .*\/blobs\//.test(r)).length;
    const before = layerReads();

    const results = await Promise.all(
      [1, 2, 3].map(() => pullBundleCached({ ref, cacheDir })),
    );

    expect(new Set(results.map(r => r.dir)).size).toBe(1);
    expect(results.filter(r => !r.cached)).toHaveLength(1);
    expect(layerReads() - before).toBe(1);
    expect(await readAll(results[0].dir)).toEqual(await readAll(bundleDir));
  });

  it('reports a registry that is not there as an OciError', async () => {
    await registry.stop();
    await expect(listRepositories(`http://${host}`)).rejects.toBeInstanceOf(
      OciError,
    );
    await registry.start();
  });
});

describe('extractBundle', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-oci-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('refuses a tar entry with ../ and writes nothing', async () => {
    const src = path.join(tmp, 'src', 'inner');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(tmp, 'src', 'evil.txt'), 'evil');
    await fs.writeFile(path.join(src, 'ok.txt'), 'ok');
    const file = path.join(tmp, 'evil.tar.gz');
    await tar.create({ file, cwd: src, gzip: true, preservePaths: true }, [
      'ok.txt',
      '../evil.txt',
    ]);

    const dest = path.join(tmp, 'dest', 'bundle');
    await expect(extractBundle(await fs.readFile(file), dest)).rejects.toThrow(
      /Refusing to extract.*\.\.\/evil\.txt/,
    );
    expect(await listFiles(path.join(tmp, 'dest'))).toEqual([]);
  });

  it('refuses an absolute path', async () => {
    const src = path.join(tmp, 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'abs.txt'), 'abs');
    const file = path.join(tmp, 'abs.tar.gz');
    await tar.create({ file, gzip: true, preservePaths: true }, [
      path.join(src, 'abs.txt'),
    ]);
    await expect(
      extractBundle(await fs.readFile(file), path.join(tmp, 'dest')),
    ).rejects.toThrow(/Refusing to extract/);
  });

  it('refuses links', async () => {
    const src = path.join(tmp, 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'ok.txt'), 'ok');
    await fs.symlink('/etc/hosts', path.join(src, 'link'));
    const file = path.join(tmp, 'link.tar.gz');
    await tar.create({ file, cwd: src, gzip: true }, ['ok.txt', 'link']);
    await expect(
      extractBundle(await fs.readFile(file), path.join(tmp, 'dest')),
    ).rejects.toThrow(/Refusing to extract.*link \(SymbolicLink\)/);
    expect(await listFiles(path.join(tmp, 'dest'))).toEqual([]);
  });
});
