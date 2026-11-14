import fs from 'node:fs/promises';
import path from 'node:path';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { publishedFolder } from './publishedFolder';
import {
  CALM_KUBERNETES,
  KUBERNETES_ID_LABEL,
  deployNamespace,
} from '@internal/backstage-plugin-calm-common';
import {
  KubernetesDeploySettings,
  kubectlCommand,
  requireKubernetesDeploy,
  runKubectl,
} from '@internal/backstage-plugin-calm-node';
import YAML from 'yaml';

/** The image name the bundle's manifests use; the overlay replaces it with the image built for this service. */
export const PLACEHOLDER_IMAGE = 'calm-service';
/** The bundle's kustomize base and the overlay written next to it, relative to the published folder. */
export const BASE_DIR = 'deploy/k8s';
export const OVERLAY_DIR = 'deploy/k8s-overlay';
const NAMESPACE_FILE = 'namespace.yaml';
const ROLLOUT_TIMEOUT = '300s';

/** Splits `<name>:<tag>`; the tag is required, so an image is never deployed as `latest` by omission. */
export function parseImage(image: string): { newName: string; newTag: string } {
  const colon = image.lastIndexOf(':');
  const newName = image.slice(0, colon);
  const newTag = image.slice(colon + 1);
  if (colon <= 0 || !newTag || newTag.includes('/') || newTag === 'latest') {
    throw new Error(
      `Image must be <name>:<tag> with a tag other than latest, got ${JSON.stringify(
        image,
      )}`,
    );
  }
  return { newName, newTag };
}

/** The Namespace of a service: found again by the Kubernetes plugin's label, and marked as made for this service. */
export function namespaceManifest(name: string, namespace: string): object {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: {
        [KUBERNETES_ID_LABEL]: name,
        [CALM_KUBERNETES.serviceLabel]: name,
      },
    },
  };
}

/**
 * The overlay over the bundle's kustomize base: the namespace, the image built for this service in place of the
 * bundle's placeholder, and the `backstage.io/kubernetes-id` label on every object and pod template (not on
 * selectors, so the bundle's own selectors and NetworkPolicy peers stay as rendered).
 */
export function overlayKustomization(opts: {
  name: string;
  namespace: string;
  image: string;
}): object {
  const { newName, newTag } = parseImage(opts.image);
  return {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace: opts.namespace,
    resources: [NAMESPACE_FILE, `../${path.posix.basename(BASE_DIR)}`],
    images: [{ name: PLACEHOLDER_IMAGE, newName, newTag }],
    labels: [
      { pairs: { [KUBERNETES_ID_LABEL]: opts.name }, includeTemplates: true },
    ],
  };
}

/**
 * Refuses a namespace that exists and was not made for this service: only a namespace labelled
 * `calm.finos.org/service: <name>` is deployed into again. `existing` is the Namespace object, or undefined.
 */
export function checkExistingNamespace(
  namespace: string,
  name: string,
  existing: any,
): void {
  if (!existing) {
    return;
  }
  const owner = existing?.metadata?.labels?.[CALM_KUBERNETES.serviceLabel];
  if (owner !== name) {
    throw new Error(
      `The namespace ${namespace} already exists and ${
        owner
          ? `belongs to the service ${JSON.stringify(owner)}`
          : `has no ${CALM_KUBERNETES.serviceLabel} label, so calm:deploy:k8s did not create it`
      }; refusing to deploy ${JSON.stringify(name)} into it`,
    );
  }
}

/** `kubectl apply` arguments for the overlay. */
export function applyArgs(overlayDir: string): string[] {
  return ['apply', '-k', overlayDir];
}

interface Deployed {
  deployments: string[];
  networkPolicies: string[];
  services: string[];
}

/** Names of the Deployments and NetworkPolicies, and `<name>:<port>` of the Services, in a list of objects. */
export function summariseObjects(items: any[]): Deployed {
  const names = (kind: string) =>
    items
      .filter(i => i?.kind === kind)
      .map(i => String(i.metadata?.name))
      .sort();
  return {
    deployments: names('Deployment'),
    networkPolicies: names('NetworkPolicy'),
    services: items
      .filter(i => i?.kind === 'Service')
      .flatMap(i =>
        (i.spec?.ports ?? []).map((p: any) => `${i.metadata?.name}:${p.port}`),
      )
      .sort(),
  };
}

/**
 * `calm:deploy:k8s`: deploys a published service to the local cluster. Writes a kustomize overlay next to the
 * bundle's base (`deploy/k8s-overlay`), applies it into the namespace `<namespacePrefix><name>` and waits for every
 * Deployment to roll out.
 */
