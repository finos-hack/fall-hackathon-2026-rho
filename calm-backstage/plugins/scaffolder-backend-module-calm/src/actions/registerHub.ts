import fs from 'node:fs/promises';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
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
 */
export function createCalmRegisterHubAction(options: {
  hub: CalmHubWriteClient;
  /** `calm.publish.hubNamespace`: the Hub namespace the architectures are stored in. */
  namespace: string;
}) {
  const { hub, namespace } = options;
  return createTemplateAction({
    id: 'calm:register:hub',
    description:
      "Stores the architecture in CALM Hub (namespace calm.publish.hubNamespace) as <name> version <version>, sets its $id to that version's Hub URL, adds a title (the name) and a description when it has none, marks it as the service's in metadata, and writes all of it back to the workspace file. An identical latest version is reused; a different one gets the next patch version, since Hub versions cannot change. A dry run reads the Hub and writes nothing to it.",
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
      },
      output: {
        namespace: z => z.string().describe('Hub namespace'),
        architecture: z => z.string().describe('Architecture name in the Hub'),
        version: z => z.string().describe('The version it is stored as'),
        url: z => z.string().describe("The version's Hub URL: the $id"),
        created: z =>
          z
            .boolean()
            .describe(
              'False when an identical version was reused, and in a dry run',
            ),
      },
    },
    async handler(ctx) {
      const { name } = ctx.input;
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
      const doc = markServiceArchitecture(
        withTitle(withoutId(read), name),
        entityRef,
      );

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

      if (reuse) {
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
        // Read it back: the Hub must hold it under the URL the file is about to name as its $id.
        const back = await hub.architecture(namespace, name, version);
        if (back?.$id !== url) {
          throw new Error(
            `CALM Hub stored ${namespace}/${name} ${version} with $id ${JSON.stringify(
              back?.$id,
            )}, expected ${url} (is calm.hubUrl the Hub's own base URL?)`,
          );
        }
        ctx.logger.info(
          `Stored the architecture in CALM Hub as ${namespace}/${name} ${version}: ${url}`,
        );
      }

      await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
      ctx.output('namespace', namespace);
      ctx.output('architecture', name);
      ctx.output('version', version);
      ctx.output('url', url);
      ctx.output('created', !reuse && !ctx.isDryRun);
    },
  });
}
