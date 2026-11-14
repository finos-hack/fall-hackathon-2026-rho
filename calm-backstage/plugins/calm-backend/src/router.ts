import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Router from 'express-promise-router';
import {
  HttpAuthService,
  LoggerService,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import {
  Entity,
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import {
  CALM_ANNOTATIONS as ANN,
  CALM_ENTITY_TYPES as TYPES,
  CalmHubClient,
  CalmHubError,
  PatternDecision,
  Placeholder,
  RecordedDeployment,
  architectureVersionPath,
  compareVersions,
  latestVersion,
  readPatternDecisions,
  scanPlaceholders,
  templateEntityName,
} from '@internal/backstage-plugin-calm-common';
import {
  CalmCliError,
  KubernetesDeploySettings,
  generateArchitecture,
  normaliseChoices,
} from '@internal/backstage-plugin-calm-node';
import { DeploymentInfo, readDeployment } from './deployment';
import { readRecordedDeployments } from './hubDeployments';

/**
 * Body of `POST /placeholders`.
 *
 * `choices` is the `calm:generate` `choices` input: decision (relationship) id -> choice description (`oneOf`) or list
 * of descriptions (`anyOf`). The form field maps form parameters to decision ids with the Template's decision map, so
 * the route and the action pass the same JSON to the CLI; unanswered decisions are dropped and the CLI validates the
 * rest.
 */
export interface PlaceholdersRequest {
  patternUrl: string;
  choices?: Record<string, unknown>;
}

export interface PlaceholdersResponse {
  placeholders: Placeholder[];
  nodeCount: number;
  relationshipCount: number;
}

/** Response of `GET /architecture?entityRef=`. */
export interface ArchitectureResponse {
  architecture: unknown;
  /**
   * Where the document came from: CALM Hub (preferred when the entity has the Hub annotations), or the published
   * service's file (relative to the publish folder).
   */
  source:
    | { type: 'hub'; url: string; version: string }
    | { type: 'file'; path: string };
  /**
   * For a published service with the Kubernetes annotations: what it has running in the cluster of
   * `calm.deploy.kubernetes`. Absent when it is not deployed or the cluster could not be read.
   */
  deployment?: DeploymentInfo;
  /**
   * For an entity with the Hub annotations: the deployments CALM Hub holds for that architecture version (its
   * deployment decorators), newest first. Empty when none is recorded or the Hub could not be read.
   */
  deployments?: RecordedDeployment[];
}

/** Response of `GET /pattern?entityRef=`. */
export interface PatternResponse {
  pattern: {
    namespace: string;
    id: string;
    version: string;
    title?: string;
    url: string;
  };
  decisions: PatternDecision[];
  /** Template bundle Resources in the catalog that name this pattern, oldest version first. */
  bundles: {
    entityRef: string;
    name: string;
    version: string;
    title?: string;
    description?: string;
  }[];
  /** The pattern's Template, when the catalog holds it. */
  templateRef?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const enc = encodeURIComponent;

export async function createRouter(options: {
  hubUrl: string;
  logger: LoggerService;
  catalog: CatalogService;
  httpAuth: HttpAuthService;
  /** Absolute path of `calm.publish.localDir`: published architecture files are read only from inside it. */
  localDir: string;
  /** `calm.deploy.kubernetes`: the cluster a published service's deployment is read from. */
  kubernetes?: KubernetesDeploySettings;
}): Promise<express.Router> {
  const { logger, catalog, httpAuth, localDir } = options;
  const hub = new CalmHubClient(options.hubUrl);
  const hubPrefix = `${hub.baseUrl}/`;
  const router = Router();
  router.use(express.json());

  /** The entity named by `?entityRef=`, read with the caller's credentials. */
  async function entityFrom(req: express.Request): Promise<Entity> {
    const raw = req.query.entityRef;
    if (typeof raw !== 'string' || !raw) {
      throw new InputError('entityRef query parameter is required');
    }
    let ref: string;
    try {
      ref = stringifyEntityRef(parseEntityRef(raw));
    } catch (e) {
      throw new InputError(`Invalid entityRef: ${(e as Error).message}`);
    }
    const entity = await catalog.getEntityByRef(ref, {
      credentials: await httpAuth.credentials(req),
    });
    if (!entity) {
      throw new NotFoundError(`No entity ${ref} in the catalog`);
    }
    return entity;
  }

  /** Hub reads: a Hub 404 is a 404 here; other Hub failures stay server errors. */
  async function fromHub<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (e instanceof CalmHubError && e.status === 404) {
        throw new NotFoundError(e.message);
      }
      throw e;
    }
  }

  /** The architecture version the Hub annotations name, or undefined without them. */
  async function hubArchitecture(entity: Entity): Promise<
    | {
        architecture: unknown;
        ref: { namespace: string; architecture: string; version: string };
      }
    | undefined
  > {
    const a = entity.metadata.annotations ?? {};
    const id = a[ANN.architecture];
    if (!id) {
      return undefined;
    }
    // Coordinates from the annotations; the Hub is always the configured one (entity annotations are data).
    const namespace = a[ANN.architectureNamespace] ?? a[ANN.namespace];
    if (!namespace) {
      throw new InputError(
        `${stringifyEntityRef(entity)} has ${ANN.architecture} but no ${
          ANN.namespace
        }`,
      );
    }
    const version =
      a[ANN.architectureVersion] ??
      latestVersion(
        await fromHub(() => hub.architectureVersions(namespace, id)),
      );
    if (!version) {
      throw new NotFoundError(
        `Architecture ${namespace}/${id} has no versions`,
      );
    }
    return {
      architecture: await fromHub(() =>
        hub.architecture(namespace, id, version),
      ),
      ref: { namespace, architecture: id, version },
    };
  }

  /** The architecture file of a service published from a pattern: next to the catalog-info.yaml the catalog read. */
  async function fileArchitecture(
    entity: Entity,
  ): Promise<{ architecture: unknown; path: string }> {
    const a = entity.metadata.annotations ?? {};
    const location = a['backstage.io/managed-by-location'] ?? '';
    if (!location.startsWith('file:')) {
      throw new NotAllowedError(
        `${stringifyEntityRef(entity)} does not come from a file location`,
      );
    }
    const file = path.resolve(
      path.dirname(location.slice('file:'.length)),
      a[ANN.architectureFile],
    );
    // Throws NotAllowedError for a file outside calm.publish.localDir.
    const safe = resolveSafeChildPath(localDir, path.relative(localDir, file));
    try {
      return {
        architecture: JSON.parse(await fs.readFile(safe, 'utf-8')),
        path: path.relative(localDir, safe),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`No architecture file at ${safe}`);
      }
      throw new InputError(
        `Cannot read the architecture file ${safe}: ${(e as Error).message}`,
      );
    }
  }

  router.get('/architecture', async (req, res) => {
    const entity = await entityFrom(req);
    const a = entity.metadata.annotations ?? {};
    if (!a[ANN.architecture] && !a[ANN.architectureFile]) {
      throw new NotFoundError(
        `${stringifyEntityRef(entity)} has neither ${ANN.architecture} nor ${
          ANN.architectureFile
        }`,
      );
    }

    // The cluster read (a kubectl call, up to its timeout) runs while the architecture and the recorded deployments
    // are read. Both undefined for an entity without the Kubernetes annotations.
    const deploymentRead = readDeployment(
      entity,
      options.kubernetes,
      logger.child({ task: 'deployment' }),
    );

    // The Hub first, when the entity names a Hub architecture. A service registered in the Hub keeps its file,
    // which is read when the Hub does not give the document.
    let fromTheHub: Awaited<ReturnType<typeof hubArchitecture>>;
    try {
      fromTheHub = await hubArchitecture(entity);
    } catch (e) {
      if (!a[ANN.architectureFile]) {
        throw e;
      }
      logger.warn(
        `${stringifyEntityRef(entity)}: reading ${
          a[ANN.architectureFile]
        } because CALM Hub did not give the architecture: ${
          (e as Error).message ?? e
        }`,
      );
    }
    const fromFile = fromTheHub ? undefined : await fileArchitecture(entity);
    const [deployment, deployments] = await Promise.all([
      deploymentRead,
      fromTheHub
        ? readRecordedDeployments(
            hub,
            fromTheHub.ref,
            logger.child({ task: 'hub-deployments' }),
          )
        : undefined,
    ]);
    const body: ArchitectureResponse = {
      architecture: fromTheHub?.architecture ?? fromFile?.architecture,
      source: fromTheHub
        ? {
            type: 'hub',
            url: `${hub.baseUrl}${architectureVersionPath(
              fromTheHub.ref.namespace,
              fromTheHub.ref.architecture,
              fromTheHub.ref.version,
            )}`,
            version: fromTheHub.ref.version,
          }
        : { type: 'file', path: fromFile!.path },
      ...(deployment ? { deployment } : {}),
      ...(deployments ? { deployments } : {}),
    };
    res.json(body);
  });

  router.get('/pattern', async (req, res) => {
    const entity = await entityFrom(req);
    const a = entity.metadata.annotations ?? {};
    const namespace = a[ANN.namespace];
    const id = a[ANN.pattern];
    if (!namespace || !id) {
      throw new NotFoundError(
        `${stringifyEntityRef(entity)} has no ${ANN.namespace} and ${
          ANN.pattern
        } annotations`,
      );
    }
    const version =
      a[ANN.patternVersion] ??
      latestVersion(await fromHub(() => hub.patternVersions(namespace, id)));
    if (!version) {
      throw new NotFoundError(`Pattern ${namespace}/${id} has no versions`);
    }
    const doc = await fromHub(() => hub.pattern(namespace, id, version));
    const credentials = await httpAuth.credentials(req);

    // The bundles the catalog provider emitted from config + calm-backstage.json, matched as the Template matches them.
    const { items } = await catalog.getEntities(
      {
        filter: {
          kind: 'Resource',
          'spec.type': TYPES.bundle,
          [`metadata.annotations.${ANN.pattern}`]: id,
        },
      },
      { credentials },
    );
    const bundles = items
      .filter(
        b =>
          (b.metadata.annotations?.[ANN.namespace] ?? namespace) === namespace,
      )
      .map(b => ({
        entityRef: stringifyEntityRef(b),
        name: b.metadata.annotations?.[ANN.bundle] ?? b.metadata.name,
        version: b.metadata.annotations?.[ANN.bundleVersion] ?? '',
        title: b.metadata.title,
        description: b.metadata.description,
      }))
      .sort((x, y) => compareVersions(x.version, y.version));

    const templateRef = `template:default/${templateEntityName(id)}`;
    const template = await catalog.getEntityByRef(templateRef, {
      credentials,
    });

    const body: PatternResponse = {
      pattern: {
        namespace,
        id,
        version,
        title: typeof doc?.title === 'string' ? doc.title : undefined,
        url: `${hub.baseUrl}/calm/namespaces/${enc(namespace)}/patterns/${enc(
          id,
        )}/versions/${enc(version)}`,
      },
      decisions: readPatternDecisions(doc),
      bundles,
      ...(template ? { templateRef } : {}),
    };
    res.json(body);
  });

  router.post('/placeholders', async (req, res) => {
    const { patternUrl, choices } = (req.body ?? {}) as PlaceholdersRequest;
    if (typeof patternUrl !== 'string' || !patternUrl.startsWith(hubPrefix)) {
      throw new InputError(
        `patternUrl must be a CALM Hub URL under ${hubPrefix}`,
      );
    }
    if (choices !== undefined && !isRecord(choices)) {
      throw new InputError('choices must be an object keyed by decision id');
    }
    let optionChoices: Record<string, string | string[]>;
    try {
      optionChoices = normaliseChoices(choices ?? {});
    } catch (e) {
      throw new InputError((e as Error).message);
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-placeholders-'));
    try {
      const result = await generateArchitecture({
        patternUrl,
        hubUrl: options.hubUrl,
        choices: optionChoices,
        dir,
        logger: logger.child({ task: 'placeholders' }),
      });
      const body: PlaceholdersResponse = {
        placeholders: scanPlaceholders(result.architecture),
        nodeCount: result.nodeCount,
        relationshipCount: result.relationshipCount,
      };
      res.json(body);
    } catch (e) {
      if (e instanceof CalmCliError) {
        // A bad choice or an unreadable pattern: the CLI's own words, for the form.
        throw new InputError(e.message);
      }
      throw e;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  return router;
}