export function createCalmDeployK8sAction(options: {
  /** `calm.deploy.kubernetes`; undefined when it is not configured. */
  settings?: KubernetesDeploySettings;
  /** Absolute path of `calm.publish.localDir`: only folders inside it are deployed. */
  localDir: string;
}) {
  return createTemplateAction({
    id: 'calm:deploy:k8s',
    description:
      "Deploys a published service folder to the local cluster (calm.deploy.kubernetes): writes the overlay deploy/k8s-overlay over the bundle's kustomize base deploy/k8s, runs kubectl apply -k into the namespace <namespacePrefix><name> and waits for the rollouts. Needs the cluster from `yarn k8s:up`. No dry run: its inputs come from calm:publish:local and calm:image:build, which a dry run skips.",
    schema: {
      input: {
        dir: z =>
          z
            .string()
            .describe(
              'The published folder (calm:publish:local output path), inside calm.publish.localDir; it holds deploy/k8s',
            ),
        name: z =>
          z
            .string()
            .describe(
              'Service name: lower-case letters, digits and hyphens. Names the namespace and the backstage.io/kubernetes-id label',
            ),
        image: z =>
          z
            .string()
            .describe(
              'Image for the service, as <name>:<tag> (calm:image:build output image)',
            ),
      },
      output: {
        namespace: z => z.string(),
        deployments: z => z.array(z.string()).describe('Deployment names'),
        networkPolicies: z =>
          z.array(z.string()).describe('NetworkPolicy names'),
        services: z =>
          z.array(z.string()).describe('Services, as <name>:<port>'),
        kubectl: z =>
          z
            .string()
            .describe(
              'The kubectl command line for this cluster and namespace, to copy',
            ),
        cluster: z => z.string().describe('The kubectl context deployed to'),
        startTime: z =>
          z.string().describe('When the apply started (ISO 8601)'),
        endTime: z =>
          z.string().describe('When the last rollout finished (ISO 8601)'),
      },
    },
    async handler(ctx) {
      const settings = await requireKubernetesDeploy(options.settings);
      const { name, image } = ctx.input;
      const namespace = deployNamespace(settings.namespacePrefix, name);
      const dir = publishedFolder(options.localDir, ctx.input.dir);
      const base = path.join(dir, BASE_DIR);
      const hasBase = await fs
        .stat(path.join(base, 'kustomization.yaml'))
        .then(() => true)
        .catch(() => false);
      if (!hasBase) {
        throw new Error(
          `${base} has no kustomization.yaml: the template bundle did not render Kubernetes manifests`,
        );
      }

      const overlayDir = path.join(dir, OVERLAY_DIR);
      await fs.mkdir(overlayDir, { recursive: true });
      await fs.writeFile(
        path.join(overlayDir, NAMESPACE_FILE),
        YAML.stringify(namespaceManifest(name, namespace)),
      );
      await fs.writeFile(
        path.join(overlayDir, 'kustomization.yaml'),
        `# Written by calm:deploy:k8s. Apply by hand: kubectl apply -k ${OVERLAY_DIR}\n${YAML.stringify(
          overlayKustomization({ name, namespace, image }),
        )}`,
      );
      ctx.logger.info(`Wrote the overlay ${overlayDir}`);

      const run = { cwd: dir, logger: ctx.logger, signal: ctx.signal };
      const quiet = { ...run, quietStdout: true };
      const existing = (
        await runKubectl(
          settings,
          ['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json'],
          quiet,
        )
      ).stdout.trim();
      checkExistingNamespace(
        namespace,
        name,
        existing ? JSON.parse(existing) : undefined,
      );

      const args = applyArgs(overlayDir);
      ctx.logger.info(kubectlCommand(settings, args));
      const startTime = new Date().toISOString();
      await runKubectl(settings, args, run);

      const listed = await runKubectl(
        settings,
        [
          '-n',
          namespace,
          'get',
          'deployments,networkpolicies,services',
          '-o',
          'json',
        ],
        quiet,
      );
      const deployed = summariseObjects(JSON.parse(listed.stdout).items ?? []);
      for (const deployment of deployed.deployments) {
        await runKubectl(
          settings,
          [
            '-n',
            namespace,
            'rollout',
            'status',
            `deployment/${deployment}`,
            `--timeout=${ROLLOUT_TIMEOUT}`,
          ],
          run,
        );
      }
      ctx.logger.info(
        `Deployed ${name} to ${settings.context} / ${namespace}: ${
          deployed.deployments.length
        } deployments (${deployed.deployments.join(', ')}), ${
          deployed.networkPolicies.length
        } network policies`,
      );
      ctx.output('namespace', namespace);
      ctx.output('deployments', deployed.deployments);
      ctx.output('networkPolicies', deployed.networkPolicies);
      ctx.output('services', deployed.services);
      ctx.output('kubectl', kubectlCommand(settings, ['-n', namespace]));
      ctx.output('cluster', settings.context);
      ctx.output('startTime', startTime);
      ctx.output('endTime', new Date().toISOString());
    },
  });
}
