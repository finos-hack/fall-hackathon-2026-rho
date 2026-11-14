/*
 * A small OCI registry client for template bundles, over the registry HTTP API v2 (the OCI distribution spec) with
 * the global `fetch`. No auth: the hackathon registry (`registry:2` in hub/docker-compose.yml) has none.
 *
 * A bundle is one OCI artifact:
 *   - config: the bundle's `calm-backstage.json`, byte for byte;
 *   - one layer: the bundle folder as a gzipped tar, built the same way every time (sorted files, fixed mtime, no
 *     owner), so the same folder content gives the same digests;
 *   - manifest: an OCI image manifest with `artifactType`, which `oras` and other standard clients read.
 *
 * This file imports only Node built-ins and `tar`, and uses only type syntax Node can strip, so
 * `hub/push-bundles.cjs` can `require` it without a build.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

export const OCI_MANIFEST_MEDIA_TYPE =
  'application/vnd.oci.image.manifest.v1+json';
export const OCI_LAYER_MEDIA_TYPE =
  'application/vnd.oci.image.layer.v1.tar+gzip';
export const BUNDLE_ARTIFACT_TYPE =
  'application/vnd.finos.calm.template-bundle.v1';
export const BUNDLE_CONFIG_MEDIA_TYPE =
  'application/vnd.finos.calm.template-bundle.config.v1+json';
/** The layer's file name for clients that write layers to disk (`oras pull`). */
export const BUNDLE_LAYER_TITLE = 'bundle.tar.gz';
/** The bundle's metadata file; it becomes the artifact's config blob. */
export const BUNDLE_CONFIG_FILE = 'calm-backstage.json';

/** Every tar entry gets this mtime, so the layer does not change when files are only touched or copied. */
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');
/** Finder's folder metadata: never part of a bundle. */
const IGNORED_FILES = new Set(['.DS_Store']);

export class OciError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = 'OciError';
    this.status = status;
    this.url = url;
  }
}

