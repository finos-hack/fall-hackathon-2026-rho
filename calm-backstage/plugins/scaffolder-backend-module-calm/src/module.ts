import path from 'node:path';
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createCalmGenerateAction } from './actions/generate';
import { createCalmFillAction } from './actions/fill';
import { createCalmValidateAction } from './actions/validate';
import { createCalmTemplateAction } from './actions/template';
import { createCalmPublishLocalAction } from './actions/publishLocal';
import { createCalmRegisterLocalAction } from './actions/registerLocal';
import { calmBin } from '@internal/backstage-plugin-calm-node';

export const scaffolderModuleCalm = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'calm',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        catalog: catalogServiceRef,
      },
      async init({ scaffolder, config, logger, catalog }) {
        const hubUrl = config.getString('calm.hubUrl');
        // Paths in calm config are relative to the backend's working directory (packages/backend).
        const bundles = (
          config.getOptionalConfigArray('calm.bundles') ?? []
        ).map(b => ({
          name: b.getString('name'),
          version: b.getString('version'),
          path: path.resolve(b.getString('path')),
        }));
        const localDir = path.resolve(
          config.getOptionalString('calm.publish.localDir') ?? '../../output',
        );
        logger.info(`calm CLI bin: ${process.execPath} ${calmBin()}`);
        logger.info(`calm:publish:local writes to ${localDir}`);
        scaffolder.addActions(
          createCalmGenerateAction({ hubUrl }),
          createCalmFillAction(),
          createCalmValidateAction({ hubUrl }),
          createCalmTemplateAction({ bundles }),
          createCalmPublishLocalAction({ localDir }),
          createCalmRegisterLocalAction({ catalog, localDir }),
        );
      },
    });
  },
});
