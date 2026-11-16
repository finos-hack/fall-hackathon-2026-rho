import path from 'node:path';
import {
  type AuthService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import fs from 'node:fs/promises';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import YAML from 'yaml';
import { assertClaimable, fileLocationRef, lookUpClaim } from './catalogClaim';
import {
  DRY_RUN_OUTPUT_DIR,
  isDryRunFolder,
  publishedFolder,
} from './publishedFolder';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A 409 from `addLocation`: a `ConflictError` in process, or the catalog client's `ResponseError`, which carries the
 * status and puts the server's error (name `ConflictError`) in `cause`.
 */
export function isConflict(e: unknown): boolean {
  const err = e as {
    name?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    cause?: { name?: unknown };
  } | null;
  return (
    err?.name === 'ConflictError' ||
    err?.statusCode === 409 ||
    err?.response?.status === 409 ||
    err?.cause?.name === 'ConflictError'
  );
}

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
  auth: Pick<AuthService, 'getOwnServiceCredentials'>;
  localDir: string;
}) {
  return createTemplateAction({
    id: 'calm:register:local',
    supportsDryRun: true,
    description:
      'Registers a catalog-info.yaml from the local publish folder (calm.publish.localDir) in the catalog as a file location. In a dry run it adds nothing: it checks the name and logs the location it would add.',
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
      if (ctx.isDryRun) {
        // The file is in the dry-run folder of the workspace, which the catalog cannot read: read it here instead.
        const target = publishedFolder(
          options.localDir,
          ctx.input.catalogInfoPath,
          {
            dryRunWorkspace: ctx.workspacePath,
          },
        );
        const docs = YAML.parseAllDocuments(await fs.readFile(target, 'utf-8'))
          .map(d => d.toJS())
          .filter(d => d?.kind && d?.metadata?.name)
          .filter(d => !d.metadata.name.startsWith('generated-'));
        const entity = docs.find(d => d.kind === 'Component') ?? docs[0];
        if (!entity) {
          throw new Error(`No entity in ${target}`);
        }
        const entityRef = stringifyEntityRef(entity);
        // The real run registers the same file in localDir: check and report that location.
        const dryRoot = path.join(ctx.workspacePath, DRY_RUN_OUTPUT_DIR);
        const wanted = fileLocationRef(
          isDryRunFolder(target, ctx.workspacePath)
            ? resolveSafeChildPath(
                options.localDir,
                path.relative(dryRoot, target),
              )
            : target,
        );
        // Throws if the catalog holds the entity from elsewhere, as the real run does.
        assertClaimable(
          await lookUpClaim(options, entityRef),
          wanted,
          entityRef,
        );
        ctx.logger.info(`Dry run: would register ${wanted}`);
        ctx.output('entityRef', entityRef);
        ctx.output('locationTarget', wanted);
        return;
      }
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
      const wanted = fileLocationRef(target);

      // Throws if the catalog holds the entity from elsewhere: fail before adding a location it could not claim.
      if (
        assertClaimable(
          await lookUpClaim(options, entityRef),
          wanted,
          entityRef,
        )
      ) {
        // Read already, e.g. by the catalog.locations glob over the publish folder.
        ctx.logger.info(
          `The catalog already holds ${entityRef} from ${wanted}`,
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
        if (!isConflict(e)) {
          throw e;
        }
        ctx.logger.info(`Location file:${target} is already registered`);
      }

      const deadline = Date.now() + (ctx.input.waitSeconds ?? 30) * 1000;
      for (;;) {
        if (
          assertClaimable(
            await lookUpClaim(options, entityRef),
            wanted,
            entityRef,
          )
        ) {
          ctx.logger.info(`The catalog holds ${entityRef} (from ${wanted})`);
          break;
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
