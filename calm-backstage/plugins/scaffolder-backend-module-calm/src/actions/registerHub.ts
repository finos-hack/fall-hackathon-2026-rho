import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  type AuthService,
  type LoggerService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  CALM_ANNOTATIONS as ANN,
  CalmHubError,
  CalmHubWriteClient,
  HUB_NAME,
  HUB_VERSION,
  architectureVersionPath,
  compareVersions,
  latestVersion,
  markServiceArchitecture,
  nextPatchVersion,
  parsePatternUrl,
  sameJson,
  serviceEntityOf,
} from '@internal/backstage-plugin-calm-common';
import { assertClaimable, fileLocationRef, lookUpClaim } from './catalogClaim';
import { DRY_RUN_OUTPUT_DIR, isDryRunFolder } from './publishedFolder';
import { CATALOG_INFO_FILE } from './publishLocal';

export const DEFAULT_HUB_VERSION = '1.0.0';

const withoutId = (doc: Record<string, any>) => {
  const { $id: _, ...rest } = doc;
  return rest;
};

/**
 * The `title` and `description` the Hub document gets when the architecture has none (`calm generate` gives
 * neither, and the Hub refuses a document without a title). Existing ones are kept.
 */
export function withTitle(
  doc: Record<string, any>,
  name: string,
): Record<string, any> {
  const has = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  const pattern = parsePatternUrl(doc.$schema);
  const { $schema, $id, title, description, ...rest } = doc;
  return {
    ...($schema !== undefined ? { $schema } : {}),
    ...($id !== undefined ? { $id } : {}),
    title: has(title) ? title : name,
    description: has(description)
      ? description
      : `Created ${
          pattern
            ? `from the CALM pattern ${pattern.namespace}/${pattern.id} ${pattern.version} `
            : ''
        }by Backstage.`,
    ...rest,
  };
}

/**
 * Which version an architecture is stored as, given the versions the Hub holds under its name (Hub versions cannot
 * change). The latest version is reused when it holds the same document (`$id` aside). Otherwise the wanted version
 * is used when it is new and above the latest, and the patch after the latest when it is not.
 */
export function chooseVersion(opts: {
  wanted: string;
  versions: string[];
  /** The document of the latest version in `versions`. */
  latest?: unknown;
  /** The document to store. */
  doc: Record<string, any>;
}): { version: string; reuse: boolean } {
  const latestV = latestVersion(opts.versions);
  if (!latestV) {
    return { version: opts.wanted, reuse: false };
  }
  if (
    opts.latest &&
    sameJson(withoutId(opts.latest as Record<string, any>), withoutId(opts.doc))
  ) {
    return { version: latestV, reuse: true };
  }
  if (
    !opts.versions.includes(opts.wanted) &&
    compareVersions(opts.wanted, latestV) > 0
  ) {
    return { version: opts.wanted, reuse: false };
  }
  return { version: nextPatchVersion(latestV), reuse: false };
}

/**
 * `calm:register:hub`: stores the workspace architecture in CALM Hub as a version of an architecture named after the
 * service, and writes the version's Hub URL into the file as its `$id`, so what is rendered and published carries it.
 * The stored document also gets a `title` and `description` when it has none, and the service mark in `metadata`.
 *
 * `mode` splits it in two, so the Hub write can come after the render and the publish (a Hub version cannot be
 * deleted, a published folder can): `prepare` makes every check and writes the file with its `$id`, and `store`
 * (later) stores exactly that file as the version its `$id` names. Without `mode` it does both at once. When the
 * store fails, it removes the folder this run published (`publishedDir`), so the Template can be run again.
 */
