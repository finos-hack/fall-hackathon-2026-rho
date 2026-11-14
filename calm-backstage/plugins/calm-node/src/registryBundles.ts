/*
 * Every template bundle in the OCI bundle registry with what it says about itself, for the catalog, the upgrade
 * check, the upgrade action and the Template Explorer.
 */
import { BundleMeta, readBundleMeta } from '@internal/backstage-plugin-calm-common';
import { bundleRef, listRepositories, listTags, readBundleConfig } from './oci';
import type { BundleRegistrySettings } from './settings';

export interface RegistryBundle extends BundleMeta {
  ref: string;
  digest: string;
  /** Manifest annotations: org.opencontainers.image.source, .revision, .created, calm.finos.org/bundle-kind. */
  annotations: Record<string, string>;
  /** Size of the bundle layer in bytes. */
  size?: number;
}

/**
 * One entry per tag of each repository under the prefix: name from the repository, version from the tag, the rest
 * from the bundle's config and manifest. A tag that cannot be read is left out and named in `warnings`; a registry
 * that cannot be listed throws.
 */
export async function listRegistryBundles(
  registry: BundleRegistrySettings,
): Promise<{ bundles: RegistryBundle[]; warnings: string[] }> {
  const bundles: RegistryBundle[] = [];
  const warnings: string[] = [];
  const prefix = registry.repositoryPrefix.replace(/^\/+|\/+$/g, '');
  for (const repository of await listRepositories(registry.url, prefix)) {
    const name = prefix ? repository.slice(prefix.length + 1) : repository;
    for (const version of await listTags(registry.url, repository)) {
      const ref = bundleRef(registry.url, prefix, name, version);
      try {
        const { digest, config, annotations, size } = await readBundleConfig(
          ref,
        );
        bundles.push({
          ...readBundleMeta(config, { name, version }),
          name,
          version,
          ref,
          digest,
          annotations,
          ...(size !== undefined ? { size } : {}),
        });
      } catch (e) {
        warnings.push(`bundle ${ref} skipped: ${e}`);
      }
    }
  }
  return { bundles, warnings };
}
