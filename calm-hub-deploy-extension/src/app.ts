import { CalmHubError } from '@internal/backstage-plugin-calm-common';
import { cardReply, errorReply, nodeReply, screenReply, tabReply, type BlocksReply } from './blocks';
import { HttpError, ReadTimeout } from './errors';
import { AssertionError, type HubClaims, type VerifyAssertion } from './identity';
import { resolveArchitecture, findArchitecture } from './resolve';
import { RouteTable } from './routes';
import { platformFacts, readPlatform } from './platform';
import { readServices } from './services';
import { publicEntry, readHistory } from './status';
import { requestDeployment, type DeployDeps } from './deploy/job';
import { oneLine } from './deploy/kube';
import type { Sensors } from './sensors';

export interface AppDeps extends DeployDeps {
  routes: RouteTable;
  verify: VerifyAssertion;
  sensors: Sensors;
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
    // A tab shows its own error rather than CALM Hub's generic "Extension request failed."
    return panel(deps, 'designer tab', async () => {
      const arch = await resolveArchitecture(deps.hub, p.namespace, p.resourceType, p.resourceId);
      const view = await readPlatform(deps, arch.namespace, arch.name);
      return tabReply(view, q.get('version') ?? undefined, deps.sensors.snapshot(arch.namespace, arch.name).rows);
    });
  },

  /** The detail panel of a node: the workload the platform runs for it, its network policies and CALM Hub's record. */
  async node(deps, p) {
    return panel(deps, 'node panel', async () => {
      const arch = await resolveArchitecture(deps.hub, p.namespace, p.resourceType, p.resourceId);
      const view = await readPlatform(deps, arch.namespace, arch.name);
      return nodeReply(view, p.selectedElement, deps.sensors.snapshot(arch.namespace, arch.name).rows);
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
    let arch;
    try {
      arch = await findArchitecture(deps.hub, p.namespace, p.architecture);
    } catch (e) {
      if (!(e instanceof ReadTimeout)) throw e;
      // Whether the architecture exists is unknown: a status with the problem, not a 5xx.
      const problem = `Cannot read the architectures in CALM Hub: ${e.message}`;
      deps.logger.warn(problem);
      const { namespace, architecture } = p;
      const body = { namespace, architecture, managed: false, reason: problem, environment: deps.settings.environment, versions: [], problems: [problem] };
      return { status: 200, body };
    }
    const { status, platform, problems } = await readPlatform(deps, arch.namespace, arch.name);
    return { status: 200, body: platform ? { ...status, ...platformFacts(platform) } : { ...status, ...(problems ? { problems } : {}) } };
  },

  async history(deps, p) {
    const unrecorded = deps.jobs.unrecorded(p.architecture);
    try {
      const arch = await findArchitecture(deps.hub, p.namespace, p.architecture);
      const versions = await deps.hub.architectureVersions(arch.namespace, arch.name);
      const deployments = await readHistory(deps.hub, arch.namespace, arch.name, versions, deps.jobs.unrecorded(arch.name));
      return { status: 200, body: { deployments: deployments.map(publicEntry) } };
    } catch (e) {
      if (!(e instanceof ReadTimeout)) throw e;
      // What memory holds, and the problem, rather than a 5xx.
      deps.logger.warn(`Could not read the history of ${p.namespace}/${p.architecture}: ${e.message}`);
      return { status: 200, body: { deployments: unrecorded.map(publicEntry), problems: [`Cannot read CALM Hub's records: ${e.message}`] } };
    }
  },

  /** The verify command: runtime evidence now, recorded in CALM Hub. */
  async verify(deps, p) {
    const arch = await findArchitecture(deps.hub, p.namespace, p.architecture);
    const base = { namespace: arch.namespace, architecture: arch.name };
    // The sensors record only in the namespaces this connector deploys to (DEPLOY_NAMESPACES).
    if (!deps.settings.deployNamespaces.includes(arch.namespace)) {
      const problem = `${arch.namespace} is not one of this connector's deploy namespaces (DEPLOY_NAMESPACES): it neither senses nor records there`;
      return { status: 200, body: { ...base, managed: false, checks: [], problems: [problem] } };
    }
    const r = await deps.sensors.check(arch.namespace, arch.name);
    if (!r) return { status: 200, body: { ...base, managed: false, checks: [], problems: [] } };
    const holding = r.checks.filter(c => c.result === 'pass').length;
    return {
      status: 200,
      body: { ...base, managed: true, version: r.version, observedAt: r.observedAt, holding, checked: r.checks.length, checks: r.checks, problems: r.problems },
    };
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
    if (e instanceof ReadTimeout) {
      // CALM Hub's keys could not be read in time: the caller is not verified, so nothing can be shown to it.
      deps.logger.warn(`Could not verify ${req.method} ${pathname}: ${e.message}`);
      return { status: 503, body: { error: `cannot verify the request: ${e.message}` } };
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
