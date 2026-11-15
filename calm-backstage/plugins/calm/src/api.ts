import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import type {
  PatternDecision,
  RecordedDeployment,
} from '@internal/backstage-plugin-calm-common';

/** Response of calm-backend `GET /architecture`. */
export interface ArchitectureResponse {
  architecture: any;
  /** CALM Hub (with the version read), or the published service's own file. */
  source:
    | { type: 'hub'; url: string; version?: string }
    | { type: 'file'; path: string };
  /** A published service's deployment in the local cluster; absent when it is not deployed or was not read. */
  deployment?: {
    cluster: string;
    namespace: string;
    networkPolicies: {
      name: string;
      relationship?: string;
      protocol?: string;
    }[];
    workloads: { name: string; ready: boolean }[];
  };
  /** The deployments CALM Hub holds for the architecture version (deployment decorators), newest first. */
  deployments?: RecordedDeployment[];
  /** For a service deployed through Git: its Flux Kustomization's status and the commit it applied. */
  gitops?: {
    kustomization: string;
    ready: boolean;
    message: string;
    commit?: string;
    repoUrl?: string;
    commitUrl?: string;
  };
}

/** One version of a bundle in calm-backend `GET /bundles`. */
export interface ExplorerBundleVersion {
  version: string;
  ref: string;
  digest: string;
  size?: number;
  created?: string;
  source?: string;
  revision?: string;
  description?: string;
  runtime?: string;
  patterns: { namespace?: string; patternId: string }[];
}

/** Response of calm-backend `GET /bundles`. */
export interface BundlesResponse {
  bundles: {
    name: string;
    kind: 'starter' | 'deployment' | 'full';
    versions: ExplorerBundleVersion[];
  }[];
}

/** Response of calm-backend `GET /bundles/:name/diff`. */
export interface BundleDiffResponse {
  from: string;
  to: string;
  files: {
    path: string;
    status: 'added' | 'removed' | 'changed';
    patch: string;
  }[];
}

/** Response of calm-backend `GET /upgrades`. */
export interface UpgradesResponse {
  inGit: boolean;
  kind: 'starter' | 'full' | 'none';
  starter?: { name: string; from: string; to?: string };
  deploy?: { name: string; from: string; to?: string };
  upgradePath?: string;
  note?: string;
}

/** Response of calm-backend `GET /pattern`. */
export interface PatternResponse {
  pattern: {
    namespace: string;
    id: string;
    version: string;
    title?: string;
    url: string;
  };
  decisions: PatternDecision[];
  bundles: {
    entityRef: string;
    name: string;
    version: string;
    title?: string;
    description?: string;
  }[];
  templateRef?: string;
}

interface State<T> {
  loading: boolean;
  value?: T;
  error?: Error;
}

/** GET a calm-backend route with the user's token. `path` undefined means nothing to load. */
export function useCalmBackend<T>(
  path: string | undefined,
  opts: { text?: boolean } = {},
): State<T> {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [state, setState] = useState<State<T>>({ loading: !!path });

  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return undefined;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      const base = await discovery.getBaseUrl('calm');
      const res = await fetch(`${base}${path}`);
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.json())?.error?.message ?? '';
        } catch {
          // no JSON body
        }
        throw new Error(
          `calm-backend answered ${res.status}${detail ? `: ${detail}` : ''}`,
        );
      }
      return (opts.text ? await res.text() : await res.json()) as T;
    })().then(
      value => !cancelled && setState({ loading: false, value }),
      error => !cancelled && setState({ loading: false, error }),
    );
    return () => {
      cancelled = true;
    };
  }, [discovery, fetch, path, opts.text]);

  return state;
}
