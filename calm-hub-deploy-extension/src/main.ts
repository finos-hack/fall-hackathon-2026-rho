import { runKubectl } from '@internal/backstage-plugin-calm-node';
import type { AppDeps } from './app';
import { readSettings } from './config';
import { Gitea } from './gitea';
import { HubClient } from './hub';
import { createVerifier } from './identity';
import { createLogger } from './logger';
import { DEPLOYED_BY, decoratorOf } from './record';
import { RouteTable } from './routes';
import { createServer } from './server';
import { Jobs } from './deploy/job';
import { oneLine, type Kubectl } from './deploy/kube';

/**
 * Deployments a restart cut off would stay "in-progress" for ever: mark this extension's unfinished ones failed.
 * Only the namespaces in DEPLOY_NAMESPACES (default hackathon) are scanned.
 */
async function closeInterrupted(deps: AppDeps, namespaces: string[]): Promise<void> {
  for (const ns of namespaces) {
    let ids: number[] = [];
    try {
      ids = await deps.hub.listDecorators(ns, { type: 'deployment' });
    } catch (e) {
      deps.logger.warn(`Could not list deployments in ${ns}: ${oneLine(e)}`);
      continue;
    }
    for (const id of ids) {
      const d = await deps.hub.getDecorator(ns, id).catch(() => undefined);
      const data = d?.data ?? {};
      if (data['deployed-by'] !== DEPLOYED_BY || (data.status !== 'pending' && data.status !== 'in-progress')) continue;
      const version = String(data['architecture-version'] ?? '');
      const name = String(d!.uniqueId).slice(0, -(version.length + 10));
      await deps.hub
        .updateDecorator(ns, id, {
          ...decoratorOf({
            uniqueId: d!.uniqueId,
            namespace: ns,
            architecture: name,
            version,
            appliesTo: d!.appliesTo,
            status: 'failed',
            startTime: String(data['start-time']),
            endTime: new Date().toISOString(),
            notes: `Deployment failed: the extension restarted while it was ${data.status} (${data.notes ?? ''})`,
            environment: String(data.environment ?? deps.settings.environment),
            requestedBy: String(data['requested-by'] ?? ''),
            hubAuditId: String(data['hub-audit-id'] ?? ''),
            ...(data['pull-request'] ? { pullRequest: String(data['pull-request']) } : {}),
            ...(data.commit ? { commit: String(data.commit) } : {}),
          }),
          target: d!.target,
        })
        .then(() => deps.logger.warn(`Marked interrupted deployment ${d!.uniqueId} (decorator ${id}) failed`))
        .catch(e => deps.logger.warn(`Could not close decorator ${id}: ${oneLine(e)}`));
    }
  }
}

async function main() {
  const settings = readSettings();
  const logger = createLogger();
  const hub = new HubClient(settings.hubUrl);
  const kubectl: Kubectl = async (args, quiet, timeoutMs) =>
    (
      await runKubectl(settings.kubernetes, args, {
        cwd: settings.workDir,
        logger,
        quietStdout: quiet,
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      })
    ).stdout;
  await import('node:fs/promises').then(fs => fs.mkdir(settings.workDir, { recursive: true }));
  const deps: AppDeps = {
    settings,
    logger,
    hub,
    gitea: new Gitea(settings.gitops.gitUrl, settings.gitops.auth),
    kubectl,
    jobs: new Jobs(),
    routes: RouteTable.fromManifest(settings.manifestPath),
    verify: createVerifier({
      issuer: settings.hubIssuer,
      audience: settings.extensionId,
      fetchJwks: async () => (await fetch(`${settings.hubUrl}/api/calm/auth/jwks`)).json() as any,
    }),
  };
  await closeInterrupted(deps, (process.env.DEPLOY_NAMESPACES ?? 'hackathon').split(',').filter(Boolean));
  createServer(deps).listen(settings.port, () =>
    logger.info(
      `gitops-deploy listening on :${settings.port} (Hub ${settings.hubUrl}, environment ${settings.environment}, approval ${settings.approval})`,
    ),
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
