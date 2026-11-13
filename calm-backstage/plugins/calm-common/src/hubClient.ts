/*
 * A read-only CALM Hub client. Modelled on `calm-plugins/vscode/src/extension/services/hub-client.ts` in
 * https://github.com/finos/architecture-as-code (no auth here: the hackathon Hub runs the `no-auth` profile).
 *
 * Documents are read through the name-based `/calm/...` API because it returns each document's `$id` (the numeric
 * `/api/calm/...` reads do not). Lists come back as `{ "values": [...] }` and are unwrapped.
 * Shapes checked against calm-hub 0.7.7 (`/q/openapi`).
 */

export type FetchLike = (
  url: string,
  init?: any,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export class CalmHubError extends Error {
  constructor(readonly status: number, readonly url: string, message: string) {
    super(message);
    this.name = 'CalmHubError';
  }
}

/** A document id within a namespace, as the name-based list returns it. */
export interface CalmHubResourceSummary {
  customId: string;
  namespace: string;
  numericId?: number;
  resourceType?: string;
}

export interface CalmHubControlSummary {
  id: number;
  name: string;
  title?: string;
  description?: string;
}

export interface CalmHubConfigurationSummary {
  id: number;
  name: string;
}

export interface CalmHubImplementation {
  architectureId?: number;
  customId: string;
  namespace: string;
  version: string;
}

const enc = encodeURIComponent;

/** Compares dotted versions numerically (`1.10.0` > `1.9.0`); a pre-release suffix sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = a.split('-', 2);
  const [bCore, bPre] = b.split('-', 2);
  const aParts = aCore.split('.').map(n => parseInt(n, 10) || 0);
  const bParts = bCore.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (aPre === bPre) {
    return 0;
  }
  if (aPre === undefined) {
    return 1;
  }
  if (bPre === undefined) {
    return -1;
  }
  return aPre < bPre ? -1 : 1;
}

/** The highest version in a list, or undefined for an empty list. */
export function latestVersion(versions: string[]): string | undefined {
  return [...versions].sort(compareVersions).pop();
}

export class CalmHubClient {
  readonly baseUrl: string;
  private readonly fetchImpl?: FetchLike;

  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  /** GET a path under the base URL, or an absolute URL (a document `$id`, a `requirement-url`). */
  async get<T = any>(pathOrUrl: string): Promise<T> {
    const url = /^https?:\/\//.test(pathOrUrl)
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const doFetch: FetchLike =
      this.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    const res = await doFetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        // no body
      }
      throw new CalmHubError(
        res.status,
        url,
        `GET ${url} -> ${res.status}${body ? `: ${body}` : ''}`,
      );
    }
    return res.json();
  }

  private async values<T>(path: string): Promise<T[]> {
    const data = await this.get<any>(path);
    if (Array.isArray(data)) {
      return data;
    }
    return Array.isArray(data?.values) ? data.values : [];
  }

  // Namespaces

  async namespaces(): Promise<string[]> {
    const list = await this.values<{ name: string }>('/api/calm/namespaces');
    return list.map(n => n.name);
  }

  // Patterns

  async patterns(namespace: string): Promise<CalmHubResourceSummary[]> {
    return this.values(`/calm/namespaces/${enc(namespace)}/patterns`);
  }

  async patternVersions(namespace: string, id: string): Promise<string[]> {
    return this.values(
      `/calm/namespaces/${enc(namespace)}/patterns/${enc(id)}/versions`,
    );
  }

  async pattern(namespace: string, id: string, version: string): Promise<any> {
    return this.get(
      `/calm/namespaces/${enc(namespace)}/patterns/${enc(id)}/versions/${enc(
        version,
      )}`,
    );
  }

  /** Architectures whose `$schema` is this pattern version. */
  async patternImplementations(
    namespace: string,
    id: string,
    version: string,
  ): Promise<CalmHubImplementation[]> {
    const data = await this.get<any>(
      `/calm/namespaces/${enc(namespace)}/patterns/${enc(id)}/versions/${enc(
        version,
      )}/implementations`,
    );
    return Array.isArray(data?.implementations) ? data.implementations : [];
  }

  // Architectures

  async architectures(namespace: string): Promise<CalmHubResourceSummary[]> {
    return this.values(`/calm/namespaces/${enc(namespace)}/architectures`);
  }

  async architectureVersions(namespace: string, id: string): Promise<string[]> {
    return this.values(
      `/calm/namespaces/${enc(namespace)}/architectures/${enc(id)}/versions`,
    );
  }

  async architecture(
    namespace: string,
    id: string,
    version: string,
  ): Promise<any> {
    return this.get(
      `/calm/namespaces/${enc(namespace)}/architectures/${enc(
        id,
      )}/versions/${enc(version)}`,
    );
  }

  // Controls

  async domains(): Promise<string[]> {
    return this.values('/calm/domains');
  }

  async controls(domain: string): Promise<CalmHubControlSummary[]> {
    return this.values(`/calm/domains/${enc(domain)}/controls`);
  }

  async controlRequirementVersions(
    domain: string,
    control: string,
  ): Promise<string[]> {
    return this.values(
      `/calm/domains/${enc(domain)}/controls/${enc(
        control,
      )}/requirement/versions`,
    );
  }

  async controlRequirement(
    domain: string,
    control: string,
    version: string,
  ): Promise<any> {
    return this.get(
      `/calm/domains/${enc(domain)}/controls/${enc(
        control,
      )}/requirement/versions/${enc(version)}`,
    );
  }

  async controlConfigurations(
    domain: string,
    control: string,
  ): Promise<CalmHubConfigurationSummary[]> {
    return this.values(
      `/calm/domains/${enc(domain)}/controls/${enc(control)}/configurations`,
    );
  }

  async controlConfigurationVersions(
    domain: string,
    control: string,
    configuration: string,
  ): Promise<string[]> {
    return this.values(
      `/calm/domains/${enc(domain)}/controls/${enc(
        control,
      )}/configurations/${enc(configuration)}/versions`,
    );
  }

  async controlConfiguration(
    domain: string,
    control: string,
    configuration: string,
    version: string,
  ): Promise<any> {
    return this.get(
      `/calm/domains/${enc(domain)}/controls/${enc(
        control,
      )}/configurations/${enc(configuration)}/versions/${enc(version)}`,
    );
  }
}

