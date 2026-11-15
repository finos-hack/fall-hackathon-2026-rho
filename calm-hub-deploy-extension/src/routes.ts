import fs from 'node:fs';

export interface ManifestRoute {
  id: string;
  method: string;
  path: string;
  scope: string;
  readOnly?: boolean;
}

interface CompiledRoute extends ManifestRoute {
  segments: { literal?: string; param?: string }[];
  literals: number;
}

export type Match =
  | { kind: 'route'; route: ManifestRoute; params: Record<string, string> }
  | { kind: 'method-not-allowed' }
  | { kind: 'not-found' };

/** Characters CALM Hub never lets through in a path value; refused here too, in case a request skips the Hub. */
const BAD_VALUE = /[/\\%@;]|\.\.|[\u0000-\u001f]/;

/**
 * Matches requests against the routes of the manifest (the one source of truth, so the backend and what CALM Hub
 * proxies cannot drift apart). Paths are matched exactly as received, segment by segment, without decoding, as CALM
 * Hub requires of a backend: `%2F` is not a slash, and a trailing slash is a different path. Like CALM Hub, a route
 * with more literal segments wins.
 */
export class RouteTable {
  private readonly routes: CompiledRoute[];

  constructor(routes: ManifestRoute[]) {
    this.routes = routes
      .map(r => {
        const segments = r.path
          .split('/')
          .slice(1)
          .map(s => (/^\{[A-Za-z][A-Za-z0-9]*\}$/.test(s) ? { param: s.slice(1, -1) } : { literal: s }));
        return { ...r, segments, literals: segments.filter(s => s.literal !== undefined).length };
      })
      .sort((a, b) => b.literals - a.literals);
  }

  static fromManifest(file: string): RouteTable {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return new RouteTable(manifest.routes ?? []);
  }

  match(method: string, pathname: string): Match {
    const parts = pathname.split('/').slice(1);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.segments.every((s, i) => {
        if (s.literal !== undefined) return s.literal === parts[i];
        if (!parts[i] || BAD_VALUE.test(parts[i])) return false;
        params[s.param!] = parts[i];
        return true;
      });
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { kind: 'route', route: r, params };
    }
    return pathMatched ? { kind: 'method-not-allowed' } : { kind: 'not-found' };
  }
}
