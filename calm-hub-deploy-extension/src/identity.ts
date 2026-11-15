// Verifies the identity assertion CALM Hub sends to an extension backend in X-Calm-Hub-Identity.
// Ported to TypeScript from finos/architecture-as-code calm-hub/local-dev/extensions/example-services/identity.mjs
// (Apache-2.0, commit 96fe3674), same checks in the same order.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

const ALGORITHMS: Record<string, { hash: string; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256' },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
};
export const CLOCK_SKEW_SECONDS = 30;

/** The claims CALM Hub puts in an assertion. */
export interface HubClaims {
  iss: string;
  aud: string;
  /** The caller; "no-auth" for every caller when CALM Hub runs without auth. */
  sub: string;
  /** none, oidc or proxy */
  auth?: string;
  iat: number;
  exp: number;
  /** Audit id of the call (CALM Hub audits calls to routes that are not readOnly). */
  jti: string;
  hubApi?: number;
  route?: string;
  scope?: string;
  /** The namespace CALM Hub checked the caller's scope on (read, write and admin routes only). */
  ns?: string;
  dom?: string;
  htm: string;
  htp: string;
  bdh?: string;
}

export interface Jwk {
  kid: string;
  alg: string;
  [k: string]: unknown;
}

export interface VerifierOptions {
  issuer: string;
  audience: string;
  /** Returns the JWKS; called again when a token names an unknown key id. */
  fetchJwks: () => Promise<{ keys: Jwk[] }>;
  now?: () => number;
}

export interface RequestFacts {
  method: string;
  /** Path and query exactly as received, relative to the backend URL. */
  pathAndQuery: string;
  /** The raw request body. */
  body?: Buffer | string;
}

export class AssertionError extends Error {}

function decode(part: string): any {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export type VerifyAssertion = (token: string | undefined, request: RequestFacts) => Promise<HubClaims>;

/** Returns a function that verifies one assertion and returns its claims, or throws an AssertionError. */
export function createVerifier({
  issuer,
  audience,
  fetchJwks,
  now = () => Date.now() / 1000,
}: VerifierOptions): VerifyAssertion {
  let keys = new Map<string, { alg: string; key: KeyObject }>();
  const seen = new Map<string, number>();

  async function loadKeys() {
    const { keys: jwks } = await fetchJwks();
    keys = new Map(
      jwks.map(jwk => [jwk.kid, { alg: jwk.alg, key: createPublicKey({ key: jwk as any, format: 'jwk' }) }]),
    );
  }

  return async function verifyAssertion(token, { method, pathAndQuery, body }) {
    const fail = (msg: string): never => {
      throw new AssertionError(msg);
    };
    const parts = token?.split('.');
    if (!parts || parts.length !== 3) fail('not a JWT');
    const [h, p, s] = parts!;
    let header: any;
    try {
      header = decode(h);
    } catch {
      fail('not a JWT');
    }
    if (header.typ !== 'calm-ext+jwt') fail('wrong typ');
    const algorithm = ALGORITHMS[header.alg];
    if (!algorithm) fail(`alg ${header.alg} is not allowed`);
    if (!keys.has(header.kid)) await loadKeys();
    const entry = keys.get(header.kid) ?? fail('unknown key id');
    if (entry.alg !== header.alg) fail('alg does not match the key');
    const ok = verify(
      algorithm.hash,
      Buffer.from(`${h}.${p}`),
      { key: entry.key, ...(algorithm.dsaEncoding ? { dsaEncoding: algorithm.dsaEncoding } : {}) },
      Buffer.from(s, 'base64url'),
    );
    if (!ok) fail('bad signature');
    const claims = decode(p) as HubClaims;
    const time = Math.floor(now());
    if (claims.iss !== issuer) fail('wrong issuer');
    if (claims.aud !== audience) fail('wrong audience');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < time) fail('expired');
    if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > time) fail('issued in the future');
    // The assertion is bound to this request, so it cannot be replayed against another route.
    if (claims.htm !== method) fail('wrong method');
    if (claims.htp !== pathAndQuery) fail('wrong path');
    // CALM Hub sends bdh only for a request with a body.
    const bodyHash = body?.length ? createHash('sha256').update(body).digest('base64url') : undefined;
    if (claims.bdh !== bodyHash) fail('wrong body');
    if (seen.has(claims.jti)) fail('replayed');
    seen.set(claims.jti, claims.exp);
    for (const [jti, exp] of seen) if (exp + CLOCK_SKEW_SECONDS < time) seen.delete(jti);
    return claims;
  };
}