export function createCalmRegisterHubAction(options: {
  hub: CalmHubWriteClient;
  /** `calm.publish.hubNamespace`: the Hub namespace the architectures are stored in. */
  namespace: string;
  /** For the name check before any Hub write: the catalog, and `calm.publish.localDir`. */
  catalog: Pick<CatalogService, 'getEntityByRef'>;
  auth: Pick<AuthService, 'getOwnServiceCredentials'>;
  localDir: string;
}) {
  const { hub, namespace } = options;
  return createTemplateAction({
    id: 'calm:register:hub',
    description:
      "Stores the architecture in CALM Hub (namespace calm.publish.hubNamespace) as <name> version <version>, sets its $id to that version's Hub URL, adds a title (the name) and a description when it has none, marks it as the service's in metadata, and writes all of it back to the workspace file. An identical latest version is reused; a different one gets the next patch version, since Hub versions cannot change. A dry run reads the Hub and writes nothing to it. With mode prepare it makes the checks and writes the file but stores nothing; with mode store (after prepare) it stores the prepared file as the version its $id names, reuses that version when the Hub holds the same document, and fails when it holds another; when that store fails, it removes publishedDir if its catalog-info.yaml names the same architecture version.",
    supportsDryRun: true,
    schema: {
      input: {
        architecturePath: z =>
          z
            .string()
            .optional()
            .describe(
              'Architecture file, relative to the workspace. Default architecture.json',
            ),
        name: z =>
          z
            .string()
            .describe(
              'Service name; names the architecture in the Hub (a letter first, then letters, digits and hyphens)',
            ),
        version: z =>
          z
            .string()
            .optional()
            .describe(
              `Version to store it as, <major>.<minor>.<patch>. Default ${DEFAULT_HUB_VERSION}`,
            ),
        mode: z =>
          z
            .enum(['prepare', 'store'])
            .optional()
            .describe(
              'prepare: check and write the file, store nothing. store: store the file prepared earlier. Omitted: both',
            ),
        publishedDir: z =>
          z
            .string()
            .optional()
            .describe(
              'Store mode: the folder calm:publish:local made from the prepared file (calm.publish.localDir/<name>). Its architecture.json must be the file being stored. Removed when the store fails, if it is that folder and its architecture.json has the same $id, so the Template can be run again',
            ),
      },
      output: {
        namespace: z => z.string().describe('Hub namespace'),
        architecture: z => z.string().describe('Architecture name in the Hub'),
        version: z => z.string().describe('The version it is stored as'),
        url: z =>
          z
            .string()
            .optional()
            .describe(
              "The version's Hub URL: the $id. None in a dry run that would store the version, as the Hub does not hold it",
            ),
        created: z =>
          z
            .boolean()
            .describe(
              'False when an identical version was reused, in a dry run, and always in prepare mode',
            ),
      },
    },
    async handler(ctx) {
      const { name, mode } = ctx.input;
      const wanted = ctx.input.version ?? DEFAULT_HUB_VERSION;
      if (!HUB_NAME.test(name)) {
        throw new Error(
          `CALM Hub does not accept the architecture name ${JSON.stringify(
            name,
          )}: a letter first, then letters, digits and single hyphens`,
        );
      }
      if (!HUB_VERSION.test(wanted)) {
        throw new Error(
          `Version must be <major>.<minor>.<patch>, got ${JSON.stringify(
            wanted,
          )}`,
        );
      }
      const file = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const read = JSON.parse(await fs.readFile(file, 'utf-8'));
      if (typeof read !== 'object' || read === null || Array.isArray(read)) {
        throw new Error(`${file} is not a CALM architecture (a JSON object)`);
      }
      // The Hub architecture belongs to this service: the catalog provider then emits no Component of its own for it.
      const entityRef = `component:default/${name}`;

      // Without the store mode this step runs before calm:publish:local, so it makes publish's name checks first: a
      // name the catalog holds from elsewhere, or a service folder that exists, would make publish fail after the Hub
      // had a new version. The store mode runs after the publish, which made the folder, so it skips the folder check.
      const target = resolveSafeChildPath(options.localDir, name);
      const checkClaim = async () =>
        assertClaimable(
          await lookUpClaim(options, entityRef),
          fileLocationRef(path.join(target, CATALOG_INFO_FILE)),
          entityRef,
        );
      if (mode === 'store') {
        // The store mode makes the claim check in its cleanup path: a refusal there removes the published folder.
        await storePrepared(ctx, {
          hub,
          namespace,
          name,
          entityRef,
          file,
          read,
          target,
          checkClaim,
        });
        return;
      }
      await checkClaim();
      const folderExists = await fs
        .stat(target)
        .then(() => true)
        .catch(() => false);
      if (folderExists) {
        throw new Error(
          `${target} already exists, so the service ${name} has already been created; choose another service name`,
        );
      }
      const doc = markServiceArchitecture(
        withTitle(withoutId(read), name),
        entityRef,
      );

      const { versions, latest } = await ownedVersions(
        hub,
        namespace,
        name,
        entityRef,
      );

      const { version, reuse } = chooseVersion({
        wanted,
        versions,
        latest,
        doc,
      });
      const url = `${hub.baseUrl}${architectureVersionPath(
        namespace,
        name,
        version,
      )}`;
      // $schema, $id, title, description, then the rest.
      const stored = withTitle({ ...doc, $id: url }, name);

      if (mode === 'prepare') {
        ctx.logger.info(
          `Prepared the architecture for CALM Hub as ${namespace}/${name} ${version}: ${url}`,
        );
      } else if (reuse) {
        ctx.logger.info(
          `CALM Hub already holds this architecture as ${namespace}/${name} ${version}: ${url}`,
        );
      } else if (ctx.isDryRun) {
        ctx.logger.info(
          `Dry run: would store the architecture as ${namespace}/${name} ${version} (${url})`,
        );
      } else {
        if (version !== wanted) {
          ctx.logger.info(
            `${namespace}/${name} has the versions ${versions.join(
              ', ',
            )} and the latest differs, so this one is stored as ${version}`,
          );
        }
        await hub.createArchitectureVersion(namespace, name, version, stored);
        await checkStored(hub, namespace, name, version, url);
        ctx.logger.info(
          `Stored the architecture in CALM Hub as ${namespace}/${name} ${version}: ${url}`,
        );
      }

      await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
      ctx.output('namespace', namespace);
      ctx.output('architecture', name);
      ctx.output('version', version);
      // A dry run that would store the version has no Hub page for it yet.
      if (!(ctx.isDryRun && mode !== 'prepare' && !reuse)) {
        ctx.output('url', url);
      }
      ctx.output('created', mode !== 'prepare' && !reuse && !ctx.isDryRun);
    },
  });
}

