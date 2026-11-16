import { CalmHubClient, CalmHubError, FetchLike } from './hubClient';
import { CalmHubWriteClient } from './hubWriteClient';
import {
  architectureVersionPath,
  deploymentDecorator,
  markServiceArchitecture,
  newestFirst,
  nextPatchVersion,
  recordedDeployment,
  sameJson,
  serviceEntityOf,
} from './hubRecord';

interface Call {
  method: string;
  url: string;
  body?: any;
}

/** Answers `<METHOD> <url>` from `routes` (`{ status, body }`); anything else is a 404. */
function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: any) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(init.body) } : {}),
    });
    const route = routes[`${method} ${url}`];
    const status = route ? route.status ?? 200 : 404;
    const text =
      typeof route?.body === 'string'
        ? route.body
        : JSON.stringify(route?.body ?? '');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => (route ? text : 'Resource not found'),
    };
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const base = 'http://hub:8090';
const versionUrl = `${base}/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0`;
const decorators = `${base}/api/calm/namespaces/hackathon/decorators`;

describe('CalmHubWriteClient', () => {
  it('posts an architecture version to the name-based API and gives its URL', async () => {
    const fetch = fakeFetch({ [`POST ${versionUrl}`]: { status: 201 } });
    const client = new CalmHubWriteClient(`${base}/`, fetch);
    const doc = { $id: versionUrl, nodes: [] };
    expect(
      await client.createArchitectureVersion(
        'hackathon',
        'billing-api',
        '1.0.0',
        doc,
      ),
    ).toBe(versionUrl);
    expect(fetch.calls).toEqual([
      { method: 'POST', url: versionUrl, body: doc },
    ]);
  });

  it('throws a CalmHubError with the status and the Hub text when the version exists', async () => {
    const client = new CalmHubWriteClient(
      base,
      fakeFetch({
        [`POST ${versionUrl}`]: {
          status: 409,
          body: 'Version 1.0.0 already exists',
        },
      }),
    );
    const write = client.createArchitectureVersion(
      'hackathon',
      'billing-api',
      '1.0.0',
      {},
    );
    await expect(write).rejects.toBeInstanceOf(CalmHubError);
    await expect(write).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Version 1.0.0 already exists'),
    });
  });

  it('posts a decorator and gives the id the Hub answers with', async () => {
    const fetch = fakeFetch({
      [`POST ${decorators}`]: { status: 201, body: { id: 7 } },
    });
    const client = new CalmHubWriteClient(base, fetch);
    expect(await client.createDecorator('hackathon', { type: 'x' })).toBe(7);
    expect(fetch.calls[0]).toEqual({
      method: 'POST',
      url: decorators,
      body: { type: 'x' },
    });
  });

  it('fails when the Hub gives no decorator id', async () => {
    const client = new CalmHubWriteClient(
      base,
      fakeFetch({ [`POST ${decorators}`]: { status: 201, body: {} } }),
    );
    await expect(client.createDecorator('hackathon', {})).rejects.toThrow(
      /gave no decorator id/,
    );
  });

  it('lists decorator ids by target and type, and reads one in the shape the Hub returns', async () => {
    const target =
      '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0';
    const fetch = fakeFetch({
      [`GET ${decorators}?target=${encodeURIComponent(
        target,
      )}&type=deployment`]: { body: { values: [7, 9] } },
      [`GET ${decorators}/7`]: {
        // The Hub's answer: camel case at the top, `data` as posted.
        body: {
          uniqueId: 'billing-api-run-1',
          type: 'deployment',
          target: [target],
          targetType: ['architecture'],
          appliesTo: ['web-service'],
          data: { status: 'completed', 'start-time': '2026-11-14T12:00:00Z' },
        },
      },
    });
    const client = new CalmHubWriteClient(base, fetch);
    expect(
      await client.listDecorators('hackathon', { target, type: 'deployment' }),
    ).toEqual([7, 9]);
    expect(await client.getDecorator('hackathon', 7)).toEqual({
      id: 7,
      uniqueId: 'billing-api-run-1',
      type: 'deployment',
      target: [target],
      targetType: ['architecture'],
      appliesTo: ['web-service'],
      data: { status: 'completed', 'start-time': '2026-11-14T12:00:00Z' },
    });
  });
});

