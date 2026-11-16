import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { closeInterrupted } from './interrupted';
import { standardErrors, world, type World } from './test/fakes';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) fs.rmSync(w.root, { recursive: true, force: true });
});

const base = {
  type: 'deployment',
  target: [
    '/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1',
    '/api/calm/namespaces/hackathon/architectures/38/versions/1-0-1',
  ],
  'target-type': ['architecture'],
  'applies-to': ['web-service'],
};

describe('closeInterrupted', () => {
  it('marks this connector’s unfinished deployments failed, in the standard layout, whichever layout they were in', async () => {
    const w = world();
    worlds.push(w);
    const set = (id: number, d: any) => w.hub.decorators.set(id, { ...base, ...d });
    // Written before the rename: the old layout, no data.kubernetes.
    set(1, {
      $schema: 'https://calm.finos.org/draft/2026-03/standards/deployment/deployment.decorator.standard.json',
      'unique-id': 'events-stream-1.0.1-aaaa1111',
      data: {
        'start-time': '2026-11-16T10:00:00.000Z',
        status: 'in-progress',
        notes: 'Merging pull request #1',
        environment: 'local',
        'architecture-version': '1.0.1',
        'requested-by': 'alice',
        'hub-audit-id': 'aaaa1111-2222',
        'deployed-by': 'gitops-deploy',
        'pull-request': 'http://gitea.test/calm-services/events-stream/pulls/1',
      },
    });
    // Written by this version.
    set(2, {
      $schema: 'https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json',
      'unique-id': 'events-stream-1.0.1-bbbb2222',
      data: {
        'start-time': '2026-11-16T11:00:00.000Z',
        status: 'pending',
        notes: 'Requested by bob',
        kubernetes: { cluster: 'prod-cluster', namespace: 'events' },
        gitops: {
          connector: 'platform-connector',
          environment: 'local',
          repository: 'http://gitea.test/calm-services/events-stream',
          'requested-by': 'bob',
          'hub-audit-id': 'bbbb2222-3333',
          'architecture-version': '1.0.1',
        },
      },
    });
    // Finished, and Backstage's: left alone.
    set(3, { 'unique-id': 'done', data: { 'start-time': '2026-11-16T09:00:00.000Z', status: 'completed', 'deployed-by': 'gitops-deploy' } });
    set(4, { 'unique-id': 'backstage', data: { 'start-time': '2026-11-16T09:00:00.000Z', status: 'in-progress' } });

    await closeInterrupted(w.deps, ['hackathon']);

    expect(w.hub.puts.map(p => p.id).sort()).toEqual([1, 2]);
    const old = w.hub.decorators.get(1);
    expect(standardErrors(old)).toEqual([]);
    expect(old.target).toEqual(base.target);
    expect(old.data).toMatchObject({
      status: 'failed',
      kubernetes: { cluster: 'calm-backstage', namespace: 'calm-events-stream' },
      gitops: {
        connector: 'platform-connector',
        'requested-by': 'alice',
        'hub-audit-id': 'aaaa1111-2222',
        'pull-request': 'http://gitea.test/calm-services/events-stream/pulls/1',
        'architecture-version': '1.0.1',
      },
    });
    expect(old.data.notes).toContain('restarted while it was in-progress (Merging pull request #1)');
    expect(old.data['deployed-by']).toBeUndefined();
    const current = w.hub.decorators.get(2);
    expect(current.data).toMatchObject({
      status: 'failed',
      kubernetes: { cluster: 'prod-cluster', namespace: 'events' },
      gitops: { 'requested-by': 'bob', repository: 'http://gitea.test/calm-services/events-stream' },
    });
    expect(w.hub.decorators.get(3).data.status).toBe('completed');
    expect(w.hub.decorators.get(4).data.status).toBe('in-progress');
  });
});
