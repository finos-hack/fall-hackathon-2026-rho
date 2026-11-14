import fs from 'node:fs/promises';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  CalmHubWriteClient,
  DEPLOYMENT_DECORATOR_TYPE,
  DEPLOYMENT_STATUSES,
  DeploymentStatus,
  architectureVersionPath,
  architectureVersionUiTarget,
  deploymentDecorator,
} from '@internal/backstage-plugin-calm-common';

/** The node `unique-id`s among the workloads: a workload is named after the node it was rendered from. */
export function deployedNodes(
  workloads: string[],
  architecture: unknown,
): string[] {
  const nodes: any[] = Array.isArray((architecture as any)?.nodes)
    ? (architecture as any).nodes
    : [];
  const ids = new Set(nodes.map(n => n?.['unique-id']));
  return workloads.filter(w => ids.has(w));
}

/**
 * `calm:decorate:deployment`: records one deployment of a service in CALM Hub, as a deployment decorator on the
 * architecture version `calm:register:hub` stored.
 */
export function createCalmDecorateDeploymentAction(options: {
  hub: CalmHubWriteClient;
  /** `app.baseUrl`: the decorator's `deployment-details` is the service's page there. */
  appBaseUrl: string;
}) {
  const { hub } = options;
  return createTemplateAction({
    id: 'calm:decorate:deployment',
    description:
      "Records a deployment in CALM Hub: posts one deployment decorator (draft deployment standard) that targets the architecture version and applies to the deployed nodes, with the status, the start and end time, the cluster and namespace in the notes and the service's Backstage page as deployment-details. No dry run: its inputs come from calm:deploy:k8s, which a dry run skips.",
    schema: {
      input: {
        hubNamespace: z =>
          z
            .string()
            .describe(
              'Hub namespace of the architecture (calm:register:hub output namespace)',
            ),
        architecture: z =>
          z
            .string()
            .describe(
              'Architecture name in the Hub (calm:register:hub output architecture)',
            ),
        version: z =>
          z
            .string()
            .describe(
              'Architecture version (calm:register:hub output version)',
            ),
        name: z => z.string().describe('Service name'),
        cluster: z =>
          z.string().describe('The cluster (kubectl context) deployed to'),
        namespace: z => z.string().describe('The Kubernetes namespace'),
        workloads: z =>
          z
            .array(z.string())
            .describe(
              'Deployment names (calm:deploy:k8s output deployments); those that are node ids become applies-to',
            ),
        architecturePath: z =>
          z
            .string()
            .optional()
            .describe(
              'Architecture file, relative to the workspace, to check the workloads against its node ids. Default architecture.json',
            ),
        startTime: z =>
          z.string().describe('When the deployment started (ISO 8601)'),
        endTime: z =>
          z
            .string()
            .optional()
            .describe('When the deployment ended (ISO 8601)'),
        status: z =>
          z.enum(DEPLOYMENT_STATUSES).optional().describe('Default completed'),
      },
      output: {
        id: z =>
          z
            .number()
            .optional()
            .describe("The decorator's id in the Hub; none in a dry run"),
        uniqueId: z => z.string().describe("The decorator's unique-id"),
        target: z =>
          z
            .string()
            .describe(
              'The decorator target: the path of the architecture version in the Hub',
            ),
        url: z =>
          z.string().optional().describe("The decorator's Hub URL (JSON)"),
      },
    },
    async handler(ctx) {
      const { hubNamespace, architecture, version, name, cluster, namespace } =
        ctx.input;
      const status: DeploymentStatus = ctx.input.status ?? 'completed';
      const target = architectureVersionPath(
        hubNamespace,
        architecture,
        version,
      );

      const file = resolveSafeChildPath(
        ctx.workspacePath,
        ctx.input.architecturePath ?? 'architecture.json',
      );
      const doc = JSON.parse(await fs.readFile(file, 'utf-8'));
      const appliesTo = deployedNodes(ctx.input.workloads, doc);
      const notNodes = ctx.input.workloads.filter(w => !appliesTo.includes(w));
      if (notNodes.length) {
        ctx.logger.warn(
          `Not nodes of the architecture, so left out of applies-to: ${notNodes.join(
            ', ',
          )}`,
        );
      }
      if (!appliesTo.length) {
        throw new Error(
          `None of the workloads (${ctx.input.workloads.join(
            ', ',
          )}) is a node of the architecture, so there is nothing for the decorator to apply to`,
        );
      }

      // CALM Hub's UI finds an architecture's decorators by its numeric id, so name that target as well.
      const numericId = (await hub.architectures(hubNamespace)).find(
        a => a.customId === architecture,
      )?.numericId;
      if (numericId === undefined) {
        ctx.logger.warn(
          `CALM Hub lists no numeric id for ${hubNamespace}/${architecture}, so its Deployments tab will not show this deployment`,
        );
      }
      const extraTargets =
        numericId === undefined
          ? []
          : [architectureVersionUiTarget(hubNamespace, numericId, version)];

      // One decorator per run: the task id, or the time when the action runs outside a task.
      const uniqueId = `${name}-${ctx.task?.id ?? Date.now()}`;
      const decorator = deploymentDecorator({
        uniqueId,
        target,
        extraTargets,
        appliesTo,
        status,
        startTime: ctx.input.startTime,
        endTime: ctx.input.endTime,
        details: `${options.appBaseUrl.replace(
          /\/+$/,
          '',
        )}/catalog/default/component/${encodeURIComponent(name)}`,
        // The workloads are in applies-to.
        notes: `Deployed by Backstage to the cluster ${cluster}, namespace ${namespace}.`,
      });
      ctx.output('uniqueId', uniqueId);
      ctx.output('target', target);
      const id = await hub.createDecorator(hubNamespace, decorator);
      // Read it back the way the architecture card does: by the target filter, then by id.
      const found = await hub.listDecorators(hubNamespace, {
        target,
        type: DEPLOYMENT_DECORATOR_TYPE,
      });
      const back = await hub.getDecorator(hubNamespace, id);
      if (!found.includes(id) || back.uniqueId !== uniqueId) {
        throw new Error(
          `CALM Hub stored the decorator ${id}, but it is not read back for the target ${target} (found ${JSON.stringify(
            found,
          )}, unique-id ${JSON.stringify(back.uniqueId)})`,
        );
      }
      const url = `${hub.baseUrl}/api/calm/namespaces/${encodeURIComponent(
        hubNamespace,
      )}/decorators/${id}`;
      ctx.logger.info(
        `Recorded the deployment in CALM Hub as decorator ${id} (${uniqueId}) on ${target}, applies to ${appliesTo.join(
          ', ',
        )}: ${url}`,
      );
      ctx.output('id', id);
      ctx.output('url', url);
    },
  });
}
