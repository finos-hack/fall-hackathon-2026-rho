import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { publishedFolder } from './publishedFolder';
import {
  CALM_KUBERNETES,
  CalmHubWriteClient,
  KUBERNETES_ID_LABEL,
  deployNamespace,
  namespaceManifest,
  workloadNode,
} from '@internal/backstage-plugin-calm-common';
import {
  KubernetesDeploySettings,
  KubernetesRunOptions,
  kubectlCommand,
  requireKubernetesDeploy,
  runKubectl,
} from '@internal/backstage-plugin-calm-node';
import YAML from 'yaml';
import { recordFailedDeployment } from './recordFailure';

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

/**
 * The overlay over the bundle's kustomize base: the namespace, the image built for this service in place of the
 * bundle's placeholder, and the `backstage.io/kubernetes-id` label on every object and pod template (not on
 * selectors, so the bundle's own selectors and NetworkPolicy peers stay as rendered). It lists the Namespace object
 * (`namespace.yaml`) unless `withNamespace` is false.
 */
export function overlayKustomization(opts: {
  name: string;
  namespace: string;
  image: string;
  withNamespace?: boolean;
}): object {
  const { newName, newTag } = parseImage(opts.image);
  const base = `../${path.posix.basename(BASE_DIR)}`;
  return {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace: opts.namespace,
    resources: opts.withNamespace === false ? [base] : [NAMESPACE_FILE, base],
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

/** The first line of an overlay Flux applies: the same for every action that writes it, so rewriting it is no change. */
export const GITOPS_OVERLAY_HEADER = `# Written by Backstage (calm:deploy:gitops, calm:upgrade:merge). Flux applies this folder (${OVERLAY_DIR}) from Git.`;

/** Throws unless `<dir>/deploy/k8s` holds a kustomize base (a bundle that rendered Kubernetes manifests). */
export async function requireBase(dir: string): Promise<void> {
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
}

/**
 * Writes `deploy/k8s-overlay` (the namespace and the kustomization over the bundle's base) in a published folder and
 * returns its path. `header` is the comment line at the top of the kustomization. With `withNamespace: false` the
 * overlay leaves the Namespace out and a `namespace.yaml` an earlier deploy wrote is deleted: Flux applies the
 * overlay as a service account that cannot create Namespaces, so `calm:deploy:gitops` applies it instead.
 */
export async function writeOverlay(
  dir: string,
  opts: { name: string; namespace: string; image: string },
  header: string,
  { withNamespace = true }: { withNamespace?: boolean } = {},
): Promise<string> {
  const overlayDir = path.join(dir, OVERLAY_DIR);
  await fs.mkdir(overlayDir, { recursive: true });
  const namespaceFile = path.join(overlayDir, NAMESPACE_FILE);
  if (withNamespace) {
    await fs.writeFile(
      namespaceFile,
      YAML.stringify(namespaceManifest(opts.name, opts.namespace)),
    );
  } else {
    await fs.rm(namespaceFile, { force: true });
  }
  await fs.writeFile(
    path.join(overlayDir, 'kustomization.yaml'),
    `${header}\n${YAML.stringify(
      overlayKustomization({ ...opts, withNamespace }),
    )}`,
  );
  return overlayDir;
}

/** The image the overlay deploys (`<newName>:<newTag>` of its `calm-service` entry), or undefined without one. */
export async function readOverlayImage(
  dir: string,
): Promise<string | undefined> {
  const text = await fs
    .readFile(path.join(dir, OVERLAY_DIR, 'kustomization.yaml'), 'utf-8')
    .catch(() => undefined);
  const entry = text
    ? (YAML.parse(text)?.images ?? []).find(
        (i: any) => i?.name === PLACEHOLDER_IMAGE,
      )
    : undefined;
  return entry?.newName && entry?.newTag
    ? `${entry.newName}:${entry.newTag}`
    : undefined;
}

/** Runs kubectl with the given arguments and returns stdout (quiet: stdout is data, kept out of the log). */
export type Kubectl = (args: string[], quiet?: boolean) => Promise<string>;

/** A `Kubectl` that runs kubectl against the configured cluster in `cwd`. */
export function clusterKubectl(
  settings: KubernetesDeploySettings,
  opts: Omit<KubernetesRunOptions, 'quietStdout'>,
): Kubectl {
  return async (args, quiet) =>
    (await runKubectl(settings, args, { ...opts, quietStdout: quiet })).stdout;
}

/** Reads the Namespace `namespace` and refuses it when it exists and was not made for the service `name`. */
export async function checkNamespace(
  kubectl: Kubectl,
  namespace: string,
  name: string,
): Promise<void> {
  const existing = (
    await kubectl(
      ['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json'],
      true,
    )
  ).trim();
  checkExistingNamespace(
    namespace,
    name,
    existing ? JSON.parse(existing) : undefined,
  );
}

/** The field manager `applyObjects` uses with `serverSide`: not one of kubectl's, which Flux takes over. */
const FIELD_MANAGER = 'calm-backstage';

/**
 * Applies `objects` with `kubectl apply -f` from a temporary file: they are cluster state, not part of a repository.
 * With `serverSide`, it uses server-side apply under the field manager `FIELD_MANAGER`: Flux's kustomize-controller
 * takes over the fields that kubectl's own managers own on objects it applies, and can drop them.
 */
export async function applyObjects(
  kubectl: Kubectl,
  objects: object[],
  options: { serverSide?: boolean } = {},
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-objects-'));
  try {
    const file = path.join(tmp, 'objects.yaml');
    await fs.writeFile(
      file,
      objects.map(o => `---\n${YAML.stringify(o)}`).join(''),
    );
    await kubectl([
      'apply',
      ...(options.serverSide
        ? [
            '--server-side',
            `--field-manager=${FIELD_MANAGER}`,
            '--force-conflicts',
          ]
        : []),
      '-f',
      file,
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Lists the Deployments, NetworkPolicies and Services in `namespace` and waits for every Deployment to roll out. */
export async function listAndWaitForRollouts(
  kubectl: Kubectl,
  namespace: string,
): Promise<Deployed> {
  const listed = await kubectl(
    [
      '-n',
      namespace,
      'get',
      'deployments,networkpolicies,services',
      '-o',
      'json',
    ],
    true,
  );
  const deployed = summariseObjects(JSON.parse(listed).items ?? []);
  for (const deployment of deployed.deployments) {
    await kubectl([
      '-n',
      namespace,
      'rollout',
      'status',
      `deployment/${deployment}`,
      `--timeout=${ROLLOUT_TIMEOUT}`,
    ]);
  }
  return deployed;
}

/**
 * What a deploy of the bundle in `dir` would apply, read offline from the YAML files of its `deploy/k8s` base:
 * the same summary a real deploy gets from the cluster, and a `Kind/name` list of the objects.
 */
export async function planFromBase(
  dir: string,
): Promise<{ deployed: Deployed; objects: string[] }> {
  const baseDir = path.join(dir, BASE_DIR);
  const files = (await fs.readdir(baseDir))
    .filter(f => /\.ya?ml$/.test(f) && f !== 'kustomization.yaml')
    .sort();
  const items: any[] = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(baseDir, f), 'utf-8');
    items.push(
      ...YAML.parseAllDocuments(text)
        .map(d => d.toJS())
        .filter(d => d?.kind),
    );
  }
  return {
    deployed: summariseObjects(items),
    objects: items.map(i => `${i.kind}/${i.metadata?.name ?? '?'}`),
  };
}

export interface Deployed {
  deployments: string[];
  /** The nodes the Deployments were rendered from, each once: `workloadNode`, else the Deployment's name. */
  nodes: string[];
  networkPolicies: string[];
  services: string[];
}

/**
 * Names of the Deployments and NetworkPolicies, the nodes the Deployments were rendered from, and `<name>:<port>` of
 * the Services, in a list of objects.
 */
export function summariseObjects(items: any[]): Deployed {
  const names = (kind: string) =>
    items
      .filter(i => i?.kind === kind)
      .map(i => String(i.metadata?.name))
      .sort();
  return {
    deployments: names('Deployment'),
    nodes: [
      ...new Set(
        items
          .filter(i => i?.kind === 'Deployment')
          .map(i => workloadNode(i) ?? String(i.metadata?.name)),
      ),
    ].sort(),
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
  /** The Hub to record a failed deployment in; without it `record` only logs a warning. */
  hub?: CalmHubWriteClient;
  /** `app.baseUrl`: see calm:decorate:deployment. */
  appBaseUrl?: string;
  /** For tests: kubectl. */
  kubectl?: (settings: KubernetesDeploySettings, cwd: string) => Kubectl;
}) {
  return createTemplateAction({
    id: 'calm:deploy:k8s',
    supportsDryRun: true,
    description:
      "Deploys a published service folder to the local cluster (calm.deploy.kubernetes): writes the overlay deploy/k8s-overlay over the bundle's kustomize base deploy/k8s, runs kubectl apply -k into the namespace <namespacePrefix><name> and waits for the rollouts. Needs the cluster from `yarn k8s:up`. In a dry run it writes the overlay in the dry-run folder and logs the objects and the kubectl command, without calling the cluster; the outputs come from the rendered manifests.",
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
        record: z =>
          z
            .object({
              hubNamespace: z.string(),
              architecture: z.string(),
              version: z.string(),
              architecturePath: z.string().optional(),
            })
            .optional()
            .describe(
              'The architecture version in CALM Hub (calm:register:hub output). When set and the deployment fails after it started (from kubectl apply on: the apply, the rollouts), a deployment decorator with the status failed is recorded there, and the error is thrown as before',
            ),
      },
      output: {
        namespace: z => z.string(),
        deployments: z => z.array(z.string()).describe('Deployment names'),
        nodes: z =>
          z
            .array(z.string())
            .describe(
              'The node unique-id each Deployment was rendered from (its calm.finos.org/unique-id annotation, else its name)',
            ),
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
      const dir = publishedFolder(
        options.localDir,
        ctx.input.dir,
        ctx.isDryRun ? { dryRunWorkspace: ctx.workspacePath } : undefined,
      );
      await requireBase(dir);

      if (ctx.isDryRun) {
        const overlayDir = await writeOverlay(
          dir,
          { name, namespace, image },
          `# Written by calm:deploy:k8s. Apply by hand: kubectl apply -k ${OVERLAY_DIR}`,
        );
        const { deployed, objects } = await planFromBase(dir);
        ctx.logger.info(`Wrote the overlay ${overlayDir}`);
        ctx.logger.info(
          `Dry run: would apply ${
            objects.length
          } objects into ${namespace}: ${objects.join(', ')}`,
        );
        ctx.logger.info(
          `Dry run: would run ${kubectlCommand(
            settings,
            applyArgs(overlayDir),
          )}`,
        );
        const now = new Date().toISOString();
        ctx.output('namespace', namespace);
        ctx.output('deployments', deployed.deployments);
        ctx.output('nodes', deployed.nodes);
        ctx.output('networkPolicies', deployed.networkPolicies);
        ctx.output('services', deployed.services);
        ctx.output('kubectl', kubectlCommand(settings, ['-n', namespace]));
        ctx.output('cluster', settings.context);
        ctx.output('startTime', now);
        ctx.output('endTime', now);
        return;
      }

      const overlayDir = await writeOverlay(
        dir,
        { name, namespace, image },
        `# Written by calm:deploy:k8s. Apply by hand: kubectl apply -k ${OVERLAY_DIR}`,
      );
      ctx.logger.info(`Wrote the overlay ${overlayDir}`);

      const run = { cwd: dir, logger: ctx.logger, signal: ctx.signal };
      const quiet = { ...run, quietStdout: true };
      const kubectl: Kubectl = options.kubectl
        ? options.kubectl(settings, dir)
        : async (args, q) =>
            (await runKubectl(settings, args, q ? quiet : run)).stdout;
      const existing = (
        await kubectl(
          ['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json'],
          true,
        )
      ).trim();
      checkExistingNamespace(
        namespace,
        name,
        existing ? JSON.parse(existing) : undefined,
      );

      const args = applyArgs(overlayDir);
      ctx.logger.info(kubectlCommand(settings, args));
      const startTime = new Date().toISOString();
      let deployed: Deployed;
      try {
        await kubectl(args);
        deployed = await listAndWaitForRollouts(kubectl, namespace);
      } catch (error) {
        if (ctx.input.record) {
          await recordFailedDeployment({
            hub: options.hub,
            appBaseUrl: options.appBaseUrl,
            record: ctx.input.record,
            baseDir: path.join(dir, BASE_DIR),
            workspacePath: ctx.workspacePath,
            taskId: ctx.task?.id,
            name,
            cluster: settings.context,
            namespace,
            startTime,
            error,
            logger: ctx.logger,
            signal: ctx.signal,
          });
        }
        throw error;
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
      ctx.output('nodes', deployed.nodes);
      ctx.output('networkPolicies', deployed.networkPolicies);
      ctx.output('services', deployed.services);
      ctx.output('kubectl', kubectlCommand(settings, ['-n', namespace]));
      ctx.output('cluster', settings.context);
      ctx.output('startTime', startTime);
      ctx.output('endTime', new Date().toISOString());
    },
  });
}
