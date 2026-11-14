import type { AuthService } from '@backstage/backend-plugin-api';
import {
  ANNOTATION_LOCATION,
  stringifyLocationRef,
} from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';

/** The location ref the catalog writes in `backstage.io/managed-by-location` for a local `catalog-info.yaml`. */
export function fileLocationRef(target: string): string {
  return stringifyLocationRef({ type: 'file', target });
}

/**
 * Whether the catalog holds `entityRef`, and from where. The lookup runs with the backend's own credentials, not the
 * task user's: an entity the user may not read still blocks the name, since a new location could not claim it either.
 */
export async function lookUpClaim(
  options: {
    catalog: Pick<CatalogService, 'getEntityByRef'>;
    auth: Pick<AuthService, 'getOwnServiceCredentials'>;
  },
  entityRef: string,
): Promise<{ exists: boolean; location?: string }> {
  const existing = await options.catalog.getEntityByRef(entityRef, {
    credentials: await options.auth.getOwnServiceCredentials(),
  });
  return {
    exists: existing !== undefined,
    location: existing?.metadata.annotations?.[ANNOTATION_LOCATION],
  };
}

/**
 * Throws when the catalog holds `entityRef` from a location other than `wanted` (a location registered at `wanted`
 * could not claim it). Returns whether it is already held from `wanted`.
 */
export function assertClaimable(
  claim: { exists: boolean; location?: string },
  wanted: string,
  entityRef: string,
): boolean {
  if (!claim.exists) {
    return false;
  }
  if (claim.location === wanted) {
    return true;
  }
  throw new Error(
    `The catalog already has ${entityRef} (from ${
      claim.location ?? 'an unknown location'
    }); choose another service name`,
  );
}
