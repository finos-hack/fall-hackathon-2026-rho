/*
 * Template bundles from the OCI bundle registry, and how they combine with the local folders in `calm.bundles`.
 */
import { readBundleMeta } from '@internal/backstage-plugin-calm-common';
import {
  type BundleRegistrySettings,
  bundleRef,
  headBundleDigest,
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
  /** The manifest digest under the tag, from a HEAD request; `undefined` when the registry answers 404. */
  headBundleDigest(ref: string): Promise<string | undefined>;
}

const defaultClient: BundleRegistryClient = {
  listRepositories,
  listTags,
  readBundleConfig,
  headBundleDigest,
};

/**
 * How many refreshes in a row `lastGoodRegistryReader` keeps an earlier copy of a bundle it can neither read nor
 * check with a HEAD on its manifest (the registry restarting, say). At the default 60 s refresh, about three minutes.
 */
export const MAX_UNCHECKED_REFRESHES = 3;

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

/** Lists the registry and reads every tag at once, each one tried twice; throws when the registry cannot be listed. */
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
          const tryRead = () => readOne(client, ref, name, version);
          try {
            return { name, version, ref, bundle: await tryRead() };
          } catch {
            try {
              return { name, version, ref, bundle: await tryRead() };
            } catch (error) {
              return { name, version, ref, error };
            }
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
 * read, on a second try either, is left out, named in `warnings` and listed in `unread`.
 */
export async function readRegistryBundles(
  registry: BundleRegistrySettings,
  client: BundleRegistryClient = defaultClient,
): Promise<{ bundles: BundleInfo[]; warnings: string[]; unread: BundleTag[] }> {
  const bundles: BundleInfo[] = [];
  const warnings: string[] = [];
  const unread: BundleTag[] = [];
  for (const tag of await readTags(registry, client)) {
    if ('bundle' in tag) {
      bundles.push(tag.bundle);
    } else {
      unread.push({ name: tag.name, version: tag.version });
      warnings.push(`bundle ${tag.ref} skipped: ${tag.error}`);
    }
  }
  return { bundles, warnings, unread };
}

/** A tag's bundle for this refresh, if any, with a warning when it was not read and how often it went unchecked. */
type Outcome = { bundle?: BundleInfo; warning?: string; unchecked?: number };

/** What becomes of a listed tag that could not be read but has a copy from an earlier read. */
async function keepOrDrop(
  client: BundleRegistryClient,
  tag: TagRead & { error: unknown },
  kept: BundleInfo,
  unchecked: number,
): Promise<Outcome> {
  const notRead = `bundle ${tag.ref} not read: ${tag.error}`;
  let digest: string | undefined;
  try {
    digest = await client.headBundleDigest(tag.ref);
  } catch (e) {
    const count = unchecked + 1;
    if (count > MAX_UNCHECKED_REFRESHES) {
      return {
        warning: `${notRead}; skipped, its manifest could not be checked for ${count} refreshes in a row: ${e}`,
      };
    }
    return {
      bundle: kept,
      warning: `${notRead}; keeping the copy from an earlier read, unchecked (${count} of ${MAX_UNCHECKED_REFRESHES}): ${e}`,
      unchecked: count,
    };
  }
  if (digest === undefined) {
    return {
      warning: `${notRead}; skipped, the registry has no manifest under the tag`,
    };
  }
  if (digest !== kept.digest) {
    return {
      warning: `${notRead}; skipped, the tag now has manifest ${digest}, the earlier copy is of ${kept.digest}`,
    };
  }
  return {
    bundle: kept,
    warning: `${notRead}; keeping the copy from an earlier read, the tag still has manifest ${digest}`,
  };
}

/**
 * Reads the registry on each call and keeps the bundles of the last read that worked. When the registry cannot be
 * listed it gives those instead, with `failed` set, so a registry restart does not empty the catalog's bundles.
 *
 * A tag the registry still lists but cannot read (on a second try either) keeps its bundle from the last read only
 * while a HEAD on its manifest gives the digest of that copy. A HEAD that gives another digest (the tag was pushed
 * over) or 404 (the manifest is gone) drops it. A HEAD that fails keeps it for up to `MAX_UNCHECKED_REFRESHES`
 * refreshes in a row, then drops it. Every kept or dropped copy comes with a warning. A tag the registry no longer
 * lists is dropped.
 */
export function lastGoodRegistryReader(
  registry: BundleRegistrySettings,
  client: BundleRegistryClient = defaultClient,
) {
  let last: BundleInfo[] = [];
  /** Per tag key: the refreshes in a row its copy was kept without a HEAD to check it. */
  let unchecked = new Map<string, number>();
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
    const previous = new Map(last.map(b => [tagKey(b), b]));
    const results = await Promise.all(
      tags.map(async (tag): Promise<Outcome> => {
        if ('bundle' in tag) {
          return { bundle: tag.bundle };
        }
        const kept = previous.get(tagKey(tag));
        if (!kept) {
          return { warning: `bundle ${tag.ref} skipped: ${tag.error}` };
        }
        return keepOrDrop(client, tag, kept, unchecked.get(tagKey(tag)) ?? 0);
      }),
    );
    const bundles: BundleInfo[] = [];
    const warnings: string[] = [];
    const nextUnchecked = new Map<string, number>();
    results.forEach((r, i) => {
      if (r.bundle) {
        bundles.push(r.bundle);
      }
      if (r.warning) {
        warnings.push(r.warning);
      }
      if (r.unchecked) {
        nextUnchecked.set(tagKey(tags[i]), r.unchecked);
      }
    });
    last = bundles;
    unchecked = nextUnchecked;
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
  const inLocal = new Set(local.map(tagKey));
  const replaced = registry.map(tagKey).filter(k => inLocal.has(k));
  return {
    bundles: [...local, ...registry.filter(b => !inLocal.has(tagKey(b)))],
    replaced,
  };
}