/**
 * The versions the Hub holds under the name, and the latest one's document; refuses an architecture whose latest
 * version is not this service's (it was stored by something else).
 */
async function ownedVersions(
  hub: CalmHubWriteClient,
  namespace: string,
  name: string,
  entityRef: string,
): Promise<{ versions: string[]; latest: unknown }> {
  let versions: string[] = [];
  try {
    versions = await hub.architectureVersions(namespace, name);
  } catch (e) {
    if (!(e instanceof CalmHubError && e.status === 404)) {
      throw e;
    }
  }
  const latestV = latestVersion(versions);
  const latest = latestV
    ? await hub.architecture(namespace, name, latestV)
    : undefined;
  if (latestV && serviceEntityOf(latest) !== entityRef) {
    const owner = serviceEntityOf(latest);
    throw new Error(
      `CALM Hub already holds an architecture ${namespace}/${name} (version ${latestV}) that ${
        owner
          ? `was registered for ${owner}`
          : 'was not registered for a service'
      }; refusing to add a version to it. Choose another service name`,
    );
  }
  return { versions, latest };
}

/** Reads a stored version back: the Hub must hold it under the URL the files name as its `$id`. */
async function checkStored(
  hub: CalmHubWriteClient,
  namespace: string,
  name: string,
  version: string,
  url: string,
) {
  const back = await hub.architecture(namespace, name, version);
  if (back?.$id !== url) {
    throw new Error(
      `CALM Hub stored ${namespace}/${name} ${version} with $id ${JSON.stringify(
        back?.$id,
      )}, expected ${url} (is calm.hubUrl the Hub's own base URL?)`,
    );
  }
}

/** What the store mode uses of the action context. */
interface StoreContext {
  input: { publishedDir?: string };
  isDryRun?: boolean;
  workspacePath: string;
  logger: LoggerService;
  output(name: string, value: unknown): void;
}

/**
 * Store mode: stores the prepared file, as it is, as the version its `$id` names (what was rendered and published
 * names that version). An identical document at that version is reused; another one fails, writing nothing. When
 * the store fails after the file checks and before a POST that worked, the folder this run published is removed
 * (see `removePublished`).
 */
