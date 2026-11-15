/*
 * Template bundles from the OCI bundle registry, and how they combine with the local folders in `calm.bundles`.
 */
import { readBundleMeta } from '@internal/backstage-plugin-calm-common';
import {
  type BundleRegistrySettings,
  bundleRef,
  listRepositories,
  listTags,
  readBundleConfig,
} from '@internal/backstage-plugin-calm-node';
import type { BundleInfo } from './entities';

/** The registry reads `readRegistryBundles` needs; the default is the client in calm-node. */
export interface BundleRegistryClient {
  listRepositories(registryUrl: string, prefix?: string): Promise<string[]>;
  listTags(registryUrl: string, repository: string): Promise<string[]>;
  readBundleConfig(ref: string): Promise<{ digest: string; config: any }>;
}

const defaultClient: BundleRegistryClient = {
  listRepositories,
  listTags,
  readBundleConfig,
};

/**
 * Every bundle in the registry: one per tag of each repository under the prefix. The name is the repository below
 * the prefix and the version is the tag; description and pattern come from the artifact's config (the bundle's
 * calm-backstage.json).
 *
 * A registry that cannot be listed throws (the caller turns that into one warning). A single tag that cannot be
 * read is left out and named in `warnings`.
 */
export async function readRegistryBundles(
  registry: BundleRegistrySettings,
  client: BundleRegistryClient = defaultClient,
): Promise<{ bundles: BundleInfo[]; warnings: string[] }> {
  const warnings: string[] = [];
  const prefix = registry.repositoryPrefix.replace(/^\/+|\/+$/g, '');
  const repositories = await client.listRepositories(registry.url, prefix);
  // Every tag is read at once; the list keeps the registry's order.
  const read = await Promise.all(
    repositories.map(async repository => {
      const name = prefix ? repository.slice(prefix.length + 1) : repository;
      const versions = await client.listTags(registry.url, repository);
      return Promise.all(
        versions.map(version => {
          const ref = bundleRef(registry.url, prefix, name, version);
          return readOne(client, ref, name, version).catch(e => {
            warnings.push(`bundle ${ref} skipped: ${e}`);
            return undefined;
          });
        }),
      );
    }),
  );
  const bundles = read.flat().filter((b): b is BundleInfo => b !== undefined);
  return { bundles, warnings };
}

/**
 * Reads the registry on each call and keeps the bundles of the last read that worked. When the registry cannot be
 * listed it gives those instead, with `failed` set, so a registry restart does not empty the catalog's bundles.
 */
export function lastGoodRegistryReader(
  registry: BundleRegistrySettings,
  client: BundleRegistryClient = defaultClient,
) {
  let last: BundleInfo[] = [];
  return async (): Promise<{
    bundles: BundleInfo[];
    warnings: string[];
    failed?: unknown;
  }> => {
    try {
      const read = await readRegistryBundles(registry, client);
      last = read.bundles;
      return read;
    } catch (e) {
      return { bundles: last, warnings: [], failed: e };
    }
  };
}

async function readOne(
  client: BundleRegistryClient,
  ref: string,
  name: string,
  version: string,
): Promise<BundleInfo> {
  const { digest, config } = await client.readBundleConfig(ref);
  const meta = readBundleMeta(config, { name, version });
  return {
    name,
    version,
    ref,
    digest,
    description: meta.description,
    deploy: meta.deploy,
    kind: meta.kind,
    runtime: meta.runtime,
    patterns: meta.patterns,
  };
}

/**
 * Local and registry bundles as one list. A local folder in `calm.bundles` takes the place of a registry bundle with
 * the same name and version, as it does in calm:template, so the catalog shows the bundle that a run renders;
 * `replaced` names those (`<name>@<version>`).
 */
export function mergeBundles(
  local: BundleInfo[],
  registry: BundleInfo[],
): { bundles: BundleInfo[]; replaced: string[] } {
  const key = (b: BundleInfo) => `${b.name}@${b.version}`;
  const inLocal = new Set(local.map(key));
  const replaced = registry.map(key).filter(k => inLocal.has(k));
  return {
    bundles: [...local, ...registry.filter(b => !inLocal.has(key(b)))],
    replaced,
  };
}
