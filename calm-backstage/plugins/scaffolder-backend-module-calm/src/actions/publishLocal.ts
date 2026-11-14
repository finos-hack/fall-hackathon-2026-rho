import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  CALM_ANNOTATIONS as ANN,
  bundleEntityName,
  parseBundleValue,
  patternEntityName,
} from '@internal/backstage-plugin-calm-common';
import { listFiles } from '@internal/backstage-plugin-calm-node';
import YAML from 'yaml';

/** Owner when the Template gives none: the group the CALM provider's own entities belong to. */
export const DEFAULT_OWNER = 'group:default/guests';
export const CATALOG_INFO_FILE = 'catalog-info.yaml';
export const ARCHITECTURE_FILE = 'architecture.json';

const ENTITY_NAME = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/;

/** The `catalog-info.yaml` Component of a service created from a CALM pattern. */
export function serviceEntity(opts: {
  name: string;
  owner: string;
  namespace?: string;
  patternId: string;
  patternVersion: string;
  bundleName: string;
  bundleVersion: string;
  description?: string;
}): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: opts.name,
      description:
        opts.description ??
        `Service created from the CALM pattern ${
          opts.namespace ? `${opts.namespace}/` : ''
        }${opts.patternId} ${
          opts.patternVersion
        }, rendered with the template bundle ${opts.bundleName} ${
          opts.bundleVersion
        }.`,
      annotations: {
        ...(opts.namespace ? { [ANN.namespace]: opts.namespace } : {}),
        [ANN.pattern]: opts.patternId,
        [ANN.patternVersion]: opts.patternVersion,
        [ANN.bundle]: opts.bundleName,
        [ANN.bundleVersion]: opts.bundleVersion,
        [ANN.architectureFile]: `./${ARCHITECTURE_FILE}`,
      },
      tags: ['calm', 'calm-service'],
    },
    spec: {
      type: 'service',
      lifecycle: 'experimental',
      owner: opts.owner,
      dependsOn: [
        `resource:default/${patternEntityName(opts.patternId)}`,
        `resource:default/${bundleEntityName(
          opts.bundleName,
          opts.bundleVersion,
        )}`,
      ],
    },
  };
}

/**
 * `calm:publish:local`: copies the rendered files and the architecture into `<calm.publish.localDir>/<name>` and
 * writes a `catalog-info.yaml` Component for the new service. Refuses an existing folder unless `overwrite` is set.
 */
export function createCalmPublishLocalAction(options: {
  catalog: CatalogService;
  localDir: string;
}) {
  return createTemplateAction({
    id: 'calm:publish:local',
    description:
      'Publishes the rendered service to a local folder (<calm.publish.localDir>/<name>): rendered files, architecture.json and a catalog-info.yaml Component.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .describe(
              'Service name: the folder name and the Component name (letters, digits, - _ .; at most 63)',
            ),
        sourceDir: z =>
          z
            .string()
            .optional()
            .describe(
              'Rendered files, relative to the workspace. Default rendered',
            ),
        architecturePath: z =>
          z
            .string()
            .optional()
            .describe(
              'Architecture file, relative to the workspace. Default architecture.json',
            ),
        namespace: z =>
          z.string().optional().describe('CALM Hub namespace of the pattern'),
        patternId: z => z.string().describe('Pattern id, e.g. web-service'),
        patternVersion: z => z.string().describe('Pattern version'),
        bundle: z =>
          z.string().describe('Template bundle as `<name>@<version>`'),
        owner: z =>
          z
            .string()
            .optional()
            .describe(`Owner entity ref. Default ${DEFAULT_OWNER}`),
        overwrite: z =>
          z
            .boolean()
            .optional()
            .describe(
              'Replace an existing folder of the same name. Default false',
            ),
      },
      output: {
        path: z => z.string().describe('Absolute path of the published folder'),
        catalogInfoPath: z =>
          z.string().describe('Absolute path of its catalog-info.yaml'),
        entityRef: z => z.string(),
        files: z =>
          z.array(z.string()).describe('Files in the folder, relative to it'),
      },
    },
    async handler(ctx) {
      const { name, patternId, patternVersion } = ctx.input;
      if (name.length > 63 || !ENTITY_NAME.test(name)) {
        throw new Error(
          `Service name ${JSON.stringify(
            name,
          )} is not a valid entity name: letters and digits, separated by - _ or ., at most 63 characters`,
        );
      }
      const bundle = parseBundleValue(ctx.input.bundle);
      if (!bundle) {
        throw new Error(
          `Bundle must be <name>@<version>, got ${JSON.stringify(
            ctx.input.bundle,
          )}`,
        );
      }
      const sourceDir = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.sourceDir ?? 'rendered',
      );
      const architecturePath = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? ARCHITECTURE_FILE,
      );
      const rendered = await listFiles(sourceDir);
      if (!rendered.length) {
        throw new Error(
          `Nothing to publish in ${ctx.input.sourceDir ?? 'rendered'}`,
        );
      }
      const clash = rendered.find(
        f => f === ARCHITECTURE_FILE || f === CATALOG_INFO_FILE,
      );
      if (clash) {
        throw new Error(
          `The bundle rendered ${clash}, which calm:publish:local writes itself`,
        );
      }

      // The user the task runs as (the guest sign-in is user:development/guest, which the catalog does not hold).
      ctx.logger.info(`Task user: ${ctx.user?.ref ?? '(none)'}`);
      const owner = ctx.input.owner || DEFAULT_OWNER;

      await fs.mkdir(options.localDir, { recursive: true });
      const target = resolveSafeChildPath(options.localDir, name);

      // Refuse a name the catalog already holds from elsewhere (a Hub architecture, another service) before writing
      // anything: calm:register:local could not claim it, and the folder would be left behind.
      const entityRef = stringifyEntityRef({ kind: 'Component', name });
      const existing = await options.catalog.getEntityByRef(entityRef, {
        credentials: await ctx.getInitiatorCredentials(),
      });
      const existingLocation =
        existing?.metadata.annotations?.['backstage.io/managed-by-location'];
      const ownLocation = `file:${path.join(target, CATALOG_INFO_FILE)}`;
      if (existing && existingLocation !== ownLocation) {
        throw new Error(
          `The catalog already has ${entityRef} (from ${
            existingLocation ?? 'an unknown location'
          }); choose another service name`,
        );
      }
      const exists = await fs
        .stat(target)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        if (!ctx.input.overwrite) {
          throw new Error(
            `${target} already exists; calm:publish:local does not overwrite it (set overwrite: true in the Template, or remove the folder)`,
          );
        }
        ctx.logger.warn(`Replacing ${target}`);
        await fs.rm(target, { recursive: true, force: true });
      }

      await fs.cp(sourceDir, target, { recursive: true, errorOnExist: true });
      await fs.copyFile(architecturePath, path.join(target, ARCHITECTURE_FILE));
      const entity = serviceEntity({
        name,
        owner,
        namespace: ctx.input.namespace,
        patternId,
        patternVersion,
        bundleName: bundle.name,
        bundleVersion: bundle.version,
      });
      const catalogInfoPath = path.join(target, CATALOG_INFO_FILE);
      await fs.writeFile(catalogInfoPath, YAML.stringify(entity));

      const files = await listFiles(target);
      ctx.logger.info(
        `Published ${entityRef} to ${target}: ${files.join(', ')}`,
      );
      ctx.output('path', target);
      ctx.output('catalogInfoPath', catalogInfoPath);
      ctx.output('entityRef', entityRef);
      ctx.output('files', files);
    },
  });
}
