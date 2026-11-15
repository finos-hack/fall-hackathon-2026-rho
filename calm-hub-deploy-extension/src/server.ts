import http from 'node:http';
import { handle, type AppDeps } from './app';

const MAX_BODY = 1024 * 1024;

/** The HTTP server CALM Hub proxies to: reads the raw body (the assertion covers its hash) and answers JSON. */
export function createServer(deps: AppDeps): http.Server {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"body too large"}');
        return;
      }
      chunks.push(c as Buffer);
    }
    let status = 500;
    let body: unknown = { error: 'internal error' };
    try {
      ({ status, body } = await handle(deps, {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        identity: req.headers['x-calm-hub-identity'] as string | undefined,
        body: Buffer.concat(chunks),
      }));
    } catch (e) {
      deps.logger.error(`Unhandled: ${(e as Error).stack ?? e}`);
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    deps.logger.debug(`${req.method} ${req.url} -> ${status} (${Date.now() - started} ms)`);
  });
}
