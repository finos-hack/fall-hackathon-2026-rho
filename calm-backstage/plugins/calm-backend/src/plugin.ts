import os from 'node:os';
import path from 'node:path';
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import {
  readBundleRegistrySettings,
  readKubernetesDeploySettings,
  readPublishLocalDir,
} from '@internal/backstage-plugin-calm-node';
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
        // Same folder as calm:publish:local.
        const localDir = readPublishLocalDir(config);
        // Default auth policy: every route needs a user or service token, except "Open the running app": the browser
        // opens it in a new tab, which carries no Backstage token. It reaches only the api-gateway Service of a
        // namespace a CALM deploy action made (see appProxy.ts). Local development only.
        httpRouter.addAuthPolicy({ path: '/app', allow: 'unauthenticated' });
        httpRouter.use(
          await createRouter({
            hubUrl,
            logger,
            catalog,
            httpAuth,
            localDir,
            // The cluster calm:deploy:k8s deploys to; the architecture card shows what a service has there.
            kubernetes: readKubernetesDeploySettings(config),
            registry: readBundleRegistrySettings(config),
            // The scaffolder's bundle cache: one pull per digest.
            bundleCacheDir: path.join(
              config.getOptionalString('backend.workingDirectory') ?? os.tmpdir(),
              'calm-bundles',
            ),
          }),
        );
      },
    });
  },
});
