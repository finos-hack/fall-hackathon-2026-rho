/*
 * The deployments CALM Hub holds for an architecture version: its deployment decorators, for the architecture card.
 */
import type { LoggerService } from '@backstage/backend-plugin-api';
import {
  CalmHubClient,
  DEPLOYMENT_DECORATOR_TYPE,
  RecordedDeployment,
  architectureVersionPath,
  newestFirst,
  recordedDeployment,
} from '@internal/backstage-plugin-calm-common';

/** At most this many decorators are read for one architecture version (the newest: the highest ids). */
export const MAX_DEPLOYMENTS = 20;

/**
 * The deployment decorators that target the architecture version, newest first. The Hub lists ids for an exact
 * `target`, here the version's path in the name-based API, and each decorator is then read by id. A failed read
 * gives a warning and an empty list: the card still shows the architecture.
 */
export async function readRecordedDeployments(
  hub: CalmHubClient,
  ref: { namespace: string; architecture: string; version: string },
  logger: LoggerService,
): Promise<RecordedDeployment[]> {
  const target = architectureVersionPath(
    ref.namespace,
    ref.architecture,
    ref.version,
  );
  try {
    const ids = await hub.listDecorators(ref.namespace, {
      target,
      type: DEPLOYMENT_DECORATOR_TYPE,
    });
    const newest = [...ids].sort((a, b) => b - a).slice(0, MAX_DEPLOYMENTS);
    const decorators = await Promise.all(
      newest.map(id => hub.getDecorator(ref.namespace, id)),
    );
    return newestFirst(decorators.map(recordedDeployment));
  } catch (e) {
    logger.warn(
      `The deployments recorded in CALM Hub for ${target} were not read: ${
        (e as Error).message ?? e
      }`,
    );
    return [];
  }
}
