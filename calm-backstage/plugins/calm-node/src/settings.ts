import path from 'node:path';
import type { RootConfigService } from '@backstage/backend-plugin-api';

/** `calm.bundleRegistry`: the OCI registry that holds the template bundles, as `<repositoryPrefix>/<name>:<version>`. */
export interface BundleRegistrySettings {
  url: string;
  repositoryPrefix: string;
}

export const DEFAULT_REPOSITORY_PREFIX = 'calm-bundles';

/**
 * Reads `calm.bundleRegistry`, undefined when it is not set. The catalog provider and calm:template both read it
 * here, so they list and pull bundles under the same prefix.
 */
export function readBundleRegistrySettings(
  config: Pick<RootConfigService, 'getOptionalConfig'>,
): BundleRegistrySettings | undefined {
  const registry = config.getOptionalConfig('calm.bundleRegistry');
  return registry
    ? {
        url: registry.getString('url'),
        repositoryPrefix:
          registry.getOptionalString('repositoryPrefix') ??
          DEFAULT_REPOSITORY_PREFIX,
      }
    : undefined;
}

/**
 * `calm.publish.localDir` as an absolute path: the folder calm:publish:local writes services to and the backend reads
 * them from. Relative to the backend's working directory (packages/backend), like the other `calm` paths.
 */
export function readPublishLocalDir(
  config: Pick<RootConfigService, 'getOptionalString'>,
): string {
  return path.resolve(
    config.getOptionalString('calm.publish.localDir') ?? '../../output',
  );
}
