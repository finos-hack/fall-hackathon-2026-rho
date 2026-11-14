/*
 * What a template bundle says about itself in `calm-backstage.json`: its kind, the patterns it fits, and what it runs
 * on. Shared by the catalog provider, the scaffolder actions and the Template Explorer.
 */
import { compareVersions } from './hubClient';

/**
 * - `starter`: the code a service begins with (and its Dockerfile); deployed with a `deployment` bundle.
 * - `deployment`: deployment rules: renders `deploy/k8s` from the architecture alone, for any starter.
 * - `full`: renders both (the bundles from parts 1 and 2).
 */
export type BundleKind = 'starter' | 'deployment' | 'full';

export const BUNDLE_KINDS: BundleKind[] = ['starter', 'deployment', 'full'];

export interface BundlePatternRef {
  namespace?: string;
  patternId: string;
  version?: string;
  url?: string;
}

export interface BundleMeta {
  name: string;
  version: string;
  kind: BundleKind;
  description?: string;
  /** What a starter runs on, e.g. "Spring Boot 4.0.9 on Java 21". */
  runtime?: string;
  /** `kubernetes` when the bundle's output can be deployed (every deployment bundle; full bundles that say so). */
  deploy?: string;
  patterns: BundlePatternRef[];
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function patternRef(v: any): BundlePatternRef | undefined {
  const patternId = str(v?.patternId);
  if (!patternId) {
    return undefined;
  }
  return {
    patternId,
    ...(str(v.namespace) ? { namespace: v.namespace } : {}),
    ...(str(v.version) ? { version: v.version } : {}),
    ...(str(v.url) ? { url: v.url } : {}),
  };
}

/**
 * Reads a `calm-backstage.json`. A bundle without `kind` is `full` (the older bundles). `patterns` (a list) and the
 * older single `pattern` are both read. A deployment bundle can always be deployed to Kubernetes.
 */
export function readBundleMeta(
  json: any,
  fallback: { name?: string; version?: string } = {},
): BundleMeta {
  const kind: BundleKind = BUNDLE_KINDS.includes(json?.kind)
    ? json.kind
    : 'full';
  const patterns = [
    ...(Array.isArray(json?.patterns) ? json.patterns : []),
    ...(json?.pattern ? [json.pattern] : []),
  ]
    .map(patternRef)
    .filter((p): p is BundlePatternRef => p !== undefined);
  const deploy = kind === 'deployment' ? 'kubernetes' : str(json?.deploy);
  return {
    name: str(json?.name) ?? fallback.name ?? '',
    version: str(json?.version) ?? fallback.version ?? '',
    kind,
    patterns,
    ...(str(json?.description) ? { description: json.description } : {}),
    ...(str(json?.runtime) ? { runtime: json.runtime } : {}),
    ...(deploy ? { deploy } : {}),
  };
}

/** True when the bundle names the pattern (the namespace must match when the bundle gives one). */
export function fitsPattern(
  meta: Pick<BundleMeta, 'patterns'>,
  namespace: string | undefined,
  patternId: string,
): boolean {
  return meta.patterns.some(
    p =>
      p.patternId === patternId &&
      (!p.namespace || !namespace || p.namespace === namespace),
  );
}

/** The newest version of the bundle `name` that fits the pattern, or undefined. */
export function newestFitting<T extends BundleMeta>(
  all: T[],
  name: string,
  namespace: string | undefined,
  patternId: string,
): T | undefined {
  return all
    .filter(b => b.name === name && fitsPattern(b, namespace, patternId))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}