describe('hub record helpers', () => {
  it('builds the path of an architecture version and the next patch version', () => {
    expect(architectureVersionPath('hackathon', 'billing-api', '1.0.0')).toBe(
      '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0',
    );
    expect(nextPatchVersion('1.0.9')).toBe('1.0.10');
    expect(() => nextPatchVersion('1.0')).toThrow(/Not a/);
  });

  it('compares JSON without regard to key order', () => {
    expect(
      sameJson({ a: 1, b: [{ c: 2, d: 3 }] }, { b: [{ d: 3, c: 2 }], a: 1 }),
    ).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson({ a: null }, { a: {} })).toBe(false);
  });

  it("marks an architecture as a service's, in object and list metadata, and reads the mark back", () => {
    const ref = 'component:default/billing-api';
    expect(serviceEntityOf({ nodes: [] })).toBeUndefined();
    expect(markServiceArchitecture({ nodes: [] }, ref)).toEqual({
      nodes: [],
      metadata: { 'calm-backstage': { entity: ref } },
    });
    const listed = markServiceArchitecture({ metadata: [{ team: 'a' }] }, ref);
    expect(listed.metadata).toEqual([
      { team: 'a' },
      { 'calm-backstage': { entity: ref } },
    ]);
    expect(serviceEntityOf(listed)).toBe(ref);
    expect(
      serviceEntityOf(
        markServiceArchitecture({ metadata: { team: 'a' } }, ref),
      ),
    ).toBe(ref);
  });

  it('builds a deployment decorator in the posted (kebab case) shape', () => {
    expect(
      deploymentDecorator({
        uniqueId: 'billing-api-run-1',
        target:
          '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0',
        appliesTo: ['web-service'],
        status: 'completed',
        startTime: '2026-11-14T12:00:00.000Z',
        endTime: '2026-11-14T12:00:30.000Z',
        details: 'http://localhost:3100/catalog/default/component/billing-api',
        notes: 'cluster calm-backstage',
      }),
    ).toEqual({
      $schema:
        'https://calm.finos.org/draft/2026-03/standards/deployment/deployment.decorator.standard.json',
      'unique-id': 'billing-api-run-1',
      type: 'deployment',
      target: [
        '/calm/namespaces/hackathon/architectures/billing-api/versions/1.0.0',
      ],
      'target-type': ['architecture'],
      'applies-to': ['web-service'],
      data: {
        'start-time': '2026-11-14T12:00:00.000Z',
        'end-time': '2026-11-14T12:00:30.000Z',
        status: 'completed',
        'deployment-details':
          'http://localhost:3100/catalog/default/component/billing-api',
        notes: 'cluster calm-backstage',
      },
    });
  });

  it('refuses a target the Hub could not filter on, a status outside the standard and a bad time', () => {
    const ok = {
      uniqueId: 'x',
      target: '/calm/namespaces/hackathon/architectures/x/versions/1.0.0',
      appliesTo: [],
      status: 'completed' as const,
      startTime: '2026-11-14T12:00:00Z',
    };
    expect(() =>
      deploymentDecorator({ ...ok, target: 'http://hub:8090/calm/x' }),
    ).toThrow(/would not be found again/);
    expect(() => deploymentDecorator({ ...ok, status: 'done' as any })).toThrow(
      /must be one of pending, in-progress, completed/,
    );
    expect(() => deploymentDecorator({ ...ok, startTime: 'noon' })).toThrow(
      /start time is not a date-time/,
    );
  });

  it('maps decorators to recorded deployments, newest first', () => {
    const d = (id: number, start?: string) =>
      recordedDeployment({
        id,
        uniqueId: `run-${id}`,
        type: 'deployment',
        target: [],
        targetType: ['architecture'],
        appliesTo: ['web-service'],
        data: {
          status: 'completed',
          ...(start ? { 'start-time': start } : {}),
          'deployment-details': 'http://localhost:3100/x',
          notes: 'n',
        },
      });
    expect(d(3, '2026-11-14T12:00:00Z')).toEqual({
      id: 3,
      uniqueId: 'run-3',
      status: 'completed',
      startTime: '2026-11-14T12:00:00Z',
      notes: 'n',
      details: 'http://localhost:3100/x',
      appliesTo: ['web-service'],
    });
    expect(
      newestFirst([
        d(1, '2026-11-14T10:00:00Z'),
        d(2),
        d(3, '2026-11-14T12:00:00Z'),
        d(4, '2026-11-14T11:00:00Z'),
      ]).map(x => x.id),
    ).toEqual([3, 4, 1, 2]);
  });
});

describe('CalmHubClient.withSignal', () => {
  /** A fetch that keeps the init of each call and answers 200 with an empty list. */
  const recordingFetch = () => {
    const inits: any[] = [];
    const fn = (async (_url: string, init?: any) => {
      inits.push(init);
      return {
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      };
    }) as FetchLike;
    return { fn, inits };
  };

  it('sends the signal with a GET and with a POST, keeping the rest of the request', async () => {
    const { fn, inits } = recordingFetch();
    const signal = new AbortController().signal;
    const client = new CalmHubWriteClient(base, fn).withSignal(signal);
    await client.get('/api/calm/namespaces');
    await client.createArchitectureVersion(
      'hackathon',
      'billing-api',
      '1.0.0',
      {
        id: 'x',
      },
    );
    expect(inits[0].signal).toBe(signal);
    expect(inits[0].headers).toEqual({ Accept: 'application/json' });
    expect(inits[1].signal).toBe(signal);
    expect(inits[1].method).toBe('POST');
    expect(inits[1].body).toContain('"id":"x"');
  });

  it('leaves the original client without a signal', async () => {
    const { fn, inits } = recordingFetch();
    const original = new CalmHubWriteClient(base, fn);
    original.withSignal(new AbortController().signal);
    await original.get('/api/calm/namespaces');
    expect(inits[0].signal).toBeUndefined();
  });

  it('is still the subclass it was made from', () => {
    const { fn } = recordingFetch();
    const copy = new CalmHubWriteClient(base, fn).withSignal(
      new AbortController().signal,
    );
    expect(copy).toBeInstanceOf(CalmHubWriteClient);
    expect(copy.baseUrl).toBe(base);
  });

  it('gives a subclass method that reads fetchImpl the signal too', async () => {
    class Putting extends CalmHubWriteClient {
      async put(): Promise<void> {
        const doFetch: FetchLike =
          (this as any).fetchImpl ?? ((globalThis as any).fetch as FetchLike);
        await doFetch(`${this.baseUrl}/x`, { method: 'PUT' });
      }
    }
    const { fn, inits } = recordingFetch();
    const signal = new AbortController().signal;
    const copy = new Putting(base, fn).withSignal(signal);
    expect(copy).toBeInstanceOf(Putting);
    await copy.put();
    expect(inits[0]).toMatchObject({ method: 'PUT', signal });
  });

  it('wraps the global fetch when the client has no fetch of its own', async () => {
    const { fn, inits } = recordingFetch();
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = fn;
    try {
      const signal = new AbortController().signal;
      await new CalmHubClient(base).withSignal(signal).get('/x');
      expect(inits[0].signal).toBe(signal);
    } finally {
      (globalThis as any).fetch = real;
    }
  });
});
