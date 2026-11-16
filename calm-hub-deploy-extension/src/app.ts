import { CalmHubError } from '@internal/backstage-plugin-calm-common';
import { cardReply, errorReply, nodeReply, screenReply, tabReply, type BlocksReply } from './blocks';
import { HttpError } from './errors';
import { AssertionError, type HubClaims, type VerifyAssertion } from './identity';
import { resolveArchitecture, findArchitecture } from './resolve';
import { RouteTable } from './routes';
import { platformFacts, readPlatform } from './platform';
import { readServices } from './services';
import { publicEntry, readHistory } from './status';
import { requestDeployment, type DeployDeps } from './deploy/job';
import { oneLine } from './deploy/kube';

export interface AppDeps extends DeployDeps {
  routes: RouteTable;
  verify: VerifyAssertion;
}

export interface Request {
  method: string;
  /** Path and query exactly as received. */
  url: string;
  identity?: string;
  body: Buffer;
}

export interface Response {
  status: number;
  body: unknown;
}

const decode = (s: string) => decodeURIComponent(s);

type Handler = (deps: AppDeps, p: Record<string, string>, q: URLSearchParams, claims: HubClaims) => Promise<Response>;

const handlers: Record<string, Handler> = {
  /** The designer tab: what runs, whether it matches Git and CALM Hub's record, and the version on screen. */
  async tab(deps, p, q) {
    try {
      const arch = await resolveArchitecture(deps.hub, p.namespace, p.resourceType, p.resourceId);
      const view = await readPlatform(deps, arch.namespace, arch.name);
      return { status: 200, body: tabReply(view, q.get('version') ?? undefined) };
    } catch (e) {
      // A tab shows its own error rather than CALM Hub's generic "Extension request failed."
      if (e instanceof HttpError) return { status: 200, body: errorReply(e.message) };
      throw e;
    }
  },

  /** The detail panel of a node: the workload the platform runs for it, its network policies and CALM Hub's record. */
  async node(deps, p) {
    return panel(deps, 'node panel', async () => {
      const arch = await resolveArchitecture(deps.hub, p.namespace, p.resourceType, p.resourceId);
      return nodeReply(await readPlatform(deps, arch.namespace, arch.name), p.selectedElement);
    });
  },

  /** The landing card: how many services run, in sync and drifted. */
  async card(deps) {
    return panel(deps, 'landing card', async () => cardReply(await readServices(deps)));
  },

  /** The extension's screen: every service the platform runs, with its drift. */
  async screen(deps) {
    return panel(deps, 'services screen', async () =>
      screenReply(await readServices(deps), {
        servicesOrg: deps.settings.gitops.servicesOrg,
        namespaces: deps.settings.deployNamespaces,
      }),
    );
  },

  async status(deps, p) {
    const arch = await findArchitecture(deps.hub, p.namespace, p.architecture);
    const { status, platform } = await readPlatform(deps, arch.namespace, arch.name);
    return { status: 200, body: platform ? { ...status, ...platformFacts(platform) } : status };
  },

  async history(deps, p) {
    const arch = await findArchitecture(deps.hub, p.namespace, p.architecture);
    const versions = await deps.hub.architectureVersions(arch.namespace, arch.name);
    const deployments = await readHistory(deps.hub, arch.namespace, arch.name, versions, deps.jobs.unrecorded(arch.name));
    return { status: 200, body: { deployments: deployments.map(publicEntry) } };
  },

  /** The "Deploy this version" action: the version on screen. */
  async 'deploy-here'(deps, p, _q, claims) {
    const arch = await resolveArchitecture(deps.hub, p.namespace, p.resourceType, p.resourceId);
    const accepted = await requestDeployment(deps, { namespace: p.namespace, architecture: arch.name, version: p.version, claims });
    return { status: 202, body: accepted };
  },

  /** The deploy command (CLI, MCP, CI). */
  async deploy(deps, p, _q, claims) {
    const accepted = await requestDeployment(deps, { namespace: p.namespace, architecture: p.architecture, version: p.version, claims });
    return { status: 202, body: accepted };
  },
};

/** Blocks for a panel, card or screen; any failure is shown in it as an alert rather than as an error status. */
async function panel(deps: AppDeps, what: string, build: () => Promise<BlocksReply>): Promise<Response> {
  try {
    return { status: 200, body: await build() };
  } catch (e) {
    if (!(e instanceof HttpError)) deps.logger.error(`The ${what} failed: ${oneLine(e)}`);
    const prefix = e instanceof CalmHubError ? 'CALM Hub: ' : '';
    return { status: 200, body: errorReply(`${prefix}${oneLine(e)}`) };
  }
}

/** Handles one request: match the route, verify CALM Hub's assertion, run the handler. */
export async function handle(deps: AppDeps, req: Request): Promise<Response> {
  const q = req.url.indexOf('?');
  const pathname = q >= 0 ? req.url.slice(0, q) : req.url;
  const query = new URLSearchParams(q >= 0 ? req.url.slice(q + 1) : '');
  const match = deps.routes.match(req.method, pathname);
  if (match.kind === 'not-found') return { status: 404, body: { error: 'not found' } };
  if (match.kind === 'method-not-allowed') return { status: 405, body: { error: 'method not allowed' } };

  let claims: HubClaims;
  try {
    claims = await deps.verify(req.identity, { method: req.method, pathAndQuery: req.url, body: req.body });
  } catch (e) {
    if (e instanceof AssertionError) {
      deps.logger.warn(`Refused ${req.method} ${pathname}: ${e.message}`);
      return { status: 401, body: { error: 'unauthorized' } };
    }
    throw e;
  }
  if (claims.route !== undefined && claims.route !== match.route.id) {
    return { status: 401, body: { error: 'assertion is for another route' } };
  }
  // For scoped routes CALM Hub checked the namespace in the path: it must be the one this request acts on.
  if (claims.ns !== undefined && match.route.path.includes('{namespace}') && claims.ns !== decode(match.params.namespace)) {
    return { status: 403, body: { error: `scope was checked on ${claims.ns}` } };
  }
  deps.logger.info(
    `${req.method} ${pathname} ← CALM Hub route=${match.route.id} scope=${claims.scope ?? '-'} ns=${claims.ns ?? '-'} sub=${claims.sub} jti=${claims.jti}`,
  );

  const params = Object.fromEntries(Object.entries(match.params).map(([k, v]) => [k, decode(v)]));
  try {
    return await handlers[match.route.id](deps, params, query, claims);
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    if (e instanceof CalmHubError) {
      deps.logger.error(`CALM Hub call failed: ${oneLine(e)}`);
      return { status: 502, body: { error: `CALM Hub: ${oneLine(e)}` } };
    }
    deps.logger.error(`${req.method} ${pathname} failed: ${oneLine(e)}`);
    return { status: 500, body: { error: oneLine(e) } };
  }
}
