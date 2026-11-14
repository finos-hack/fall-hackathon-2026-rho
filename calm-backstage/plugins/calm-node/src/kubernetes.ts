/*
 * The one Kubernetes cluster the CALM plugins deploy to and read: the local minikube profile from `yarn k8s:up`,
 * named in `calm.deploy.kubernetes`. Every `kubectl` call made here names the kubeconfig and the context, and every
 * `minikube` call names the profile and runs with `KUBECONFIG` set, so the user's default kubeconfig, its current
 * context and other minikube profiles are never used.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { runProcess } from './process';

/** `calm.deploy.kubernetes`, with `kubeconfig` as an absolute path. */
export interface KubernetesDeploySettings {
  kubeconfig: string;
  context: string;
  minikubeProfile: string;
  /** A service `<name>` is deployed to the namespace `<namespacePrefix><name>`. */
  namespacePrefix: string;
}

export const DEFAULT_NAMESPACE_PREFIX = 'calm-';
const CONFIG_KEY = 'calm.deploy.kubernetes';

/**
 * Reads `calm.deploy.kubernetes`. Undefined when `kubeconfig` or `context` is not set: there is no default for
 * either, so nothing falls back to the user's own kubeconfig or current context. `kubeconfig` is relative to the
 * backend's working directory (packages/backend), as the other `calm` paths.
 */
export function readKubernetesDeploySettings(
  config: RootConfigService,
): KubernetesDeploySettings | undefined {
  const k = config.getOptionalConfig(CONFIG_KEY);
  const kubeconfig = k?.getOptionalString('kubeconfig');
  const context = k?.getOptionalString('context');
  if (!k || !kubeconfig || !context) {
    return undefined;
  }
  return {
    kubeconfig: path.resolve(kubeconfig),
    context,
    minikubeProfile: k.getOptionalString('minikubeProfile') ?? context,
    namespacePrefix:
      k.getOptionalString('namespacePrefix') ?? DEFAULT_NAMESPACE_PREFIX,
  };
}

/** The settings, once the kubeconfig file is known to exist. Throws with what to do otherwise. */
export async function requireKubernetesDeploy(
  settings: KubernetesDeploySettings | undefined,
): Promise<KubernetesDeploySettings> {
  if (!settings) {
    throw new Error(
      `${CONFIG_KEY}.kubeconfig and .context are not set, so there is no cluster to deploy to. Run \`yarn k8s:up\` and set them in app-config.yaml; the user's default kubeconfig is never used.`,
    );
  }
  const found = await fs
    .stat(settings.kubeconfig)
    .then(s => s.isFile())
    .catch(() => false);
  if (!found) {
    throw new Error(
      `The kubeconfig ${settings.kubeconfig} (${CONFIG_KEY}.kubeconfig) does not exist. Run \`yarn k8s:up\` to start the local cluster, which writes it; the user's default kubeconfig is never used.`,
    );
  }
  return settings;
}

/** `kubectl` arguments with the kubeconfig and context in front. */
export function kubectlArgs(
  settings: KubernetesDeploySettings,
  args: string[],
): string[] {
  return [
    '--kubeconfig',
    settings.kubeconfig,
    '--context',
    settings.context,
    ...args,
  ];
}

/** `minikube` arguments with the profile in front. */
export function minikubeArgs(
  settings: KubernetesDeploySettings,
  args: string[],
): string[] {
  return ['-p', settings.minikubeProfile, ...args];
}

/** The `kubectl` command line for this cluster, for a person to copy. */
export function kubectlCommand(
  settings: KubernetesDeploySettings,
  args: string[] = [],
): string {
  return ['kubectl', ...kubectlArgs(settings, args)].join(' ');
}

export interface KubernetesRunOptions {
  cwd: string;
  logger: LoggerService;
  signal?: AbortSignal;
  /** Keep stdout out of the log (it is still returned): for `-o json`. */
  quietStdout?: boolean;
}

/** Runs `kubectl --kubeconfig <file> --context <context> ...args`. */
export function runKubectl(
  settings: KubernetesDeploySettings,
  args: string[],
  opts: KubernetesRunOptions,
): Promise<{ stdout: string }> {
  return runProcess('kubectl', kubectlArgs(settings, args), opts);
}

/** Runs `minikube -p <profile> ...args` with `KUBECONFIG` set to the configured file. */
export function runMinikube(
  settings: KubernetesDeploySettings,
  args: string[],
  opts: KubernetesRunOptions,
): Promise<{ stdout: string }> {
  return runProcess('minikube', minikubeArgs(settings, args), {
    ...opts,
    env: { KUBECONFIG: settings.kubeconfig },
  });
}
