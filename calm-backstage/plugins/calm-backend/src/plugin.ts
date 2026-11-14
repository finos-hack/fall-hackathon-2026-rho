import path from 'node:path';
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createRouter } from './router';

export const calmPlugin = createBackendPlugin({
  pluginId: 'calm',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        catalog: catalogServiceRef,
      },
      async init({ config, logger, httpRouter, httpAuth, catalog }) {
        const hubUrl = config.getString('calm.hubUrl');
        // Same folder as calm:publish:local (relative to the backend's working directory, packages/backend).
        const localDir = path.resolve(
          config.getOptionalString('calm.publish.localDir') ?? '../../output',
        );
        // Default auth policy: every route needs a user or service token.
        httpRouter.use(
          await createRouter({ hubUrl, logger, catalog, httpAuth, localDir }),
        );
      },
    });
  },
});