async function storePrepared(
  ctx: StoreContext,
  opts: {
    hub: CalmHubWriteClient;
    namespace: string;
    name: string;
    entityRef: string;
    file: string;
    read: Record<string, any>;
    /** The service folder calm:publish:local made: the only folder the cleanup may remove. */
    target: string;
    /** The catalog name check. */
    checkClaim: () => Promise<unknown>;
  },
) {
  const { hub, namespace, name, entityRef, file, read } = opts;
  const prefix = `${hub.baseUrl}${architectureVersionPath(
    namespace,
    name,
    '',
  )}`;
  const prepareFirst = `Nothing was stored; run calm:register:hub with mode prepare (the register-hub step) first`;
  if (typeof read.$id !== 'string' || !read.$id) {
    throw new Error(
      `${file} has no $id of a CALM Hub version. ${prepareFirst}`,
    );
  }
  const url: string = read.$id;
  let version = '';
  try {
    version = decodeURIComponent(url.slice(prefix.length));
  } catch {
    // not a version, reported below
  }
  if (
    !url.startsWith(prefix) ||
    !HUB_VERSION.test(version) ||
    url !== `${hub.baseUrl}${architectureVersionPath(namespace, name, version)}`
  ) {
    throw new Error(
      `The $id of ${file}, ${url}, is not a version of ${namespace}/${name} in this CALM Hub (${hub.baseUrl}). ${prepareFirst}`,
    );
  }
  if (serviceEntityOf(read) !== entityRef) {
    throw new Error(
      `${file} is not marked as the architecture of ${entityRef}. ${prepareFirst}`,
    );
  }

  // The published folder is read and may be removed: only the service folder calm:publish:local wrote qualifies.
  // In a dry run it wrote to the workspace instead.
  const allowed = [
    opts.target,
    ...(ctx.isDryRun
      ? [path.join(ctx.workspacePath, DRY_RUN_OUTPUT_DIR, name)]
      : []),
  ].map(d => path.resolve(d));
  if (
    ctx.input.publishedDir &&
    !allowed.includes(path.resolve(ctx.input.publishedDir))
  ) {
    throw new Error(
      `publishedDir must be the folder calm:publish:local wrote for ${name} (${allowed.join(
        ' or ',
      )}), got ${JSON.stringify(
        ctx.input.publishedDir,
      )}. Nothing was stored, and nothing was removed`,
    );
  }

  // Everything from here on may fail with nothing stored for this run: the folder this run published is then removed.
  let created = false;
  // Set in a dry run that would store the version: the Hub does not hold it, so it has no URL to give.
  let wouldStore = false;
  // Set when the POST itself failed (a network error or a 5xx): the Hub may have committed the version.
  let postFailed = false;
  try {
    await opts.checkClaim();
    const { versions } = await ownedVersions(hub, namespace, name, entityRef);
    // In a dry run, the folder calm:publish:local wrote in the workspace is checked; a localDir one is not.
    let checked: string | undefined = ctx.isDryRun ? undefined : opts.target;
    if (
      ctx.isDryRun &&
      ctx.input.publishedDir &&
      isDryRunFolder(ctx.input.publishedDir, ctx.workspacePath)
    ) {
      checked = path.resolve(ctx.input.publishedDir);
    }
    if (ctx.input.publishedDir && checked) {
      // What was published (and pushed next) must name what is stored.
      const named = await publishedVersion(checked);
      if (named.architecture !== name || named.version !== version) {
        throw new Error(
          `The published folder's ${CATALOG_INFO_FILE} names ${JSON.stringify(
            named.architecture,
          )} version ${JSON.stringify(
            named.version,
          )}, not the ${name} version ${version} being stored`,
        );
      }
    }
    // The Hub's document at the version, if it holds it: the same one (`$id` aside) is reused, another one fails.
    const reuse = async (held: unknown) => {
      if (!sameJson(withoutId(held as Record<string, any>), withoutId(read))) {
        throw new Error(
          `CALM Hub already holds another document as ${namespace}/${name} ${version}, the version the published files name (${url}); a Hub version cannot change`,
        );
      }
      ctx.logger.info(
        `CALM Hub already holds this architecture as ${namespace}/${name} ${version}: ${url}`,
      );
    };
    if (versions.includes(version)) {
      await reuse(await hub.architecture(namespace, name, version));
    } else if (ctx.isDryRun) {
      wouldStore = true;
      ctx.logger.info(
        `Dry run: would store the architecture as ${namespace}/${name} ${version} (${url})`,
      );
    } else {
      try {
        await hub.createArchitectureVersion(namespace, name, version, read);
        created = true;
      } catch (e) {
        if (!(e instanceof CalmHubError && e.status === 409)) {
          postFailed = true;
          throw e;
        }
        // Another run stored the version in between.
        await reuse(await hub.architecture(namespace, name, version));
      }
      if (created) {
        await checkStored(hub, namespace, name, version, url);
        ctx.logger.info(
          `Stored the architecture in CALM Hub as ${namespace}/${name} ${version}: ${url}`,
        );
      }
    }
  } catch (e) {
    // After a POST that worked the version exists, and the published folder names it rightly: keep it.
    if (created || ctx.isDryRun || !ctx.input.publishedDir) {
      throw e;
    }
    const removed = await removePublished(
      ctx,
      opts.target,
      ctx.input.publishedDir,
      { name, version },
    );
    if (!removed) {
      throw e;
    }
    const message = (e as Error).message.replace(/[.\s]+$/, '');
    throw new Error(
      postFailed
        ? `${message}. Storing in CALM Hub failed, and CALM Hub may or may not hold ${namespace}/${name} ${version} now; the folder ${removed} this run published was removed, so the Template can be run again (a rerun with the same document reuses it if CALM Hub has it)`
        : `${message}. Nothing was stored in CALM Hub, and the folder ${removed} this run published was removed, so the Template can be run again`,
      { cause: e },
    );
  }

  ctx.output('namespace', namespace);
  ctx.output('architecture', name);
  ctx.output('version', version);
  if (!wouldStore) {
    ctx.output('url', url);
  }
  ctx.output('created', created);
}

