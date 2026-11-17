import { ReadTimeout } from './errors';
import { readService } from './resolve';
import { readPlatform, type PlatformDeps, type PlatformView } from './platform';
import { oneLine } from './deploy/kube';

/** How long the services overview (landing card, screen) is reused: CALM Hub's landing page asks on every visit. */
export const SERVICES_TTL_MS = 10_000;

/** One service the platform runs, as the landing card and the screen show it. */
export interface ServiceRow {
  /** The service repository's name. */
  name: string;
  /** Empty when the repository could not be read (its namespace is then unknown). */
  namespace: string;
  architecture: string;
  view?: PlatformView;
  /** Why it could not be read. */
  error?: string;
}

const cache = new WeakMap<object, { at: number; read: Promise<ServiceRow[]> }>();

/**
 * The services in Gitea's services organisation whose `catalog-info.yaml` names an architecture in one of
 * `settings.deployNamespaces`, each with what runs. Read in parallel and reused for 10 s (per `deps`): the card and
 * the screen share one read.
 */
export function readServices(deps: PlatformDeps & { now?: () => number }): Promise<ServiceRow[]> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(deps);
  if (hit && now - hit.at < SERVICES_TTL_MS) return hit.read;
  const read = readAll(deps);
  cache.set(deps, { at: now, read });
  // A failed read is not reused.
  read.catch(() => cache.delete(deps));
  return read;
}

async function readAll(deps: PlatformDeps): Promise<ServiceRow[]> {
  const org = deps.settings.gitops.servicesOrg;
  const repos = await deps.gitea.listRepos(org);
  const rows = await Promise.all(
    repos.map(async (repo): Promise<ServiceRow | undefined> => {
      let service;
      try {
        service = await readService(deps.gitea, deps.settings, repo);
      } catch (e) {
        deps.logger.warn(`Could not read ${org}/${repo}: ${oneLine(e)}`);
        // A timeout is a problem shown on the row, not a service that silently disappears. Its namespace is unknown,
        // so the namespace filter cannot apply to it.
        if (!(e instanceof ReadTimeout)) return undefined;
        return { name: repo, namespace: '', architecture: repo, error: `Cannot read ${org}/${repo}: ${e.message}` };
      }
      const namespace = service?.architectureNamespace;
      const architecture = service?.architecture;
      if (!service || !namespace || !architecture || !deps.settings.deployNamespaces.includes(namespace)) return undefined;
      try {
        return { name: repo, namespace, architecture, view: await readPlatform(deps, namespace, architecture, { service }) };
      } catch (e) {
        deps.logger.warn(`Could not read what runs for ${namespace}/${architecture}: ${oneLine(e)}`);
        return { name: repo, namespace, architecture, error: oneLine(e) };
      }
    }),
  );
  return rows.filter((r): r is ServiceRow => r !== undefined).sort((a, b) => a.name.localeCompare(b.name));
}
