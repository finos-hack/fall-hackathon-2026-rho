import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { deployNamespace } from '@internal/backstage-plugin-calm-common';
import {
  KubernetesDeploySettings,
  requireKubernetesDeploy,
  runKubectl,
} from '@internal/backstage-plugin-calm-node';

/** What a person can do when the cluster is not there. */
export const NO_CLUSTER_HINT =
  'Start the local cluster with `yarn k8s:up` (then restart Backstage), or untick "Deploy to the local Kubernetes cluster" and run again.';

/**
 * `calm:cluster:check`: fails early when the local cluster cannot be reached, before the run stores anything in
 * CALM Hub or publishes files. The Template runs it first, under the same condition as the build and deploy steps.
 */
export function createCalmClusterCheckAction(options: {
  /** `calm.deploy.kubernetes`; undefined when it is not configured. */
  settings?: KubernetesDeploySettings;
}) {
  return createTemplateAction({
    id: 'calm:cluster:check',
    description:
      'Checks that the service name gives a valid namespace and that the local cluster in calm.deploy.kubernetes answers (kubectl get namespaces with a short timeout), so a run that will deploy fails before it writes anything.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .optional()
            .describe(
              'Service name: checked to give a valid namespace <namespacePrefix><name>',
            ),
      },
      output: {
        context: z => z.string().describe('The kubectl context checked'),
      },
    },
    async handler(ctx) {
      let settings: KubernetesDeploySettings;
      try {
        settings = await requireKubernetesDeploy(options.settings);
      } catch (e) {
        throw new Error(`${(e as Error).message} ${NO_CLUSTER_HINT}`);
      }
      if (ctx.input.name !== undefined) {
        // The form allows 63 characters, but the namespace adds the prefix: refuse here, before the Hub write.
        deployNamespace(settings.namespacePrefix, ctx.input.name);
      }
      try {
        await runKubectl(
          settings,
          ['get', 'namespaces', '--request-timeout=10s', '-o', 'name'],
          {
            cwd: ctx.workspacePath,
            logger: ctx.logger,
            signal: ctx.signal,
            quietStdout: true,
          },
        );
      } catch (e) {
        throw new Error(
          `The cluster ${settings.context} does not answer: ${
            (e as Error).message
          }\n${NO_CLUSTER_HINT}`,
        );
      }
      ctx.logger.info(`The cluster ${settings.context} answers`);
      ctx.output('context', settings.context);
    },
  });
}
