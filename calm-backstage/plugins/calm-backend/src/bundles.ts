/*
 * The Template Explorer's reads: the bundles in the registry grouped by name, the files inside one, one file's text,
 * and what changed between two versions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import {
  BundleKind,
  BundlePatternRef,
  compareVersions,
} from '@internal/backstage-plugin-calm-common';
import type { RegistryBundle } from '@internal/backstage-plugin-calm-node';

export interface ExplorerBundleVersion {
  version: string;
  ref: string;
  digest: string;
  size?: number;
  created?: string;
  /** Web URL of the bundle's folder in the Git server at the commit it was published from. */
  source?: string;
  revision?: string;
  description?: string;
  runtime?: string;
  patterns: BundlePatternRef[];
}

export interface ExplorerBundle {
  name: string;
  kind: BundleKind;
  /** Newest first. */
  versions: ExplorerBundleVersion[];
}

const SOURCE = 'org.opencontainers.image.source';
const REVISION = 'org.opencontainers.image.revision';
const CREATED = 'org.opencontainers.image.created';
const KIND_ORDER: BundleKind[] = ['starter', 'deployment', 'full'];
const isHttp = (u?: string) => (u && /^https?:\/\//.test(u) ? u : undefined);

/** Registry bundles grouped by name: starters first, then deployment rules, then full bundles; versions newest first. */
export function groupBundles(bundles: RegistryBundle[]): ExplorerBundle[] {
  const byName = new Map<string, RegistryBundle[]>();
  for (const b of bundles) {
    byName.set(b.name, [...(byName.get(b.name) ?? []), b]);
  }
  return [...byName.entries()]
    .map(([name, list]) => {
      const versions = [...list].sort((a, b) =>
        compareVersions(b.version, a.version),
      );
      return {
        name,
        kind: versions[0].kind,
        versions: versions.map(v => ({
          version: v.version,
          ref: v.ref,
          digest: v.digest,
          patterns: v.patterns,
          ...(v.size !== undefined ? { size: v.size } : {}),
          ...(v.annotations[CREATED]
            ? { created: v.annotations[CREATED] }
            : {}),
          ...(isHttp(v.annotations[SOURCE])
            ? { source: v.annotations[SOURCE] }
            : {}),
          ...(v.annotations[REVISION]
            ? { revision: v.annotations[REVISION] }
            : {}),
          ...(v.description ? { description: v.description } : {}),
          ...(v.runtime ? { runtime: v.runtime } : {}),
        })),
      };
    })
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.name.localeCompare(b.name),
    );
}

/** Every regular file in a pulled bundle, with its size, sorted. */
export async function bundleFiles(
  dir: string,
): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        out.push({
          path: path.relative(dir, p).split(path.sep).join('/'),
          size: (await fs.stat(p)).size,
        });
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The text of one file of a pulled bundle; undefined unless `file` is one of the bundle's own files. */
export async function bundleFile(
  dir: string,
  file: string,
): Promise<string | undefined> {
  const listed = (await bundleFiles(dir)).map(f => f.path);
  if (!listed.includes(file)) {
    return undefined;
  }
  return fs.readFile(path.join(dir, file), 'utf-8');
}

export interface BundleFileDiff {
  path: string;
  status: 'added' | 'removed' | 'changed';
  /** Unified diff (changed files, and the whole file for added and removed ones). */
  patch: string;
}

/** What changed from the bundle in `fromDir` (version `from`) to the one in `toDir` (version `to`), file by file. */
export async function bundleDiff(
  fromDir: string,
  toDir: string,
  from: string,
  to: string,
): Promise<BundleFileDiff[]> {
  const a = new Map((await bundleFiles(fromDir)).map(f => [f.path, f]));
  const b = new Map((await bundleFiles(toDir)).map(f => [f.path, f]));
  const read = (d: string, f: string) => fs.readFile(path.join(d, f), 'utf-8');
  const out: BundleFileDiff[] = [];
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.has(p) ? await read(fromDir, p) : '';
    const after = b.has(p) ? await read(toDir, p) : '';
    if (a.has(p) && b.has(p) && before === after) {
      continue;
    }
    out.push({
      path: p,
      status: !a.has(p) ? 'added' : !b.has(p) ? 'removed' : 'changed',
      patch: createTwoFilesPatch(
        `${from}/${p}`,
        `${to}/${p}`,
        before,
        after,
        '',
        '',
        { context: 3 },
      ),
    });
  }
  return out;
}
