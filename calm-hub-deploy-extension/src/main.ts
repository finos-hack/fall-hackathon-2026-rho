import { runKubectl } from '@internal/backstage-plugin-calm-node';
import type { AppDeps } from './app';
import { readSettings } from './config';
import { Gitea } from './gitea';
import { HubClient } from './hub';
import { createVerifier } from './identity';
import { closeInterrupted } from './interrupted';
import { createLogger } from './logger';
import { RouteTable } from './routes';
import { createServer } from './server';
import { Jobs } from './deploy/job';
import type { Kubectl } from './deploy/kube';

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
  // Only the namespaces in DEPLOY_NAMESPACES (default hackathon) are scanned.
  await closeInterrupted(deps, settings.deployNamespaces);
  createServer(deps).listen(settings.port, () =>
    logger.info(
      `platform-connector listening on :${settings.port} (Hub ${settings.hubUrl}, environment ${settings.environment}, approval ${settings.approval})`,
    ),
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
