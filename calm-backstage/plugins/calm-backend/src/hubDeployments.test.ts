import {
  CalmHubClient,
  FetchLike,
} from '@internal/backstage-plugin-calm-common';
import { MAX_DEPLOYMENTS, readRecordedDeployments } from './hubDeployments';

const base = 'http://hub:8090';
const decorators = `${base}/api/calm/namespaces/hackathon/decorators`;
const target =
  '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0';
const ref = {
  namespace: 'hackathon',
  architecture: 'billing-api',
  version: '1.0.0',
};
const logger = () => ({ info: jest.fn(), warn: jest.fn() } as any);

function fakeFetch(routes: Record<string, unknown>): FetchLike & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const body = routes[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body,
      text: async () => (body !== undefined ? JSON.stringify(body) : 'nope'),
    };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const decorator = (n: number, start: string) => ({
  uniqueId: `billing-api-run-${n}`,
  type: 'deployment',
  target: [target],
  targetType: ['architecture'],
  appliesTo: ['web-service'],
  data: {
    'start-time': start,
    'end-time': start.replace(':00Z', ':32Z'),
    status: 'completed',
    'deployment-details':
      'http://localhost:3100/catalog/default/component/billing-api',
    notes: `run ${n}`,
  },
});
const list = `${decorators}?target=${encodeURIComponent(
  target,
)}&type=deployment`;

describe('readRecordedDeployments', () => {
  it('reads the deployment decorators of the architecture version, newest first', async () => {
    const fetch = fakeFetch({
      [list]: { values: [3, 8] },
      [`${decorators}/3`]: decorator(3, '2026-11-14T10:00:00Z'),
      [`${decorators}/8`]: decorator(8, '2026-11-14T12:00:00Z'),
    });
    const log = logger();
    expect(
      await readRecordedDeployments(new CalmHubClient(base, fetch), ref, log),
    ).toEqual([
      {
        id: 8,
        uniqueId: 'billing-api-run-8',
        status: 'completed',
        startTime: '2026-11-14T12:00:00Z',
        endTime: '2026-11-14T12:00:32Z',
        notes: 'run 8',
        details: 'http://localhost:3100/catalog/default/component/billing-api',
        appliesTo: ['web-service'],
      },
      expect.objectContaining({ id: 3, notes: 'run 3' }),
    ]);
    expect(fetch.calls[0]).toBe(list);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('gives an empty list when none is recorded', async () => {
    const fetch = fakeFetch({ [list]: { values: [] } });
    expect(
      await readRecordedDeployments(
        new CalmHubClient(base, fetch),
        ref,
        logger(),
      ),
    ).toEqual([]);
    expect(fetch.calls).toEqual([list]);
  });

  it('reads only the newest when there are many', async () => {
    const ids = Array.from({ length: MAX_DEPLOYMENTS + 5 }, (_, i) => i + 1);
    const routes: Record<string, unknown> = { [list]: { values: ids } };
    ids.forEach(id => {
      routes[`${decorators}/${id}`] = decorator(id, '2026-11-14T10:00:00Z');
    });
    const fetch = fakeFetch(routes);
    const read = await readRecordedDeployments(
      new CalmHubClient(base, fetch),
      ref,
      logger(),
    );
    expect(read).toHaveLength(MAX_DEPLOYMENTS);
    expect(read[0].id).toBe(MAX_DEPLOYMENTS + 5);
    expect(fetch.calls).not.toContain(`${decorators}/5`);
  });

  it('gives an empty list and a warning when the Hub does not answer', async () => {
    const log = logger();
    expect(
      await readRecordedDeployments(
        new CalmHubClient(base, fakeFetch({})),
        ref,
        log,
      ),
    ).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/were not read: GET .* -> 404/),
    );
  });
});