export interface OciRef {
  /** Registry host, with its port if it has one, e.g. `localhost:5050`. */
  registry: string;
  /** Repository, e.g. `calm-bundles/web-service`. */
  repository: string;
  /** Tag, e.g. `2.0.0`. */
  tag: string;
  /** Base URL of the registry, e.g. `http://localhost:5050`. */
  baseUrl: string;
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  annotations?: Record<string, string>;
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  artifactType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
  annotations?: Record<string, string>;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const REPOSITORY =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Splits `[http(s)://]<host[:port]>/<repository>[:<tag>]`, e.g. `localhost:5050/calm-bundles/web-service:2.0.0`.
 * The scheme is http for `localhost`, `127.0.0.1` and an explicit `http://`, https otherwise. No tag means `latest`.
 */
export function parseRef(ref: string): OciRef {
  const m = /^(?:(https?):\/\/)?([^/]+)\/(.+)$/.exec(ref.trim());
  if (!m) {
    throw new Error(
      `Not an OCI reference (<registry>/<repository>:<tag>): ${JSON.stringify(
        ref,
      )}`,
    );
  }
  const [, explicit, registry, rest] = m;
  // The tag's colon is the one after the last slash: the registry's port colon is before the first.
  const colon = rest.indexOf(':', rest.lastIndexOf('/') + 1);
  const repository = colon < 0 ? rest : rest.slice(0, colon);
  const tag = colon < 0 ? 'latest' : rest.slice(colon + 1);
  if (!REPOSITORY.test(repository) || !TAG.test(tag)) {
    throw new Error(
      `Not an OCI reference (<registry>/<repository>:<tag>): ${JSON.stringify(
        ref,
      )}`,
    );
  }
  const scheme = explicit ?? (LOCAL_HOST.test(registry) ? 'http' : 'https');
  return { registry, repository, tag, baseUrl: `${scheme}://${registry}` };
}

/**
 * The reference of a bundle in a registry: `bundleRef('http://localhost:5050', 'calm-bundles', 'web-service', '2.0.0')`
 * is `localhost:5050/calm-bundles/web-service:2.0.0`. The scheme stays in the reference only when `parseRef` would not
 * pick it by itself (plain http on a host that is not local).
 */
export function bundleRef(
  registryUrl: string,
  repositoryPrefix: string,
  name: string,
  version: string,
): string {
  const m = /^(?:(https?):\/\/)?([^/]+)\/*$/.exec(registryUrl.trim());
  if (!m) {
    throw new Error(`Not a registry URL: ${JSON.stringify(registryUrl)}`);
  }
  const [, scheme, host] = m;
  const prefix = repositoryPrefix.replace(/^\/+|\/+$/g, '');
  const keepScheme = scheme === 'http' && !LOCAL_HOST.test(host);
  return `${keepScheme ? 'http://' : ''}${host}/${
    prefix ? `${prefix}/` : ''
  }${name}:${version}`;
}

/** `sha256:<hex>` of some bytes: an OCI digest. */
export function sha256Digest(data: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function baseUrlOf(registryUrl: string): string {
  const url = registryUrl.trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${LOCAL_HOST.test(url) ? 'http' : 'https'}://${url}`;
}

async function request(
  method: string,
  url: string,
  init: { headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: init.headers,
      body: init.body,
      redirect: 'follow',
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new OciError(
      0,
      url,
      `${method} ${url} failed: ${cause?.code ?? cause?.message ?? e}`,
    );
  }
}

/** A request that must succeed; a status outside `ok` throws an OciError carrying the start of the body. */
async function expect(
  method: string,
  url: string,
  init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ok: number[] = [200],
): Promise<Response> {
  const res = await request(method, url, init);
  if (!ok.includes(res.status)) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // no body
    }
    throw new OciError(
      res.status,
      url,
      `${method} ${url} -> ${res.status}${body ? `: ${body}` : ''}`,
    );
  }
  return res;
}

async function readBlob(
  ref: OciRef,
  descriptor: OciDescriptor,
): Promise<Buffer> {
  if (!DIGEST.test(descriptor.digest)) {
    throw new Error(
      `Unsupported digest ${JSON.stringify(descriptor.digest)} in ${
        ref.repository
      }:${ref.tag}`,
    );
  }
  const url = `${ref.baseUrl}/v2/${ref.repository}/blobs/${descriptor.digest}`;
  const res = await expect('GET', url);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = sha256Digest(data);
  if (actual !== descriptor.digest) {
    throw new Error(
      `Digest mismatch for ${url}: the manifest says ${descriptor.digest}, the content is ${actual}`,
    );
  }
  return data;
}

/** Uploads a blob in one piece (POST an upload session, then PUT the bytes) unless the registry already has it. */
async function pushBlob(ref: OciRef, data: Buffer): Promise<OciDescriptor> {
  const digest = sha256Digest(data);
  const blobs = `${ref.baseUrl}/v2/${ref.repository}/blobs`;
  const head = await request('HEAD', `${blobs}/${digest}`);
  if (head.status !== 200) {
    const session = await expect('POST', `${blobs}/uploads/`, {}, [202]);
    const location = session.headers.get('location');
    if (!location) {
      throw new OciError(
        session.status,
        `${blobs}/uploads/`,
        `POST ${blobs}/uploads/ gave no Location header`,
      );
    }
    // The Location may be relative and usually has a query string of its own.
    const put = new URL(location, `${blobs}/uploads/`);
    put.searchParams.set('digest', digest);
    await expect(
      'PUT',
      put.toString(),
      {
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
      },
      [201],
    );
  }
  return { mediaType: '', digest, size: data.length };
}

async function readManifest(
  ref: OciRef,
): Promise<{ digest: string; manifest: OciManifest }> {
  const url = `${ref.baseUrl}/v2/${ref.repository}/manifests/${ref.tag}`;
  const res = await expect('GET', url, {
    headers: { Accept: OCI_MANIFEST_MEDIA_TYPE },
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const digest = sha256Digest(raw);
  const header = res.headers.get('docker-content-digest');
  if (header && header !== digest) {
    throw new Error(
      `Digest mismatch for ${url}: the registry says ${header}, the content is ${digest}`,
    );
  }
  let manifest: OciManifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error(`${url} is not JSON: ${e}`);
  }
  if (
    manifest?.artifactType !== BUNDLE_ARTIFACT_TYPE ||
    typeof manifest.config?.digest !== 'string' ||
    !Array.isArray(manifest.layers)
  ) {
    throw new Error(
      `${ref.registry}/${ref.repository}:${ref.tag} is not a CALM template bundle (artifactType ${BUNDLE_ARTIFACT_TYPE})`,
    );
  }
  return { digest, manifest };
}

/** Every regular file under `dir`, as sorted paths relative to it (forward slashes). */
async function bundleFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile() && !IGNORED_FILES.has(ent.name)) {
        out.push(path.relative(dir, p).split(path.sep).join('/'));
      }
    }
  };
  await walk(dir);
  return out.sort();
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-oci-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * The bundle folder as a gzipped tar. Deterministic: files in sorted order, one fixed mtime, no owner or group
 * (`portable`), so two folders with the same files and content give the same bytes.
 */
