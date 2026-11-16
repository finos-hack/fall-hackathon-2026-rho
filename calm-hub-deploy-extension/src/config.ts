import path from 'node:path';
import type { GitopsSettings, KubernetesDeploySettings } from '@internal/backstage-plugin-calm-node';

export type Approval = 'auto' | 'manual';

export interface Settings {
  /** Port the backend listens on (CALM Hub's backend-url points here). */
  port: number;
  /** CALM Hub base URL as this process reaches it (JWKS, decorators, architectures). */
  hubUrl: string;
  /** `iss` CALM Hub signs with: its calm.hub.base-url. */
  hubIssuer: string;
  /** The extension id: the `aud` of every assertion. */
  extensionId: string;
  /** Name of the one environment this instance deploys to, recorded on every deployment. */
  environment: string;
  /** auto: merge the pull request at once. manual: wait until someone merges it in Gitea (the change gate). */
  approval: Approval;
  approvalTimeoutMs: number;
  fluxTimeoutMs: number;
  /** Working copies of the service repositories, one folder per service (owned by deploy jobs only). */
  workDir: string;
  bundleCacheDir: string;
  gitops: GitopsSettings;
  kubernetes: KubernetesDeploySettings;
  registry: { url: string; repositoryPrefix: string };
  /** CALM Hub namespaces whose services this instance deploys (DEPLOY_NAMESPACES, comma-separated). */
  deployNamespaces: string[];
  /** The manifest the route table is built from. */
  manifestPath: string;
}

const trim = (u: string) => u.replace(/\/+$/, '');

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/**
 * Reads the settings from the environment. Defaults match calm-backstage's local stack (app-config.yaml): Hub on
 * :8090, Gitea on :3300 (user calm), the bundle registry on :5050 and the minikube profile calm-backstage with its
 * kubeconfig in ../calm-backstage/.kube/config.
 */
export function readSettings(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = path.resolve(__dirname, '..'),
): Settings {
  const approval = (env.APPROVAL ?? 'auto') as Approval;
  if (approval !== 'auto' && approval !== 'manual') {
    throw new Error(`APPROVAL must be auto or manual, got ${JSON.stringify(env.APPROVAL)}`);
  }
  const gitUrl = trim(env.GITEA_URL ?? 'http://localhost:3300');
  const hubUrl = trim(env.CALM_HUB_URL ?? 'http://localhost:8090');
  const resolve = (p: string) => path.resolve(baseDir, p);
  return {
    port: int(env.PORT, 8093, 'PORT'),
    hubUrl,
    hubIssuer: env.CALM_HUB_ISSUER ?? hubUrl,
    extensionId: env.EXTENSION_ID ?? 'platform-connector',
    environment: env.DEPLOY_ENVIRONMENT ?? 'local',
    approval,
    approvalTimeoutMs: int(env.APPROVAL_TIMEOUT_SECONDS, 1800, 'APPROVAL_TIMEOUT_SECONDS') * 1000,
    fluxTimeoutMs: int(env.FLUX_TIMEOUT_SECONDS, 300, 'FLUX_TIMEOUT_SECONDS') * 1000,
    workDir: resolve(env.WORK_DIR ?? '.work'),
    bundleCacheDir: resolve(env.BUNDLE_CACHE_DIR ?? '.work/bundles'),
    gitops: {
      gitUrl,
      clusterGitUrl: trim(env.GITEA_CLUSTER_URL ?? 'http://host.minikube.internal:3300'),
      servicesOrg: env.GITEA_SERVICES_ORG ?? 'calm-services',
      templatesRepo: env.GITEA_TEMPLATES_REPO ?? 'calm-templates/bundles',
      branch: env.GITEA_BRANCH ?? 'main',
      auth: { username: env.GITEA_USER ?? 'calm', password: env.GITEA_PASSWORD ?? 'calm-local-dev' },
    },
    kubernetes: {
      kubeconfig: resolve(env.CALM_KUBECONFIG ?? '../calm-backstage/.kube/config'),
      context: env.CALM_KUBE_CONTEXT ?? 'calm-backstage',
      minikubeProfile: env.CALM_MINIKUBE_PROFILE ?? 'calm-backstage',
      namespacePrefix: env.CALM_NAMESPACE_PREFIX ?? 'calm-',
    },
    registry: {
      url: env.BUNDLE_REGISTRY_URL ?? 'http://localhost:5050',
      repositoryPrefix: env.BUNDLE_REPOSITORY_PREFIX ?? 'calm-bundles',
    },
    deployNamespaces: (env.DEPLOY_NAMESPACES ?? 'hackathon')
      .split(',')
      .map(n => n.trim())
      .filter(Boolean),
    manifestPath: resolve(env.MANIFEST ?? 'extension/platform-connector/extension.json'),
  };
}
