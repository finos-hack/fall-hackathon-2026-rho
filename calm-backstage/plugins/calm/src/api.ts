import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import type { PatternDecision } from '@internal/backstage-plugin-calm-common';

/** Response of calm-backend `GET /architecture`. */
export interface ArchitectureResponse {
  architecture: any;
  source: { type: 'hub'; url: string } | { type: 'file'; path: string };
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
export function useCalmBackend<T>(path: string | undefined): State<T> {
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
      return (await res.json()) as T;
    })().then(
      value => !cancelled && setState({ loading: false, value }),
      error => !cancelled && setState({ loading: false, error }),
    );
    return () => {
      cancelled = true;
    };
  }, [discovery, fetch, path]);

  return state;
}
