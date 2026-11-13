import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  catalogLocationsExtensionPoint,
  catalogProcessingExtensionPoint,
} from '@backstage/plugin-catalog-node';
import { CalmEntityProvider } from './provider';

export const catalogModuleCalm = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'calm',
  register(reg) {
    reg.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        locations: catalogLocationsExtensionPoint,
        config: coreServices.rootConfig,
        scheduler: coreServices.scheduler,
        logger: coreServices.logger,
      },
      async init({ catalog, locations, config, scheduler, logger }) {
        // calm:register:local adds `file` locations for services published to the local output folder. The catalog's
        // own default is `url` only.
        locations.setAllowedLocationTypes(['url', 'file']);
        const calm = config.getOptionalConfig('calm');
        if (!calm) {
          logger.warn('No calm config: the CALM entity provider is off');
          return;
        }
        const seconds = calm.getOptionalNumber('refreshSeconds') ?? 60;
        catalog.addEntityProvider(
          new CalmEntityProvider(
            {
              hubUrl: calm.getString('hubUrl'),
              namespaces: calm.getOptionalStringArray('namespaces') ?? [
                'hackathon',
              ],
              bundles: (calm.getOptionalConfigArray('bundles') ?? []).map(
                b => ({
                  name: b.getString('name'),
                  version: b.getString('version'),
                  path: b.getString('path'),
                }),
              ),
            },
            scheduler.createScheduledTaskRunner({
              frequency: { seconds },
              timeout: { seconds: Math.max(30, seconds) },
              initialDelay: { seconds: 3 },
            }),
            logger,
          ),
        );
      },
    });
  },
});
