import fs from 'node:fs/promises';
import {
  type AuthService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  CalmHubError,
  CalmHubWriteClient,
  architectureVersionPath,
} from '@internal/backstage-plugin-calm-common';
import { assertImportName, importNameClash } from './importName';
import {
  DEFAULT_HUB_VERSION,
  checkStored,
  withTitle,
  withoutId,
} from './registerHub';

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';

const noNamespace = (namespace: string) =>
  `CALM Hub has no namespace ${namespace} (calm.publish.hubNamespace); create it in CALM Hub first. Nothing was stored`;

/**
 * `calm:import:store`: stores an imported architecture in CALM Hub as `<name>` version 1.0.0, after checking again
 * that the name is free in CALM Hub and the catalog. Like `calm:register:hub`, it sets `$id` to the version's Hub URL
 * and adds a `title` (the name) and a `description` when missing, and writes the document back to the workspace; it
 * does not mark the architecture as a service's. A dry run makes the checks and stores nothing.
 */
export function createCalmImportStoreAction(options: {
  hub: CalmHubWriteClient;
  /** `calm.publish.hubNamespace`: the Hub namespace the architecture is stored in. */
  namespace: string;
  catalog: Pick<CatalogService, 'getEntityByRef'>;
  auth: Pick<AuthService, 'getOwnServiceCredentials'>;
}) {
  const { hub, namespace } = options;
  return createTemplateAction({
    id: 'calm:import:store',
    description: `Stores an imported architecture in CALM Hub (namespace calm.publish.hubNamespace) as <name> version ${DEFAULT_HUB_VERSION}, after checking that neither CALM Hub nor the catalog holds the name. Sets $id to the version's Hub URL, adds a title (the name) and a description when missing, and writes the document back to the workspace. A dry run checks and stores nothing.`,
    supportsDryRun: true,
    schema: {
      input: {
        name: z =>
          z
            .string()
            .describe(
              'Name of the architecture in CALM Hub: a lower-case letter first, then lower-case letters, digits and single hyphens, at most 63 characters',
            ),
        architecturePath: z =>
          z
            .string()
            .optional()
            .describe(
              'Architecture file, relative to the workspace. Default architecture.json',
            ),
        description: z =>
          z
            .string()
            .optional()
            .describe(
              'Description the architecture gets when it has none. Default: Created by Backstage.',
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
              "The version's Hub URL: the $id. None in a dry run, as the Hub does not hold it",
            ),
        entityRef: z =>
          z.string().describe('The catalog entity the architecture appears as'),
      },
    },
    async handler(ctx) {
      const { name } = ctx.input;
      assertImportName(name);
      const clash = await importNameClash(name, options);
      if (clash) {
        throw new Error(clash);
      }
      // The architecture list of a missing namespace answers 404, which the name check takes as "no architectures".
      if (!(await hub.namespaces()).includes(namespace)) {
        throw new Error(noNamespace(namespace));
      }
      const file = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const read = JSON.parse(await fs.readFile(file, 'utf-8'));
      if (typeof read !== 'object' || read === null || Array.isArray(read)) {
        throw new Error(`${file} is not a CALM architecture (a JSON object)`);
      }

      const version = DEFAULT_HUB_VERSION;
      const url = `${hub.baseUrl}${architectureVersionPath(
        namespace,
        name,
        version,
      )}`;
      const described =
        ctx.input.description?.trim() && !hasText(read.description)
          ? { description: ctx.input.description }
          : {};
      // $schema, $id, title, description, then the rest; no service mark.
      const doc = withTitle(
        { ...withoutId(read), ...described, $id: url },
        name,
      );

      if (ctx.isDryRun) {
        ctx.logger.info(
          `Dry run: would store the architecture as ${namespace}/${name} ${version} (${url})`,
        );
      } else {
        try {
          await hub.createArchitectureVersion(namespace, name, version, doc);
        } catch (e) {
          if (e instanceof CalmHubError && e.status === 409) {
            throw new Error(
              `CALM Hub already holds ${namespace}/${name} ${version} (stored since the name was checked); choose another name. Nothing was stored`,
              { cause: e },
            );
          }
          throw e;
        }
        await checkStored(hub, namespace, name, version, url);
        ctx.logger.info(
          `Stored the architecture in CALM Hub as ${namespace}/${name} ${version}: ${url}`,
        );
      }

      await fs.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
      ctx.output('namespace', namespace);
      ctx.output('architecture', name);
      ctx.output('version', version);
      if (!ctx.isDryRun) {
        ctx.output('url', url);
      }
      ctx.output('entityRef', `component:default/${name}`);
    },
  });
}
