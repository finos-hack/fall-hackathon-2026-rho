/*
 * `calm.gitops`: the Git server that holds each service's repository and the bundle sources, as Backstage reaches it
 * and as Flux in the cluster reaches it. Without it the Template deploys with kubectl apply (part 2).
 */
import type { RootConfigService } from '@backstage/backend-plugin-api';
import type { GitAuth } from './git';

export interface GitopsSettings {
  /** Base URL Backstage and the browser use, e.g. `http://localhost:3300`. */
  gitUrl: string;
  /** Base URL Flux in the cluster uses for the same server, e.g. `http://host.minikube.internal:3300`. */
  clusterGitUrl: string;
  /** Organisation of the service repositories. */
  servicesOrg: string;
  /** `<org>/<repo>` of the bundle sources. */
  templatesRepo: string;
  branch: string;
  auth: GitAuth;
}

const trim = (u: string) => u.replace(/\/+$/, '');

/** Reads `calm.gitops`; undefined when it is not configured. */
export function readGitopsSettings(
  config: RootConfigService,
): GitopsSettings | undefined {
  const g = config.getOptionalConfig('calm.gitops');
  if (!g) {
    return undefined;
  }
  const gitUrl = trim(g.getString('gitUrl'));
  return {
    gitUrl,
    clusterGitUrl: trim(g.getOptionalString('clusterGitUrl') ?? gitUrl),
    servicesOrg: g.getOptionalString('servicesOrg') ?? 'calm-services',
    templatesRepo:
      g.getOptionalString('templatesRepo') ?? 'calm-templates/bundles',
    branch: g.getOptionalString('branch') ?? 'main',
    auth: {
      username: g.getString('username'),
      password: g.getString('password'),
    },
  };
}

/** The URLs of a service's repository: to push to, to link to, and for Flux to clone. */
export function serviceRepository(
  s: GitopsSettings,
  name: string,
): { pushUrl: string; webUrl: string; clusterUrl: string } {
  const repo = `${s.servicesOrg}/${encodeURIComponent(name)}`;
  return {
    pushUrl: `${s.gitUrl}/${repo}.git`,
    webUrl: `${s.gitUrl}/${repo}`,
    clusterUrl: `${s.clusterGitUrl}/${repo}.git`,
  };
}
