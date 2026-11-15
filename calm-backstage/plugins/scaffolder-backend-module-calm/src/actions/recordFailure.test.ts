import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordDeployment } from './decorateDeployment';
import { recordFailedDeployment } from './recordFailure';

let root: string;
let workspace: string;
let baseDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calm-record-failure-'));
  workspace = path.join(root, 'workspace');
  baseDir = path.join(workspace, 'output', 'orders', 'deploy', 'k8s');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'architecture.json'),
    JSON.stringify({
      nodes: [{ 'unique-id': 'web-service' }, { 'unique-id': 'mongo' }],
    }),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A Hub that keeps the decorators posted to it, and reads each back the way recordDeployment checks. */
function fakeRecordingHub() {
  const posted: any[] = [];
  const hub = {
    baseUrl: 'http://hub',
    architectures: jest.fn(async () => [{ customId: 'orders', numericId: 4 }]),
    createDecorator: jest.fn(async (_ns: string, d: any) => {
      posted.push(d);
      return posted.length;
    }),
    listDecorators: jest.fn(async () => posted.map((_, i) => i + 1)),
    getDecorator: jest.fn(async (_ns: string, id: number) => ({
      uniqueId: posted[id - 1]['unique-id'],
    })),
  };
  return { hub: hub as any, posted };
}

const logger = () => ({ info: jest.fn(), warn: jest.fn() } as any);

const workloads = (labels: string[]) =>
  fs.writeFile(
    path.join(baseDir, 'workloads.yaml'),
    labels
      .map(
        l =>
          `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${l}\n  labels:\n    calm.finos.org/node: ${l}\n`,
      )
      .join('---\n'),
  );

const record = (architecturePath = 'architecture.json') => ({
  hubNamespace: 'hackathon',
  architecture: 'orders',
  version: '1.0.0',
  architecturePath,
});

const failed = (opts: {
  hub?: any;
  appBaseUrl?: string;
  architecturePath?: string;
  log: any;
}) =>
  recordFailedDeployment({
    hub: opts.hub,
    appBaseUrl: 'appBaseUrl' in opts ? opts.appBaseUrl : 'http://backstage',
    record: record(opts.architecturePath),
    baseDir,
    workspacePath: workspace,
    taskId: 'task-1',
    name: 'orders',
    cluster: 'calm-backstage',
    namespace: 'calm-orders',
    startTime: '2026-11-15T10:00:00.000Z',
    error: new Error('rollout timed out'),
    logger: opts.log,
  });

describe('recordFailedDeployment', () => {
  it('applies to the labelled workloads that are nodes of the architecture', async () => {
    await workloads(['web-service', 'orders-web']);
    const { hub, posted } = fakeRecordingHub();
    const log = logger();
    await failed({ hub, log });
    expect(posted).toHaveLength(1);
    expect(posted[0]['applies-to']).toEqual(['web-service']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Not nodes of the architecture.*orders-web/),
    );
  });

  it('applies to every architecture node when the workloads are labelled but none is a node', async () => {
    await workloads(['orders-web', 'orders-db']);
    const { hub, posted } = fakeRecordingHub();
    const log = logger();
    await failed({ hub, log });
    expect(posted).toHaveLength(1);
    expect(posted[0]['applies-to']).toEqual(['web-service', 'mongo']);
    expect(posted[0].data.status).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Not nodes of the architecture.*orders-db, orders-web/,
      ),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/Could not record/),
    );
  });

  it('does not read an architecture outside the workspace', async () => {
    // No labelled workload, so it falls back to the architecture's nodes. The file outside is not JSON: reading it
    // would fail on parsing, not on the path.
    await fs.writeFile(path.join(root, 'outside.json'), 'not json');
    const { hub } = fakeRecordingHub();
    const log = logger();
    await failed({ hub, log, architecturePath: '../outside.json' });
    expect(hub.createDecorator).not.toHaveBeenCalled();
    const warning: string = log.warn.mock.calls[0][0];
    expect(warning).toMatch(
      /Could not record the failed deployment.*outside its parent/,
    );
    expect(warning).not.toMatch(/JSON/);
  });

  it('says that app.baseUrl is missing, not the Hub client', async () => {
    await workloads(['web-service']);
    const { hub } = fakeRecordingHub();
    const log = logger();
    await failed({ hub, log, appBaseUrl: undefined });
    expect(hub.createDecorator).not.toHaveBeenCalled();
    const warning: string = log.warn.mock.calls[0][0];
    expect(warning).toMatch(/app\.baseUrl/);
    expect(warning).not.toMatch(/no CALM Hub client/);
  });

  it('says when there is no Hub client', async () => {
    const log = logger();
    await failed({ log });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no CALM Hub client/),
    );
  });

  it('gives the failed decorator a unique-id other than the one a successful retry of the task records', async () => {
    await workloads(['web-service']);
    const { hub, posted } = fakeRecordingHub();
    await failed({ hub, log: logger() });
    await recordDeployment(
      hub,
      'http://backstage',
      {
        ...record(),
        name: 'orders',
        cluster: 'calm-backstage',
        namespace: 'calm-orders',
        workloads: ['web-service'],
        startTime: '2026-11-15T10:05:00.000Z',
        workspacePath: workspace,
        taskId: 'task-1',
      },
      logger(),
    );
    expect(posted.map(d => d['unique-id'])).toEqual([
      'orders-task-1-failed',
      'orders-task-1',
    ]);
  });
});
