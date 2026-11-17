import os from 'node:os';
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
import { createCalmImageBuildAction } from './actions/imageBuild';
import { createCalmDeployK8sAction } from './actions/deployK8s';
import { createCalmClusterCheckAction } from './actions/clusterCheck';
import { createCalmRegisterHubAction } from './actions/registerHub';
import { createCalmDecorateDeploymentAction } from './actions/decorateDeployment';
import { createCalmGitPublishAction } from './actions/gitPublish';
import { createCalmDeployGitopsAction } from './actions/deployGitops';
import {
  createCalmUpgradeRenderAction,
  defaultRenderInto,
} from './actions/upgradeRender';
import { createCalmUpgradeMergeAction } from './actions/upgradeMerge';
import { createCalmCatalogRefreshAction } from './actions/catalogRefresh';
import { createCalmImportDrawioAction } from './actions/importDrawio';
import { createCalmImportStoreAction } from './actions/importStore';
import fs from 'node:fs/promises';
import {
  BundleMeta,
  CalmHubWriteClient,
  readBundleMeta,
} from '@internal/backstage-plugin-calm-common';
import {
  DEFAULT_NAMESPACE_PREFIX,
  calmBin,
  listRegistryBundles,
  readBundleRegistrySettings,
  readGitopsSettings,
  readKubernetesDeploySettings,
  readPublishLocalDir,
} from '@internal/backstage-plugin-calm-node';

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
        auth: coreServices.auth,
      },
      async init({ scaffolder, config, logger, catalog, auth }) {
        const hubUrl = config.getString('calm.hubUrl');
        // Paths in calm config are relative to the backend's working directory (packages/backend).
        const bundles = (
          config.getOptionalConfigArray('calm.bundles') ?? []
        ).map(b => ({
          name: b.getString('name'),
          version: b.getString('version'),
          path: path.resolve(b.getString('path')),
        }));
        const registry = readBundleRegistrySettings(config);
        // Registry bundles are pulled once per digest into the backend's temp folder (the scaffolder's own
        // working directory when one is configured).
        const cacheDir = path.join(
          config.getOptionalString('backend.workingDirectory') ?? os.tmpdir(),
          'calm-bundles',
        );
        const localDir = readPublishLocalDir(config);
        // The one cluster calm:image:build and calm:deploy:k8s work on; without it both refuse to run.
        const kubernetes = readKubernetesDeploySettings(config);
        logger.info(
          kubernetes
            ? `calm:image:build and calm:deploy:k8s use kubeconfig ${kubernetes.kubeconfig}, context ${kubernetes.context}, minikube profile ${kubernetes.minikubeProfile}, namespaces ${kubernetes.namespacePrefix}<name>`
            : 'calm:image:build and calm:deploy:k8s: no calm.deploy.kubernetes kubeconfig and context, so both refuse to run',
        );
        // The Git server each service is pushed to and Flux deploys from; without it the Template uses kubectl apply.
        const gitops = readGitopsSettings(config);
        logger.info(
          gitops
            ? `calm:git:publish and calm:deploy:gitops push to ${gitops.gitUrl}/${gitops.servicesOrg}/<name>; Flux clones ${gitops.clusterGitUrl}`
            : 'calm:git:publish and calm:deploy:gitops: no calm.gitops, so both refuse to run',
        );
        // Where calm:register:hub stores the architectures of new services, and calm:decorate:deployment their
        // deployments.
        const hub = new CalmHubWriteClient(hubUrl);
        const hubNamespace =
          config.getOptionalString('calm.publish.hubNamespace') ?? 'hackathon';
        logger.info(
          `calm:register:hub and calm:decorate:deployment write to ${hub.baseUrl}, namespace ${hubNamespace}`,
        );
        logger.info(`calm CLI bin: ${process.execPath} ${calmBin()}`);
        logger.info(`calm:publish:local writes to ${localDir}`);
        logger.info(
          registry
            ? `calm:template pulls bundles from ${registry.url} (${registry.repositoryPrefix}/…) into ${cacheDir}`
            : 'calm:template: no calm.bundleRegistry, local calm.bundles only',
        );
        scaffolder.addActions(
          createCalmGenerateAction({ hubUrl }),
          createCalmFillAction(),
          createCalmValidateAction({ hubUrl }),
          createCalmRegisterHubAction({
            hub,
            namespace: hubNamespace,
            catalog,
            auth,
            localDir,
          }),
          createCalmTemplateAction({ bundles, registry, cacheDir }),
          createCalmPublishLocalAction({
            catalog,
            auth,
            localDir,
            namespacePrefix:
              kubernetes?.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX,
          }),
          createCalmClusterCheckAction({ settings: kubernetes }),
          createCalmImageBuildAction({ settings: kubernetes, localDir }),
          createCalmDeployK8sAction({
            settings: kubernetes,
            localDir,
            hub,
            appBaseUrl: config.getString('app.baseUrl'),
          }),
          createCalmDecorateDeploymentAction({
            hub,
            appBaseUrl: config.getString('app.baseUrl'),
          }),
          createCalmGitPublishAction({ settings: gitops, localDir }),
          createCalmUpgradeRenderAction({
            catalog,
            gitops,
            localDir,
            listBundles: async () => {
              const local: BundleMeta[] = [];
              for (const b of bundles) {
                const json = await fs
                  .readFile(path.join(b.path, 'calm-backstage.json'), 'utf-8')
                  .then(t => JSON.parse(t))
                  .catch(() => undefined);
                if (json) {
                  local.push({
                    ...readBundleMeta(json, b),
                    name: b.name,
                    version: b.version,
                  });
                }
              }
              const fromRegistry = registry
                ? (await listRegistryBundles(registry)).bundles
                : [];
              return [...local, ...fromRegistry];
            },
            renderInto: defaultRenderInto({ bundles, registry, cacheDir }),
            // The architecture an upgrade renders from: CALM Hub is its only store.
            hub,
          }),
          createCalmUpgradeMergeAction({
            gitops,
            settings: kubernetes,
            localDir,
          }),
          createCalmCatalogRefreshAction({ catalog }),
          createCalmDeployGitopsAction({
            settings: kubernetes,
            gitops,
            localDir,
            hub,
            appBaseUrl: config.getString('app.baseUrl'),
          }),
          createCalmRegisterLocalAction({ catalog, auth, localDir }),
          createCalmImportDrawioAction({
            hub,
            namespace: hubNamespace,
            catalog,
            auth,
          }),
          createCalmImportStoreAction({
            hub,
            namespace: hubNamespace,
            catalog,
            auth,
          }),
        );
      },
    });
  },
});
