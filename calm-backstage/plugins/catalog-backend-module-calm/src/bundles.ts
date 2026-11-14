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

/** A tag the registry lists. */
export interface BundleTag {
  name: string;
  version: string;
}

/** One listed tag and what reading it gave, in the registry's order. */
type TagRead = BundleTag & { ref: string } & (
    | { bundle: BundleInfo }
    | { error: unknown }
  );

const tagKey = (t: BundleTag) => `${t.name}@${t.version}`;

/** Lists the registry and reads every tag at once; throws when the registry cannot be listed. */
async function readTags(
  registry: BundleRegistrySettings,
  client: BundleRegistryClient,
): Promise<TagRead[]> {
  const prefix = registry.repositoryPrefix.replace(/^\/+|\/+$/g, '');
  const repositories = await client.listRepositories(registry.url, prefix);
  const read = await Promise.all(
    repositories.map(async repository => {
      const name = prefix ? repository.slice(prefix.length + 1) : repository;
      const versions = await client.listTags(registry.url, repository);
      return Promise.all(
        versions.map(async (version): Promise<TagRead> => {
          const ref = bundleRef(registry.url, prefix, name, version);
          try {
            return {
              name,
              version,
              ref,
              bundle: await readOne(client, ref, name, version),
            };
          } catch (error) {
            return { name, version, ref, error };
          }
        }),
      );
    }),
  );
  return read.flat();
}

/**
 * Every bundle in the registry: one per tag of each repository under the prefix. The name is the repository below
 * the prefix and the version is the tag; description and pattern come from the artifact's config (the bundle's
 * calm-backstage.json).
 *
 * A registry that cannot be listed throws (the caller turns that into one warning). A single tag that cannot be
 * read is left out, named in `warnings` and listed in `unread`.
 */
export async function readRegistryBundles(
  registry: BundleRegistrySettings,
  client: BundleRegistryClient = defaultClient,
): Promise<{ bundles: BundleInfo[]; warnings: string[]; unread: BundleTag[] }> {
  return collect(await readTags(registry, client), new Map());
}

/**
 * The bundles that were read, in the registry's order. A tag that could not be read takes its entry in `previous`
 * when there is one (the copy of an earlier read, with a warning saying so) and is otherwise left out.
 */
function collect(
  tags: TagRead[],
  previous: Map<string, BundleInfo>,
): { bundles: BundleInfo[]; warnings: string[]; unread: BundleTag[] } {
  const bundles: BundleInfo[] = [];
  const warnings: string[] = [];
  const unread: BundleTag[] = [];
  for (const tag of tags) {
    if ('bundle' in tag) {
      bundles.push(tag.bundle);
      continue;
    }
    unread.push({ name: tag.name, version: tag.version });
    const kept = previous.get(tagKey(tag));
    if (kept) {
      bundles.push(kept);
      warnings.push(
        `bundle ${tag.ref} not read, keeping the copy from an earlier read: ${tag.error}`,
      );
    } else {
      warnings.push(`bundle ${tag.ref} skipped: ${tag.error}`);
    }
  }
  return { bundles, warnings, unread };
}

/**
 * Reads the registry on each call and keeps the bundles of the last read that worked. When the registry cannot be
 * listed it gives those instead, with `failed` set, so a registry restart does not empty the catalog's bundles. When
 * it can be listed but a tag cannot be read, that tag keeps its bundle from the last read (with a warning); a tag
 * the registry no longer lists is dropped.
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
    let tags: TagRead[];
    try {
      tags = await readTags(registry, client);
    } catch (e) {
      return { bundles: last, warnings: [], failed: e };
    }
    const { bundles, warnings } = collect(
      tags,
      new Map(last.map(b => [tagKey(b), b])),
    );
    last = bundles;
    return { bundles, warnings };
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