export async function packBundle(dir: string): Promise<Buffer> {
  const files = await bundleFiles(dir);
  if (!files.length) {
    throw new Error(`No files in ${dir}`);
  }
  return withTempDir(async tmp => {
    const file = path.join(tmp, BUNDLE_LAYER_TITLE);
    await tar.create(
      { file, cwd: dir, gzip: true, portable: true, mtime: FIXED_MTIME },
      files,
    );
    return fs.readFile(file);
  });
}

/**
 * Extracts a bundle layer into `destDir` (created if absent). The layer is listed first and refused as a whole when
 * any entry would leave `destDir` (an absolute path, a `..` segment) or is not a plain file or folder (links,
 * devices), so nothing is written from a layer that is not safe.
 */
export async function extractBundle(
  layer: Uint8Array,
  destDir: string,
): Promise<void> {
  await withTempDir(async tmp => {
    const file = path.join(tmp, BUNDLE_LAYER_TITLE);
    await fs.writeFile(file, layer);
    const refused: string[] = [];
    await tar.list({
      file,
      onReadEntry: entry => {
        const p = String(entry.path);
        const segments = p.split(/[\\/]/);
        if (entry.type !== 'File' && entry.type !== 'Directory') {
          refused.push(`${p} (${entry.type})`);
        } else if (
          path.posix.isAbsolute(p) ||
          path.win32.isAbsolute(p) ||
          segments.includes('..')
        ) {
          refused.push(p);
        }
      },
    });
    if (refused.length) {
      throw new Error(
        `Refusing to extract the bundle: entries outside the target folder, or not plain files: ${refused.join(
          ', ',
        )}`,
      );
    }
    await fs.mkdir(destDir, { recursive: true });
    await tar.extract({ file, cwd: destDir, strict: true });
  });
}

/**
 * Pushes a bundle folder to `ref` as an OCI artifact and returns the manifest digest. Blobs the registry already
 * has are not uploaded again; pushing the same folder again gives the same digest.
 */
export async function pushBundle(opts: {
  dir: string;
  ref: string;
  /** More manifest annotations, e.g. `org.opencontainers.image.source` and `.revision`. */
  annotations?: Record<string, string>;
  /**
   * A published version never changes: when the tag exists, the same content (layer) is skipped without touching
   * the manifest, and different content is refused.
   */
  immutable?: boolean;
}): Promise<{ ref: string; digest: string; skipped?: boolean }> {
  const ref = parseRef(opts.ref);
  const configBytes = await fs.readFile(
    path.join(opts.dir, BUNDLE_CONFIG_FILE),
  );
  let config: { version?: unknown; description?: unknown };
  try {
    config = JSON.parse(configBytes.toString('utf8'));
  } catch (e) {
    throw new Error(
      `${path.join(opts.dir, BUNDLE_CONFIG_FILE)} is not JSON: ${e}`,
    );
  }
  const layerBytes = await packBundle(opts.dir);

  if (opts.immutable) {
    const existing = await readManifest(ref).catch(e => {
      if (e instanceof OciError && e.status === 404) {
        return undefined;
      }
      throw e;
    });
    if (existing) {
      const layer = existing.manifest.layers.find(
        l => l.mediaType === OCI_LAYER_MEDIA_TYPE,
      );
      const shown = `${ref.registry}/${ref.repository}:${ref.tag}`;
      if (layer?.digest === sha256Digest(layerBytes)) {
        return { ref: shown, digest: existing.digest, skipped: true };
      }
      throw new Error(
        `bundle ${shown} already published with different content; publish a new version`,
      );
    }
  }

  const configBlob = await pushBlob(ref, configBytes);
  const layerBlob = await pushBlob(ref, layerBytes);

  const annotations: Record<string, string> = {};
  if (typeof config.version === 'string') {
    annotations['org.opencontainers.image.version'] = config.version;
  }
  if (typeof config.description === 'string') {
    annotations['org.opencontainers.image.description'] = config.description;
  }
  Object.assign(annotations, opts.annotations ?? {});
  const manifest: OciManifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: BUNDLE_ARTIFACT_TYPE,
    config: { ...configBlob, mediaType: BUNDLE_CONFIG_MEDIA_TYPE },
    layers: [
      {
        ...layerBlob,
        mediaType: OCI_LAYER_MEDIA_TYPE,
        annotations: { 'org.opencontainers.image.title': BUNDLE_LAYER_TITLE },
      },
    ],
    annotations,
  };
  // The digest is of these exact bytes.
  const body = Buffer.from(JSON.stringify(manifest), 'utf8');
  const digest = sha256Digest(body);
  const url = `${ref.baseUrl}/v2/${ref.repository}/manifests/${ref.tag}`;
  const res = await expect(
    'PUT',
    url,
    { headers: { 'Content-Type': OCI_MANIFEST_MEDIA_TYPE }, body },
    [201],
  );
  const header = res.headers.get('docker-content-digest');
  if (header && header !== digest) {
    throw new Error(
      `Digest mismatch for ${url}: sent ${digest}, the registry stored ${header}`,
    );
  }
  return { ref: `${ref.registry}/${ref.repository}:${ref.tag}`, digest };
}

