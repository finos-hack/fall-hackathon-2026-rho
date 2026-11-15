import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVerifier } from './identity';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'ES256', use: 'sig' };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(claims: Record<string, unknown>, opts: { key?: KeyObject; header?: Record<string, unknown> } = {}) {
  const h = b64({ typ: 'calm-ext+jwt', alg: 'ES256', kid: 'k1', ...opts.header });
  const p = b64(claims);
  const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: opts.key ?? privateKey, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${s.toString('base64url')}`;
}

const NOW = 1_800_000_000;
const base = (over: Record<string, unknown> = {}) => ({
  iss: 'http://localhost:8090',
  aud: 'gitops-deploy',
  sub: 'no-auth',
  iat: NOW,
  exp: NOW + 60,
  jti: `j-${Math.random()}`,
  htm: 'GET',
  htp: '/tab/hackathon/architectures/x?version=1.0.0',
  ...over,
});

function verifier() {
  let fetches = 0;
  const verify = createVerifier({
    issuer: 'http://localhost:8090',
    audience: 'gitops-deploy',
    fetchJwks: async () => {
      fetches++;
      return { keys: [jwk as any] };
    },
    now: () => NOW,
  });
  return { verify, fetches: () => fetches };
}

const get = { method: 'GET', pathAndQuery: '/tab/hackathon/architectures/x?version=1.0.0' };

describe('createVerifier', () => {
  it('accepts a good assertion and returns its claims, fetching the JWKS once', async () => {
    const { verify, fetches } = verifier();
    const claims = await verify(token(base()), get);
    expect(claims.sub).toBe('no-auth');
    await verify(token(base()), get);
    expect(fetches()).toBe(1);
  });

  it('binds the body by its hash', async () => {
    const { verify } = verifier();
    const body = Buffer.from('{"namespace":"hackathon"}');
    const bdh = createHash('sha256').update(body).digest('base64url');
    const post = { method: 'POST', pathAndQuery: '/deploy', body };
    await expect(verify(token(base({ htm: 'POST', htp: '/deploy', bdh })), post)).resolves.toBeTruthy();
    await expect(
      verify(token(base({ htm: 'POST', htp: '/deploy', bdh })), { ...post, body: Buffer.from('{}') }),
    ).rejects.toThrow('wrong body');
    await expect(verify(token(base({ htm: 'POST', htp: '/deploy' })), post)).rejects.toThrow('wrong body');
  });

  it.each([
    ['wrong audience', base({ aud: 'other' }), get],
    ['wrong issuer', base({ iss: 'http://evil' }), get],
    ['wrong path', base({ htp: '/tab/other' }), get],
    ['wrong method', base({ htm: 'POST' }), get],
    ['expired', base({ exp: NOW - 31 }), get],
    ['issued in the future', base({ iat: NOW + 31 }), get],
  ])('refuses: %s', async (msg, claims, req) => {
    await expect(verifier().verify(token(claims), req)).rejects.toThrow(msg);
  });

  it('refuses a replayed assertion', async () => {
    const { verify } = verifier();
    const t = token(base({ jti: 'same' }));
    await verify(t, get);
    await expect(verify(t, get)).rejects.toThrow('replayed');
  });

  it('refuses a token signed by another key, of another type, or no token', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(verifier().verify(token(base(), { key: other }), get)).rejects.toThrow('bad signature');
    await expect(verifier().verify(token(base(), { header: { typ: 'JWT' } }), get)).rejects.toThrow('wrong typ');
    await expect(verifier().verify(token(base(), { header: { alg: 'HS256' } }), get)).rejects.toThrow('not allowed');
    await expect(verifier().verify(undefined, get)).rejects.toThrow('not a JWT');
  });
});
