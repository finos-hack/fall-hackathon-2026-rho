import type { AuthService } from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import {
  CalmHubClient,
  CalmHubError,
} from '@internal/backstage-plugin-calm-common';
import { lookUpClaim } from './catalogClaim';

/** The name an imported architecture gets in CALM Hub and the catalog: lower case, digits and single hyphens. */
export const IMPORT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const IMPORT_NAME_MAX = 63;

/** Throws when `name` breaks the import name rule. */
export function assertImportName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length > IMPORT_NAME_MAX ||
    !IMPORT_NAME.test(name)
  ) {
    throw new Error(
      `The name ${JSON.stringify(
        name,
      )} is not allowed: a lower-case letter first, then lower-case letters, digits and single hyphens, at most ${IMPORT_NAME_MAX} characters`,
    );
  }
}

const LAST_SUGGESTION = 50;

/**
 * Why `name` cannot be the name of an imported architecture, or undefined when it is free. It is taken when CALM Hub
 * has an architecture with that id in `namespace`, or the catalog has `component:default/<name>` (read with the
 * backend's own credentials). The message suggests the first free `<name>-2` … `<name>-50`.
 */
export async function importNameClash(
  name: string,
  deps: {
    hub: Pick<CalmHubClient, 'architectures'>;
    namespace: string;
    catalog: Pick<CatalogService, 'getEntityByRef'>;
    auth: Pick<AuthService, 'getOwnServiceCredentials'>;
  },
): Promise<string | undefined> {
  const inHub = new Set(
    (await hubArchitectures(deps.hub, deps.namespace)).map(a =>
      a.customId.toLowerCase(),
    ),
  );
  const inCatalog = async (n: string) =>
    (await lookUpClaim(deps, `component:default/${n}`)).exists;

  const places = [
    ...(inHub.has(name) ? ['in CALM Hub'] : []),
    ...((await inCatalog(name)) ? ['in the catalog'] : []),
  ];
  if (places.length === 0) {
    return undefined;
  }
  const where = places.join(' and ');
  let suggestion: string | undefined;
  for (let i = 2; i <= LAST_SUGGESTION && !suggestion; i++) {
    const candidate = `${name}-${i}`;
    if (
      candidate.length <= IMPORT_NAME_MAX &&
      !inHub.has(candidate) &&
      !(await inCatalog(candidate))
    ) {
      suggestion = candidate;
    }
  }
  return `The name ${name} is already used (${where}); choose another${
    suggestion ? `, for example ${suggestion}` : ''
  }`;
}

/** The architectures of the namespace; a namespace the Hub does not have holds none. */
async function hubArchitectures(
  hub: Pick<CalmHubClient, 'architectures'>,
  namespace: string,
) {
  try {
    return await hub.architectures(namespace);
  } catch (e) {
    if (e instanceof CalmHubError && e.status === 404) {
      return [];
    }
    throw e;
  }
}