/**
 * Repositories in the registry (`/v2/_catalog`), sorted. With a prefix, only those under `<prefix>/`. The catalog
 * also lists repositories that have no tags left.
 */
export async function listRepositories(
  registryUrl: string,
  prefix?: string,
): Promise<string[]> {
  const base = baseUrlOf(registryUrl);
  const out: string[] = [];
  let url: string | undefined = `${base}/v2/_catalog?n=1000`;
  while (url) {
    const res: Response = await expect('GET', url);
    const data = (await res.json()) as { repositories?: unknown };
    if (Array.isArray(data?.repositories)) {
      out.push(...data.repositories.filter(r => typeof r === 'string'));
    }
    // A longer list continues at the Link header: </v2/_catalog?last=…&n=…>; rel="next"
    const next = /<([^>]+)>\s*;\s*rel="?next"?/.exec(
      res.headers.get('link') ?? '',
    );
    url = next ? new URL(next[1], url).toString() : undefined;
  }
  const lead = prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/` : '';
  return [...new Set(out)].filter(r => r.startsWith(lead)).sort();
}

/** Tags of a repository (`/v2/<repository>/tags/list`). A repository without tags, or an unknown one, gives none. */
export async function listTags(
  registryUrl: string,
  repository: string,
): Promise<string[]> {
  const url = `${baseUrlOf(registryUrl)}/v2/${repository}/tags/list`;
  const res = await expect('GET', url, {}, [200, 404]);
  if (res.status === 404) {
    return [];
  }
  const data = (await res.json()) as { tags?: unknown };
  return Array.isArray(data?.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string')
    : [];
}

/**
 * The manifest digest and the config (the bundle's `calm-backstage.json`) of a bundle in the registry. The config
 * blob is checked against the digest in the manifest.
 */
export async function readBundleConfig(
  ref: string,
): Promise<{
  digest: string;
  config: any;
  annotations: Record<string, string>;
  /** Size of the bundle layer in bytes. */
  size?: number;
}> {
  const parsed = parseRef(ref);
  const { digest, manifest } = await readManifest(parsed);
  const blob = await readBlob(parsed, manifest.config);
  const layer = manifest.layers.find(l => l.mediaType === OCI_LAYER_MEDIA_TYPE);
  try {
    return {
      digest,
      config: JSON.parse(blob.toString('utf8')),
      annotations: manifest.annotations ?? {},
      ...(layer ? { size: layer.size } : {}),
    };
  } catch (e) {
    throw new Error(`The config of ${ref} is not JSON: ${e}`);
  }
}

/**
 * Whether a bundle folder can be published to `ref`: `new` (the tag is not there), `same` (the registry has this
 * content) or `changed` (the registry has other content under this version, which must not change).
 */
export async function checkBundle(opts: {
  dir: string;
  ref: string;
}): Promise<'new' | 'same' | 'changed'> {
  const existing = await readManifest(parseRef(opts.ref)).catch(e => {
    if (e instanceof OciError && e.status === 404) {
      return undefined;
    }
    throw e;
  });
  if (!existing) {
    return 'new';
  }
  const layer = existing.manifest.layers.find(
    l => l.mediaType === OCI_LAYER_MEDIA_TYPE,
  );
  return layer?.digest === sha256Digest(await packBundle(opts.dir))
    ? 'same'
    : 'changed';
}

/** The manifest of a bundle in the registry (annotations, layers) and its digest. */
export async function readBundleManifest(
  ref: string,
): Promise<{ digest: string; manifest: OciManifest }> {
  return readManifest(parseRef(ref));
}

/** The manifest digest of a bundle in the registry, without reading its blobs. */
export async function resolveBundleDigest(ref: string): Promise<string> {
  return (await readManifest(parseRef(ref))).digest;
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Pulls a bundle into `destDir` and returns the manifest digest. The layer's sha256 is checked before anything is
 * extracted, and unsafe entries are refused (see `extractBundle`). The files are extracted beside `destDir` and
 * moved into place at the end, so a failed pull leaves no half-written folder. `destDir` must be absent or empty.
 */
export async function pullBundle(opts: {
  ref: string;
  destDir: string;
}): Promise<{ digest: string; dir: string }> {
  const ref = parseRef(opts.ref);
  const dir = path.resolve(opts.destDir);
  const { digest, manifest } = await readManifest(ref);
  const layers = manifest.layers.filter(
    l => l.mediaType === OCI_LAYER_MEDIA_TYPE,
  );
  if (layers.length !== 1) {
    throw new Error(
      `${opts.ref} has ${layers.length} ${OCI_LAYER_MEDIA_TYPE} layers, expected one`,
    );
  }
  const layer = await readBlob(ref, layers[0]);

  if (await exists(dir)) {
    if ((await fs.readdir(dir)).length) {
      throw new Error(`${dir} is not empty`);
    }
    await fs.rmdir(dir);
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const staging = `${dir}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await extractBundle(layer, staging);
    await fs.rename(staging, dir);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return { digest, dir };
}

