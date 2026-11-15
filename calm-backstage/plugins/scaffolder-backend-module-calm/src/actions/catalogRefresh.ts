import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

/** `calm:catalog:refresh`: asks the catalog to read an entity again now (after its catalog-info.yaml changed). */
export function createCalmCatalogRefreshAction(options: {
  catalog: CatalogService;
}) {
  return createTemplateAction({
    id: 'calm:catalog:refresh',
    description: 'Asks the catalog to refresh an entity now.',
    schema: {
      input: { entityRef: z => z.string().describe('The entity to refresh') },
    },
    async handler(ctx) {
      const ref = stringifyEntityRef(parseEntityRef(ctx.input.entityRef));
      await options.catalog.refreshEntity(ref, {
        credentials: await ctx.getInitiatorCredentials(),
      });
      ctx.logger.info(`Asked the catalog to refresh ${ref}`);
    },
  });
}
