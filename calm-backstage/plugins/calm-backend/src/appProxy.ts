/*
 * "Open the running app": forwards a browser request to a deployed service's gateway through the Kubernetes API
 * server's service proxy (`/api/v1/namespaces/<ns>/services/http:api-gateway:80/proxy/...`), with the kubeconfig of
 * `calm.deploy.kubernetes`. Nothing to port-forward, and the request takes the architecture's own path: gateway,
 * then the service.
 *
 * Only a namespace `<prefix><name>` labelled `calm.finos.org/service: <name>` (one calm:deploy:k8s or
 * calm:deploy:gitops made) is reached, and only its `api-gateway` Service.
 */
import fs from 'node:fs/promises';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type express from 'express';
import YAML from 'yaml';
import {
  CALM_KUBERNETES,
  deployNamespace,
  isDnsLabel,
} from '@internal/backstage-plugin-calm-common';
import type { KubernetesDeploySettings } from '@internal/backstage-plugin-calm-node';

export const GATEWAY_SERVICE = 'http:api-gateway:80';
/**
 * The page a starter serves is its own: it may run its inline script and call its own API (relative URLs). This
 * replaces the backend's default policy (no inline scripts, upgrade-insecure-requests) for proxied responses only.
 */
export const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'";
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

/**
 * The namespace and API server path for `rest` (the path after `/app/<name>`, with its query, not decoded).
 * Undefined for a name that is not a DNS label, or a path with `..` segments, encoded slashes or backslashes.
 */
export function appTarget(
  name: string,
  rest: string,
  prefix: string,
): { namespace: string; path: string } | undefined {
  if (!isDnsLabel(name) || !prefix) {
    return undefined;
  }
  const [p, query] = rest.split(/\?(.*)/s, 2);
  const pathPart = p || '/';
  if (
    !pathPart.startsWith('/') ||
    /%2f|%5c|\\/i.test(pathPart) ||
    pathPart.split('/').some(seg => {
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {
        return true;
      }
      return d === '..' || d === '.';
    })
  ) {
    return undefined;
  }
  let namespace: string;
  try {
    namespace = deployNamespace(prefix, name);
  } catch {
    return undefined;
  }
  return {
    namespace,
    path: `/api/v1/namespaces/${namespace}/services/${GATEWAY_SERVICE}/proxy${pathPart}${
      query ? `?${query}` : ''
    }`,
  };
}

export interface ApiServer {
  server: URL;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  token?: string;
}

const fileOrData = async (file?: string, data?: string) =>
  data ? Buffer.from(data, 'base64') : file ? fs.readFile(file) : undefined;

/** The API server and credentials of the kubeconfig's context (files or inline data, client certificate or token). */
export async function readApiServer(
  settings: KubernetesDeploySettings,
): Promise<ApiServer> {
  const kc = YAML.parse(await fs.readFile(settings.kubeconfig, 'utf-8'));
  const ctx = (kc.contexts ?? []).find(
    (c: any) => c.name === settings.context,
  )?.context;
  const cluster = (kc.clusters ?? []).find(
    (c: any) => c.name === ctx?.cluster,
  )?.cluster;
  const user =
    (kc.users ?? []).find((u: any) => u.name === ctx?.user)?.user ?? {};
  if (!cluster?.server) {
    throw new Error(
      `${settings.kubeconfig} has no cluster for the context ${settings.context}`,
    );
  }
  return {
    server: new URL(cluster.server),
    ca: await fileOrData(
      cluster['certificate-authority'],
      cluster['certificate-authority-data'],
    ),
    cert: await fileOrData(
      user['client-certificate'],
      user['client-certificate-data'],
    ),
    key: await fileOrData(user['client-key'], user['client-key-data']),
    token: typeof user.token === 'string' ? user.token : undefined,
  };
}

function request(
  api: ApiServer,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  stream: NodeJS.ReadableStream;
}> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: api.server.protocol,
        hostname: api.server.hostname,
        port: api.server.port,
        method,
        path,
        ca: api.ca,
        cert: api.cert,
        key: api.key,
        headers: {
          ...headers,
          ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        },
        timeout: 15000,
      },
      res =>
        resolve({
          status: res.statusCode ?? 502,
          headers: res.headers,
          stream: res,
        }),
    );
    req.on('timeout', () =>
      req.destroy(new Error('the API server did not answer in 15 s')),
    );
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function readJson(stream: NodeJS.ReadableStream): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.from(c as Buffer));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Express handler for `GET|POST /app/:name/*`. */
export function createAppProxy(settings: KubernetesDeploySettings | undefined) {
  const allowed = new Map<string, number>();
  let api: Promise<ApiServer> | undefined;

  async function isCalmService(
    a: ApiServer,
    namespace: string,
    name: string,
  ): Promise<boolean> {
    const key = `${namespace}/${name}`;
    const until = allowed.get(key);
    if (until && until > Date.now()) {
      return true;
    }
    const r = await request(a, 'GET', `/api/v1/namespaces/${namespace}`, {
      Accept: 'application/json',
    });
    if (r.status !== 200) {
      r.stream.resume();
      return false;
    }
    const ns = await readJson(r.stream);
    const ok = ns?.metadata?.labels?.[CALM_KUBERNETES.serviceLabel] === name;
    if (ok) {
      allowed.set(key, Date.now() + 30_000);
    }
    return ok;
  }

  return async (req: express.Request, res: express.Response) => {
    const name = req.params.name;
    const marker = `/app/${name}`;
    const at = req.originalUrl.indexOf(marker);
    const rest = at >= 0 ? req.originalUrl.slice(at + marker.length) : '';
    if (!settings) {
      res
        .status(404)
        .type('text/plain')
        .send('No cluster is configured (calm.deploy.kubernetes).');
      return;
    }
    if (rest === '' || rest.startsWith('?')) {
      // The page uses relative links, so it must be served under a trailing slash.
      res.redirect(302, `${req.baseUrl}${marker}/${rest}`);
      return;
    }
    const target = appTarget(name, rest, settings.namespacePrefix);
    if (!target) {
      res
        .status(404)
        .type('text/plain')
        .send('Not a deployed CALM service path.');
      return;
    }
    try {
      api ??= readApiServer(settings);
      const a = await api;
      if (!(await isCalmService(a, target.namespace, name))) {
        res
          .status(404)
          .type('text/plain')
          .send(`${name} is not a deployed CALM service.`);
        return;
      }
      const headers: Record<string, string> = {};
      for (const h of ['accept', 'content-type', 'accept-language']) {
        const v = req.headers[h];
        if (typeof v === 'string') {
          headers[h] = v;
        }
      }
      let body: Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = Buffer.from(
          req.body !== undefined &&
            typeof req.body === 'object' &&
            headers['content-type']?.includes('json')
            ? JSON.stringify(req.body)
            : '',
        );
        headers['content-length'] = String(body.length);
      }
      const up = await request(a, req.method, target.path, headers, body);
      res.status(up.status);
      for (const [k, v] of Object.entries(up.headers)) {
        if (
          v !== undefined &&
          !HOP_BY_HOP.has(k.toLowerCase()) &&
          k.toLowerCase() !== 'set-cookie'
        ) {
          res.setHeader(k, v as string | string[]);
        }
      }
      res.setHeader('Content-Security-Policy', APP_CSP);
      up.stream.on('error', () => res.destroy());
      up.stream.pipe(res);
    } catch (e) {
      api = undefined;
      res
        .status(502)
        .type('text/plain')
        .send(`The service could not be reached: ${(e as Error).message ?? e}`);
    }
  };
}
