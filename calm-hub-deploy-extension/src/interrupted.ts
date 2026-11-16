import { deployNamespace } from '@internal/backstage-plugin-calm-common';
import type { ReadDeps } from './status';
import { decoratorOf, gitopsFields, isOwnUnfinished } from './record';
import { oneLine } from './deploy/kube';

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * Deployments a restart cut off would stay "in-progress" for ever: mark this connector's unfinished ones failed,
 * rewritten in the standard layout. Finds records in the old layout (`deployed-by: gitops-deploy`) too.
 */
export async function closeInterrupted(deps: Pick<ReadDeps, 'hub' | 'logger' | 'settings'>, namespaces: string[]): Promise<void> {
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
      if (!d || !isOwnUnfinished(data)) continue;
      try {
        const g = gitopsFields(data);
        const version = g.architectureVersion ?? '';
        // unique-id is <name>-<version>-<8 characters of the audit id>.
        const name = String(d.uniqueId).slice(0, -(version.length + 10));
        const k: Record<string, unknown> = typeof data.kubernetes === 'object' && data.kubernetes ? data.kubernetes : {};
        const details = text(data['deployment-details']);
        await deps.hub.updateDecorator(ns, id, {
          ...decoratorOf({
            uniqueId: d.uniqueId,
            namespace: ns,
            architecture: name,
            version,
            appliesTo: d.appliesTo,
            status: 'failed',
            startTime: String(data['start-time']),
            endTime: new Date().toISOString(),
            notes: `Deployment failed: the extension restarted while it was ${data.status} (${data.notes ?? ''})`,
            kubernetes: {
              cluster: text(k.cluster) ?? deps.settings.kubernetes.context,
              namespace: text(k.namespace) ?? deployNamespace(deps.settings.kubernetes.namespacePrefix, name),
            },
            environment: g.environment ?? deps.settings.environment,
            ...(g.repository ? { repository: g.repository } : {}),
            requestedBy: g.requestedBy ?? '',
            hubAuditId: g.hubAuditId ?? '',
            ...(g.pullRequest ? { pullRequest: g.pullRequest } : {}),
            ...(g.commit ? { commit: g.commit } : {}),
            ...(details ? { details } : {}),
          }),
          target: d.target,
        });
        deps.logger.warn(`Marked interrupted deployment ${d.uniqueId} (decorator ${id}) failed`);
      } catch (e) {
        deps.logger.warn(`Could not close decorator ${id}: ${oneLine(e)}`);
      }
    }
  }
}
