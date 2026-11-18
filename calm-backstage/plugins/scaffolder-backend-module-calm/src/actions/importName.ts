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

/** The message for a Hub namespace (calm.publish.hubNamespace) that CALM Hub does not have. */
export const noNamespace = (namespace: string) =>
  `CALM Hub has no namespace ${namespace} (calm.publish.hubNamespace); create it in CALM Hub first. Nothing was stored`;

/**
 * Why `name` cannot be the name of an imported architecture, or undefined when it is free. It is taken when CALM Hub
 * has an architecture with that id in `namespace`, or the catalog has `component:default/<name>` (read with the
 * backend's own credentials). The message suggests the first free `<name>-2` … `<name>-50`, read from the catalog in
 * one query. Throws when CALM Hub does not have `namespace`.
 */
export async function importNameClash(
  name: string,
  deps: {
    hub: Pick<CalmHubClient, 'architectures' | 'namespaces'>;
    namespace: string;
    catalog: Pick<CatalogService, 'getEntityByRef' | 'getEntities'>;
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
  const candidates = Array.from(
    { length: LAST_SUGGESTION - 1 },
    (_, i) => `${name}-${i + 2}`,
  ).filter(c => c.length <= IMPORT_NAME_MAX && !inHub.has(c));
  const takenInCatalog = await catalogComponents(deps, candidates);
  const suggestion = candidates.find(c => !takenInCatalog.has(c));
  return `The name ${name} is already used (${where}); choose another${
    suggestion ? `, for example ${suggestion}` : ''
  }`;
}

/**
 * Which of `names` the catalog holds as `component:default/<name>`, in one query, read with the backend's own
 * credentials (as {@link lookUpClaim} reads the name itself).
 */
async function catalogComponents(
  deps: {
    catalog: Pick<CatalogService, 'getEntities'>;
    auth: Pick<AuthService, 'getOwnServiceCredentials'>;
  },
  names: string[],
): Promise<Set<string>> {
  if (names.length === 0) {
    return new Set();
  }
  const { items } = await deps.catalog.getEntities(
    {
      filter: {
        kind: 'Component',
        'metadata.namespace': 'default',
        'metadata.name': names,
      },
      fields: ['metadata.name'],
    },
    { credentials: await deps.auth.getOwnServiceCredentials() },
  );
  return new Set(items.map(e => e.metadata.name.toLowerCase()));
}

/**
 * The architectures of the namespace. The list answers 404 for a namespace the Hub does not have, and for one with no
 * architectures yet: the first is refused here, before anything is converted; the second holds none.
 */
async function hubArchitectures(
  hub: Pick<CalmHubClient, 'architectures' | 'namespaces'>,
  namespace: string,
) {
  try {
    return await hub.architectures(namespace);
  } catch (e) {
    if (e instanceof CalmHubError && e.status === 404) {
      if (!(await hub.namespaces()).includes(namespace)) {
        throw new Error(noNamespace(namespace));
      }
      return [];
    }
    throw e;
  }
}
