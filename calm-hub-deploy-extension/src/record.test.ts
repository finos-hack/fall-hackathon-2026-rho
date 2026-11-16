import { describe, expect, it } from 'vitest';
import type { CalmHubDecorator } from '@internal/backstage-plugin-calm-common';
import { decoratorOf, historyEntry, isOwnUnfinished, type DeploymentRecord } from './record';

const record: DeploymentRecord = {
  uniqueId: 'events-stream-1.0.1-aaaa1111',
  namespace: 'hackathon',
  architecture: 'events-stream',
  version: '1.0.1',
  numericId: 38,
  appliesTo: ['web-service'],
  status: 'completed',
  startTime: '2026-11-16T10:00:00.000Z',
  endTime: '2026-11-16T10:02:00.000Z',
  notes: 'Deployed 1.0.1 to local',
  kubernetes: { cluster: 'calm-backstage', namespace: 'calm-events-stream' },
  environment: 'local',
  repository: 'http://localhost:3300/calm-services/events-stream',
  requestedBy: 'alice',
  hubAuditId: 'aaaa1111-2222',
  pullRequest: 'http://localhost:3300/calm-services/events-stream/pulls/1',
  commit: 'abc123',
  details: 'http://localhost:3300/calm-services/events-stream/commit/abc123',
};

/** A decorator as CALM Hub gives it back (camel case at the top, `data` as posted). */
const asRead = (d: any, id = 7): CalmHubDecorator => ({
  id,
  uniqueId: d['unique-id'],
  type: d.type,
  target: d.target,
  targetType: d['target-type'],
  appliesTo: d['applies-to'],
  data: d.data,
});

describe('decoratorOf', () => {
  it('builds the standard Kubernetes deployment decorator, with the GitOps details in data.gitops', () => {
    expect(decoratorOf(record)).toStrictEqual({
      $schema: 'https://calm.finos.org/standards/deployment/1.0/kubernetes.decorator.standard.json',
      'unique-id': 'events-stream-1.0.1-aaaa1111',
      type: 'deployment',
      target: [
        '/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1',
        '/api/calm/namespaces/hackathon/architectures/38/versions/1-0-1',
      ],
      'target-type': ['architecture'],
      'applies-to': ['web-service'],
      data: {
        'start-time': '2026-11-16T10:00:00.000Z',
        'end-time': '2026-11-16T10:02:00.000Z',
        status: 'completed',
        'deployment-details': 'http://localhost:3300/calm-services/events-stream/commit/abc123',
        notes: 'Deployed 1.0.1 to local',
        kubernetes: { cluster: 'calm-backstage', namespace: 'calm-events-stream' },
        gitops: {
          connector: 'platform-connector',
          environment: 'local',
          repository: 'http://localhost:3300/calm-services/events-stream',
          'pull-request': 'http://localhost:3300/calm-services/events-stream/pulls/1',
          commit: 'abc123',
          'requested-by': 'alice',
          'hub-audit-id': 'aaaa1111-2222',
          'architecture-version': '1.0.1',
        },
      },
    });
  });

  it('leaves out what a record does not have yet: one target without a numeric id, no empty optional fields', () => {
    const { numericId, endTime, details, repository, pullRequest, commit, ...pending } = record;
    const d: any = decoratorOf({ ...pending, status: 'pending' });
    expect(d.target).toEqual(['/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1']);
    expect(Object.keys(d.data)).toEqual(['start-time', 'status', 'notes', 'kubernetes', 'gitops']);
    expect(Object.keys(d.data.gitops)).toEqual(['connector', 'environment', 'requested-by', 'hub-audit-id', 'architecture-version']);
  });

  it('has every field the standard requires, and only cluster and namespace in data.kubernetes', () => {
    const d: any = decoratorOf(record);
    expect(d.type).toBe('deployment');
    expect(d['target-type']).toEqual(['architecture']);
    expect(d.target.length).toBeGreaterThan(0);
    expect(Date.parse(d.data['start-time'])).not.toBeNaN();
    expect(['pending', 'in-progress', 'completed', 'failed', 'rolled-back']).toContain(d.data.status);
    expect(Object.keys(d.data.kubernetes).sort()).toEqual(['cluster', 'namespace']);
    expect(d.data.kubernetes.cluster).toBeTruthy();
    expect(d.data.kubernetes.namespace).toBeTruthy();
  });
});

/** The same deployment as the extension recorded it before the standard layout (still in CALM Hub). */
const oldLayout = {
  $schema: 'https://calm.finos.org/draft/2026-03/standards/deployment/deployment.decorator.standard.json',
  'unique-id': 'events-stream-1.0.1-aaaa1111',
  type: 'deployment',
  target: ['/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.1'],
  'target-type': ['architecture'],
  'applies-to': ['web-service'],
  data: {
    'start-time': record.startTime,
    'end-time': record.endTime,
    status: 'completed',
    'deployment-details': record.details,
    notes: record.notes,
    environment: 'local',
    'architecture-version': '1.0.1',
    'requested-by': 'alice',
    'hub-audit-id': 'aaaa1111-2222',
    'deployed-by': 'gitops-deploy',
    'pull-request': record.pullRequest,
    commit: 'abc123',
  },
};

describe('historyEntry', () => {
  it('reads a record in the standard layout and one in the old layout into the same entry', () => {
    const fromNew = historyEntry(asRead(decoratorOf(record)));
    const fromOld = historyEntry(asRead(oldLayout));
    expect(fromNew).toEqual({
      id: 7,
      version: '1.0.1',
      status: 'completed',
      startTime: record.startTime,
      endTime: record.endTime,
      environment: 'local',
      requestedBy: 'alice',
      pullRequest: record.pullRequest,
      details: record.details,
      notes: record.notes,
      deployedBy: 'platform-connector',
    });
    expect(fromOld).toEqual({ ...fromNew, deployedBy: 'gitops-deploy' });
  });

  it('reads a Backstage deployment (no connector fields) with the version from its target', () => {
    const backstage = { ...oldLayout, data: { 'start-time': record.startTime, status: 'completed' } };
    expect(historyEntry(asRead(backstage))).toEqual({ id: 7, version: '1.0.1', status: 'completed', startTime: record.startTime });
  });
});

describe('isOwnUnfinished', () => {
  const unfinished = (d: any) => ({ ...d.data, status: 'in-progress' });
  it('finds this connector’s unfinished records in either layout', () => {
    expect(isOwnUnfinished(unfinished(decoratorOf(record)))).toBe(true);
    expect(isOwnUnfinished(unfinished(oldLayout))).toBe(true);
    expect(isOwnUnfinished({ ...unfinished(oldLayout), status: 'pending' })).toBe(true);
  });

  it('skips finished records, other connectors’ and Backstage’s', () => {
    expect(isOwnUnfinished((decoratorOf(record) as any).data)).toBe(false);
    expect(isOwnUnfinished(oldLayout.data)).toBe(false);
    const other: any = unfinished(decoratorOf(record));
    expect(isOwnUnfinished({ ...other, gitops: { ...other.gitops, connector: 'someone-else' } })).toBe(false);
    expect(isOwnUnfinished({ 'start-time': record.startTime, status: 'in-progress' })).toBe(false);
  });
});
