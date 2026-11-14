/*
 * Template bundles from the OCI bundle registry, and how they combine with the local folders in `calm.bundles`.
 */
import {
  bundleRef,
  listRepositories,
  listTags,
  readBundleConfig,
} from '@internal/backstage-plugin-calm-node';
import type { BundleInfo } from './entities';

export interface BundleRegistrySettings {
  /** Base URL of the registry, e.g. `http://localhost:5050`. */
  url: string;
  /** Repository prefix of the bundles, e.g. `calm-bundles`. */
  repositoryPrefix: string;
}

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
  const bundles: BundleInfo[] = [];
  const warnings: string[] = [];
  const prefix = registry.repositoryPrefix.replace(/^\/+|\/+$/g, '');
  for (const repository of await client.listRepositories(
    registry.url,
    prefix,
  )) {
    const name = prefix ? repository.slice(prefix.length + 1) : repository;
    for (const version of await client.listTags(registry.url, repository)) {
      const ref = bundleRef(registry.url, prefix, name, version);
      try {
        const { digest, config } = await client.readBundleConfig(ref);
        bundles.push({
          name,
          version,
          ref,
          digest,
          description:
            typeof config?.description === 'string'
              ? config.description
              : undefined,
          pattern:
            config?.pattern && typeof config.pattern === 'object'
              ? config.pattern
              : undefined,
        });
      } catch (e) {
        warnings.push(`bundle ${ref} skipped: ${e}`);
      }
    }
  }
  return { bundles, warnings };
}

/**
 * Local and registry bundles as one list. A registry bundle takes the place of a local folder with the same name
 * and version; `replaced` names those (`<name>@<version>`).
 */
export function mergeBundles(
  local: BundleInfo[],
  registry: BundleInfo[],
): { bundles: BundleInfo[]; replaced: string[] } {
  const key = (b: BundleInfo) => `${b.name}@${b.version}`;
  const inRegistry = new Set(registry.map(key));
  const replaced = local.map(key).filter(k => inRegistry.has(k));
  return {
    bundles: [...local.filter(b => !inRegistry.has(key(b))), ...registry],
    replaced,
  };
}