/**
 * The architecture the published service folder's catalog-info.yaml names (CALM Hub holds the architecture itself).
 * A missing or broken file gives a clear error that does not echo its content.
 */
async function publishedVersion(
  target: string,
): Promise<{ architecture?: string; version?: string }> {
  const fail = (why: string) =>
    new Error(
      `Could not check the published ${CATALOG_INFO_FILE} in ${target}: ${why}`,
    );
  let text: string;
  try {
    text = await fs.readFile(path.join(target, CATALOG_INFO_FILE), 'utf-8');
  } catch (e) {
    throw fail(
      (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'it is missing'
        : `it could not be read (${
            (e as NodeJS.ErrnoException).code ?? 'error'
          })`,
    );
  }
  let doc: any;
  try {
    doc = YAML.parse(text);
  } catch {
    throw fail('it is not valid YAML');
  }
  const annotations = doc?.metadata?.annotations ?? {};
  return {
    architecture: annotations[ANN.architecture],
    version: annotations[ANN.architectureVersion],
  };
}

/**
 * Removes `publishedDir` when it is the service folder calm:publish:local made (`target`) and its catalog-info.yaml
 * names the architecture and version being stored: proof that this run published it. Gives the removed folder, or undefined when
 * nothing was removed. Never throws: a cleanup error is logged, so it cannot hide the store error.
 */
async function removePublished(
  ctx: StoreContext,
  target: string,
  publishedDir: string,
  expected: { name: string; version: string },
): Promise<string | undefined> {
  try {
    const dir = path.resolve(publishedDir);
    if (dir !== path.resolve(target)) {
      ctx.logger.warn(
        `Kept ${dir}: it is not the service folder ${target}, the only folder this step removes`,
      );
      return undefined;
    }
    const named = await publishedVersion(dir);
    if (
      named.architecture !== expected.name ||
      named.version !== expected.version
    ) {
      ctx.logger.warn(
        `Kept ${dir}: its ${CATALOG_INFO_FILE} names ${JSON.stringify(
          named.architecture,
        )} version ${JSON.stringify(named.version)}, not ${expected.name} ${
          expected.version
        }, so this run did not publish it`,
      );
      return undefined;
    }
    await fs.rm(dir, { recursive: true, force: true });
    ctx.logger.info(
      `Removed ${dir}, which this run published, since storing in CALM Hub failed`,
    );
    return dir;
  } catch (e) {
    ctx.logger.warn(
      `Could not remove the published folder ${JSON.stringify(publishedDir)}: ${
        (e as Error).message
      }`,
    );
    return undefined;
  }
}
