import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * `calm:register:local`: registers a `catalog-info.yaml` under `calm.publish.localDir` as a `file` location.
 * The built-in `catalog:register` always adds a `url` location, which cannot read a local file. The catalog module
 * allows the `file` type. Waits (up to `waitSeconds`) until the catalog holds the entity from this file.
 *
 * The `catalog.locations` glob over the publish folder also reads these files (it brings published services back
 * after a restart, the catalog database being in memory). An entity the catalog already holds from this same file
 * counts as registered, so no second location is added for it.
 */
export function createCalmRegisterLocalAction(options: {
  catalog: CatalogService;
  localDir: string;
}) {
  return createTemplateAction({
    id: 'calm:register:local',
    description:
      'Registers a catalog-info.yaml from the local publish folder (calm.publish.localDir) in the catalog as a file location.',
    schema: {
      input: {
        catalogInfoPath: z =>
          z
            .string()
            .describe(
              'Absolute path of the catalog-info.yaml, inside calm.publish.localDir',
            ),
        waitSeconds: z =>
          z
            .number()
            .optional()
            .describe(
              'How long to wait for the catalog to process the entity. Default 30',
            ),
      },
      output: {
        entityRef: z => z.string(),
        locationTarget: z => z.string(),
      },
    },
    async handler(ctx) {
      const relative = path.relative(
        options.localDir,
        path.resolve(ctx.input.catalogInfoPath),
      );
      // Throws for a path outside the publish folder.
      const target = resolveSafeChildPath(options.localDir, relative);
      const credentials = await ctx.getInitiatorCredentials();

      // A dry run reads and processes the file without storing it: it gives the entity ref and surfaces errors.
      const dryRun = await options.catalog.addLocation(
        { type: 'file', target, dryRun: true },
        { credentials },
      );
      const entities = dryRun.entities.filter(
        e => !e.metadata.name.startsWith('generated-'),
      );
      const entity = entities.find(e => e.kind === 'Component') ?? entities[0];
      if (!entity) {
        throw new Error(`No entity in ${target}`);
      }
      const entityRef = stringifyEntityRef(entity);
      const wanted = `file:${target}`;

      const existing = await options.catalog.getEntityByRef(entityRef, {
        credentials,
      });
      const existingLocation =
        existing?.metadata.annotations?.['backstage.io/managed-by-location'];
      if (existing && existingLocation === wanted) {
        // Read already, e.g. by the catalog.locations glob over the publish folder.
        ctx.logger.info(
          `The catalog already holds ${entityRef} from ${wanted} (origin ${existing.metadata.annotations?.['backstage.io/managed-by-origin-location']})`,
        );
        ctx.output('entityRef', entityRef);
        ctx.output('locationTarget', wanted);
        return;
      }

      ctx.logger.info(`Registering file:${target} (${entityRef})`);
      try {
        await options.catalog.addLocation(
          { type: 'file', target },
          { credentials },
        );
      } catch (e) {
        if ((e as Error)?.name !== 'ConflictError') {
          throw e;
        }
        ctx.logger.info(`Location file:${target} is already registered`);
      }

      const deadline = Date.now() + (ctx.input.waitSeconds ?? 30) * 1000;
      for (;;) {
        const found = await options.catalog.getEntityByRef(entityRef, {
          credentials,
        });
        const location =
          found?.metadata.annotations?.['backstage.io/managed-by-location'];
        if (found && location === wanted) {
          ctx.logger.info(`The catalog holds ${entityRef} (from ${wanted})`);
          break;
        }
        if (found && location !== wanted) {
          throw new Error(
            `${entityRef} already exists in the catalog, from ${location}; the new location cannot claim it`,
          );
        }
        if (Date.now() > deadline) {
          ctx.logger.warn(
            `${entityRef} is not in the catalog yet; it will appear once the catalog has processed ${wanted}`,
          );
          break;
        }
        await sleep(1000);
      }
      ctx.output('entityRef', entityRef);
      ctx.output('locationTarget', wanted);
    },
  });
}