const PATTERN_URL =
  /\/calm\/namespaces\/([^/]+)\/patterns\/([^/]+)\/versions\/([^/?#]+)$/;
const REQUIREMENT_URL =
  /\/calm\/domains\/([^/]+)\/controls\/([^/]+)\/requirement\/versions\/([^/?#]+)$/;

/** Splits a Hub pattern URL (an architecture's `$schema`) into namespace, id and version. */
export function parsePatternUrl(
  url: unknown,
): { namespace: string; id: string; version: string } | undefined {
  const m = typeof url === 'string' ? PATTERN_URL.exec(url) : null;
  return m
    ? {
        namespace: decodeURIComponent(m[1]),
        id: decodeURIComponent(m[2]),
        version: decodeURIComponent(m[3]),
      }
    : undefined;
}

/** Splits a Hub control requirement URL into domain, control name and version. */
export function parseRequirementUrl(
  url: unknown,
): { domain: string; control: string; version: string } | undefined {
  const m = typeof url === 'string' ? REQUIREMENT_URL.exec(url) : null;
  return m
    ? {
        domain: decodeURIComponent(m[1]),
        control: decodeURIComponent(m[2]),
        version: decodeURIComponent(m[3]),
      }
    : undefined;
}

/** Every `requirement-url` in a CALM document (as a string or a `{ const }` in a pattern). */
export function requirementUrls(
  doc: unknown,
  out = new Set<string>(),
): string[] {
  if (Array.isArray(doc)) {
    doc.forEach(d => requirementUrls(d, out));
  } else if (doc && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc as Record<string, any>)) {
      if (key === 'requirement-url' && typeof value === 'string') {
        out.add(value);
      } else if (
        key === 'requirement-url' &&
        typeof value?.const === 'string'
      ) {
        out.add(value.const);
      } else {
        requirementUrls(value, out);
      }
    }
  }
  return [...out];
}
