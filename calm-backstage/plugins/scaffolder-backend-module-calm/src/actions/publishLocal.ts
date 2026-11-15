import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type AuthService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  CALM_ANNOTATIONS as ANN,
  KUBERNETES_ANNOTATIONS as K8S,
  bundleEntityName,
  deployNamespace,
  isDnsLabel,
  parseBundleValue,
  patternEntityName,
} from '@internal/backstage-plugin-calm-common';
import { listFiles } from '@internal/backstage-plugin-calm-node';
import YAML from 'yaml';
import { assertClaimable, fileLocationRef, lookUpClaim } from './catalogClaim';

/** Owner when the Template gives none: the group the CALM provider's own entities belong to. */
export const DEFAULT_OWNER = 'group:default/guests';
export const CATALOG_INFO_FILE = 'catalog-info.yaml';
/**
 * The architecture copy services published before CALM Hub became the only store carry. Nothing reads it; an upgrade
 * removes it.
 */
export const LEGACY_ARCHITECTURE_FILE = 'architecture.json';

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
  /** The deployment-rules bundle, for a service made from a starter. */
  deployBundle?: { name: string; version: string };
  /** OCI reference and manifest digest of the bundle, when it was pulled from the bundle registry. */
  bundleRef?: string;
  bundleDigest?: string;
  /**
   * Where the service's Kubernetes objects are, for a bundle that renders them: the value of their
   * `backstage.io/kubernetes-id` label, and their namespace. The Kubernetes tab reads both.
   */
  kubernetes?: { id: string; namespace: string };
  /** The architecture version in CALM Hub (calm:register:hub): the only copy of the service's architecture. */
  hub: {
    namespace: string;
    architecture: string;
    version: string;
    url?: string;
  };
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
        }${opts.patternId} ${opts.patternVersion}, rendered with ${
          opts.deployBundle
            ? `the starter ${opts.bundleName} ${opts.bundleVersion} and the deployment rules ${opts.deployBundle.name} ${opts.deployBundle.version}`
            : `the template bundle ${opts.bundleName} ${opts.bundleVersion}`
        }.`,
      annotations: {
        ...(opts.namespace ? { [ANN.namespace]: opts.namespace } : {}),
        [ANN.pattern]: opts.patternId,
        [ANN.patternVersion]: opts.patternVersion,
        [ANN.bundle]: opts.bundleName,
        [ANN.bundleVersion]: opts.bundleVersion,
        ...(opts.bundleRef ? { [ANN.bundleRef]: opts.bundleRef } : {}),
        ...(opts.bundleDigest ? { [ANN.bundleDigest]: opts.bundleDigest } : {}),
        ...(opts.deployBundle
          ? {
              [ANN.deployBundle]: opts.deployBundle.name,
              [ANN.deployBundleVersion]: opts.deployBundle.version,
            }
          : {}),
        [ANN.architecture]: opts.hub.architecture,
        [ANN.architectureVersion]: opts.hub.version,
        // The one namespace annotation is the pattern's; the architecture's is named only when it differs.
        ...(opts.hub.namespace !== opts.namespace
          ? { [ANN.architectureNamespace]: opts.hub.namespace }
          : {}),
        ...(opts.kubernetes
          ? {
              [K8S.id]: opts.kubernetes.id,
              [K8S.namespace]: opts.kubernetes.namespace,
            }
          : {}),
      },
      tags: ['calm', 'calm-service'],
      ...(opts.hub.url
        ? {
            links: [
              { url: opts.hub.url, title: 'Architecture in CALM Hub (JSON)' },
            ],
          }
        : {}),
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
        ...(opts.deployBundle
          ? [
              `resource:default/${bundleEntityName(
                opts.deployBundle.name,
                opts.deployBundle.version,
              )}`,
            ]
          : []),
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
  auth: Pick<AuthService, 'getOwnServiceCredentials'>;
  localDir: string;
  /** `calm.deploy.kubernetes.namespacePrefix`: a deployable service's namespace is `<prefix><name>`. */
  namespacePrefix: string;
}) {
  return createTemplateAction({
    id: 'calm:publish:local',
    description:
      'Publishes the rendered service to a local folder (<calm.publish.localDir>/<name>): rendered files and a catalog-info.yaml Component whose annotations point at the architecture in CALM Hub. The architecture itself is not copied: CALM Hub is its only store.',
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
        namespace: z =>
          z.string().optional().describe('CALM Hub namespace of the pattern'),
        patternId: z => z.string().describe('Pattern id, e.g. web-service'),
        patternVersion: z => z.string().describe('Pattern version'),
        bundle: z =>
          z.string().describe('Template bundle as `<name>@<version>`'),
        deployBundle: z =>
          z
            .string()
            .optional()
            .describe(
              'Deployment-rules bundle as `<name>@<version>`, for a starter; empty for a full bundle. Recorded as calm.finos.org/deploy-bundle(-version)',
            ),
        deploySourceDir: z =>
          z
            .string()
            .optional()
            .describe(
              'Files the deployment rules rendered (relative to the workspace), merged into the folder; a file both bundles rendered fails the run. Empty: none',
            ),
        bundleRef: z =>
          z
            .string()
            .optional()
            .describe(
              'OCI reference the bundle was pulled from (calm:template output bundleRef); recorded as calm.finos.org/bundle-ref',
            ),
        bundleDigest: z =>
          z
            .string()
            .optional()
            .describe(
              'Manifest digest of the bundle (calm:template output bundleDigest); recorded as calm.finos.org/bundle-digest',
            ),
        hubNamespace: z =>
          z
            .string()
            .describe(
              'Hub namespace of the architecture (calm:register:hub output namespace)',
            ),
        hubArchitecture: z =>
          z
            .string()
            .describe(
              'Architecture name in the Hub (calm:register:hub output architecture); with hubNamespace and hubArchitectureVersion, recorded as the calm.finos.org/architecture annotations',
            ),
        hubArchitectureVersion: z =>
          z.string().describe('Its version (calm:register:hub output version)'),
        hubArchitectureUrl: z =>
          z
            .string()
            .optional()
            .describe(
              'Its Hub URL (calm:register:hub output url); added as a link',
            ),
        deployable: z =>
          z
            .boolean()
            .optional()
            .describe(
              'The bundle renders Kubernetes manifests (its calm-backstage.json has deploy: kubernetes): catalog-info.yaml then gets backstage.io/kubernetes-id and backstage.io/kubernetes-namespace. Default false',
            ),
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
      const rendered = await listFiles(sourceDir);
      if (!rendered.length) {
        throw new Error(
          `Nothing to publish in ${ctx.input.sourceDir ?? 'rendered'}`,
        );
      }
      const deployBundle = ctx.input.deployBundle
        ? parseBundleValue(ctx.input.deployBundle)
        : undefined;
      if (ctx.input.deployBundle && !deployBundle) {
        throw new Error(
          `Deployment bundle must be <name>@<version>, got ${JSON.stringify(
            ctx.input.deployBundle,
          )}`,
        );
      }
      const deploySourceDir = ctx.input.deploySourceDir
        ? resolveSafeChildPath(ctx.workspacePath, ctx.input.deploySourceDir)
        : undefined;
      const deployRendered = deploySourceDir
        ? await listFiles(deploySourceDir)
        : [];
      const twice = deployRendered.filter(f => rendered.includes(f));
      if (twice.length) {
        throw new Error(
          `Both the starter and the deployment rules rendered ${twice.join(
            ', ',
          )}: a starter must not render deploy/k8s`,
        );
      }
      const clash = [...rendered, ...deployRendered].find(
        f => f === CATALOG_INFO_FILE,
      );
      if (clash) {
        throw new Error(
          `The bundle rendered ${clash}, which calm:publish:local writes itself`,
        );
      }

      // The user the task runs as (the guest sign-in is user:development/guest, which the catalog does not hold).
      ctx.logger.info(`Task user: ${ctx.user?.ref ?? '(none)'}`);
      const owner = ctx.input.owner || DEFAULT_OWNER;

      // The annotations are written whether or not the service is then deployed: with nothing deployed the
      // Kubernetes tab is simply empty.
      let kubernetes: { id: string; namespace: string } | undefined;
      if (ctx.input.deployable) {
        if (
          isDnsLabel(name) &&
          isDnsLabel(`${options.namespacePrefix}${name}`)
        ) {
          kubernetes = {
            id: name,
            namespace: deployNamespace(options.namespacePrefix, name),
          };
        } else {
          // A name of up to 63 characters passes the form, but the namespace adds the prefix.
          ctx.logger.warn(
            `${name} cannot name Kubernetes objects (not a DNS label, or the namespace ${options.namespacePrefix}${name} is longer than 63 characters), so no Kubernetes annotations are written and the service cannot be deployed`,
          );
        }
      }

      // CALM Hub holds the only copy of the architecture: without its address the service would have none.
      const { hubNamespace, hubArchitecture, hubArchitectureVersion } =
        ctx.input;
      if (!hubNamespace || !hubArchitecture || !hubArchitectureVersion) {
        throw new Error(
          'calm:publish:local needs hubNamespace, hubArchitecture and hubArchitectureVersion (calm:register:hub outputs): CALM Hub is the only store of the architecture',
        );
      }
      const hub = {
        namespace: hubNamespace,
        architecture: hubArchitecture,
        version: hubArchitectureVersion,
        url: ctx.input.hubArchitectureUrl || undefined,
      };

      await fs.mkdir(options.localDir, { recursive: true });
      const target = resolveSafeChildPath(options.localDir, name);

      // Refuse a name the catalog already holds from elsewhere (a Hub architecture, another service) before writing
      // anything: calm:register:local could not claim it, and the folder would be left behind.
      const entityRef = stringifyEntityRef({ kind: 'Component', name });
      assertClaimable(
        await lookUpClaim(options, entityRef),
        fileLocationRef(path.join(target, CATALOG_INFO_FILE)),
        entityRef,
      );
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
      if (deploySourceDir) {
        // File by file: the folder exists now, and no file of the starter's may be replaced.
        for (const f of deployRendered) {
          const to = resolveSafeChildPath(target, f);
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(
            path.join(deploySourceDir, f),
            to,
            fsConstants.COPYFILE_EXCL,
          );
        }
      }
      const entity = serviceEntity({
        name,
        owner,
        namespace: ctx.input.namespace,
        patternId,
        patternVersion,
        bundleName: bundle.name,
        bundleVersion: bundle.version,
        deployBundle,
        // Empty when the bundle came from a local folder: then nothing is recorded.
        bundleRef: ctx.input.bundleRef || undefined,
        bundleDigest: ctx.input.bundleDigest || undefined,
        kubernetes,
        hub,
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