/** Cache folders being filled in this process, so two runs pulling the same digest share one pull. */
const cacheFills = new Map<string, Promise<void>>();

/**
 * Pulls a bundle into `<cacheDir>/<manifest digest without sha256:>/`, once per digest. A marker file
 * `<digest>.json` beside the folder is written last; when it is there, the folder is complete and is used as it is.
 * A folder without its marker (a pull that was cut short) is removed and pulled again. Runs that ask for the same
 * digest while it is being pulled wait for that pull instead of starting their own, which would remove the folder
 * the first run is about to use.
 */
export async function pullBundleCached(opts: {
  ref: string;
  cacheDir: string;
}): Promise<{ digest: string; dir: string; cached: boolean }> {
  const digest = await resolveBundleDigest(opts.ref);
  const hex = digest.replace(/^sha256:/, '');
  const dir = path.join(path.resolve(opts.cacheDir), hex);
  const marker = `${dir}.json`;
  const running = cacheFills.get(dir);
  if (running) {
    await running;
    return { digest, dir, cached: true };
  }
  if ((await exists(marker)) && (await exists(dir))) {
    return { digest, dir, cached: true };
  }
  // Checked again: another run may have started the pull while this one was looking at the folder.
  const started = cacheFills.get(dir);
  if (started) {
    await started;
    return { digest, dir, cached: true };
  }
  const fill = fillCache(opts.ref, digest, dir, marker).finally(() =>
    cacheFills.delete(dir),
  );
  cacheFills.set(dir, fill);
  await fill;
  return { digest, dir, cached: false };
}

async function fillCache(
  ref: string,
  digest: string,
  dir: string,
  marker: string,
): Promise<void> {
  await fs.rm(marker, { force: true });
  await fs.rm(dir, { recursive: true, force: true });
  const pulled = await pullBundle({ ref, destDir: dir });
  if (pulled.digest !== digest) {
    // The tag moved between the two reads; the folder name would no longer match its content.
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error(
      `${ref} changed during the pull (${digest} -> ${pulled.digest}); try again`,
    );
  }
  await fs.writeFile(marker, `${JSON.stringify({ ref, digest }, null, 2)}\n`);
}
