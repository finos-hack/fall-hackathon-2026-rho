import {
  CalmHubClient,
  CalmHubError,
  FetchLike,
  latestVersion,
  parsePatternUrl,
  parseRequirementUrl,
  requirementUrls,
} from './hubClient';

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

describe('CalmHubClient', () => {
  const base = 'http://hub:8090';

  it('unwraps lists and reads documents through the name-based API', async () => {
    const fetch = fakeFetch({
      [`${base}/api/calm/namespaces`]: {
        values: [{ name: 'finos' }, { name: 'hackathon' }],
      },
      [`${base}/calm/namespaces/hackathon/patterns`]: {
        values: [{ customId: 'web-service', namespace: 'hackathon' }],
      },
      [`${base}/calm/namespaces/hackathon/patterns/web-service/versions`]: {
        values: ['1.0.0'],
      },
      [`${base}/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0`]:
        { $id: 'x', title: 'Web Service' },
      [`${base}/calm/domains/hackathon-security/controls`]: {
        values: [{ id: 42, name: 'permitted-connection' }],
      },
    });
    const client = new CalmHubClient(`${base}/`, fetch);
    expect(await client.namespaces()).toEqual(['finos', 'hackathon']);
    expect(await client.patterns('hackathon')).toEqual([
      { customId: 'web-service', namespace: 'hackathon' },
    ]);
    expect(await client.patternVersions('hackathon', 'web-service')).toEqual([
      '1.0.0',
    ]);
    expect(await client.pattern('hackathon', 'web-service', '1.0.0')).toEqual({
      $id: 'x',
      title: 'Web Service',
    });
    expect(await client.controls('hackathon-security')).toEqual([
      { id: 42, name: 'permitted-connection' },
    ]);
  });

  it('throws a CalmHubError with the status on a failed read', async () => {
    const client = new CalmHubClient(base, fakeFetch({}));
    await expect(client.architectures('nope')).rejects.toBeInstanceOf(
      CalmHubError,
    );
    await expect(client.architectures('nope')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('helpers', () => {
  it('picks the latest version numerically', () => {
    expect(latestVersion(['1.10.0', '1.9.0', '2.0.0-SNAPSHOT', '1.2.0'])).toBe(
      '2.0.0-SNAPSHOT',
    );
    expect(latestVersion(['2.0.0-SNAPSHOT', '2.0.0'])).toBe('2.0.0');
    expect(latestVersion([])).toBeUndefined();
  });

  it('parses pattern and requirement URLs and finds requirement URLs in a document', () => {
    expect(
      parsePatternUrl(
        'http://localhost:8090/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0',
      ),
    ).toEqual({ namespace: 'hackathon', id: 'web-service', version: '1.0.0' });
    expect(
      parsePatternUrl('https://calm.finos.org/release/1.3/meta/calm.json'),
    ).toBeUndefined();
    const req =
      'http://localhost:8090/calm/domains/hackathon-security/controls/permitted-connection/requirement/versions/1.0.0';
    expect(parseRequirementUrl(req)).toEqual({
      domain: 'hackathon-security',
      control: 'permitted-connection',
      version: '1.0.0',
    });
    expect(
      requirementUrls({
        a: [{ 'requirement-url': { const: req } }],
        b: { c: { 'requirement-url': req } },
      }),
    ).toEqual([req]);
  });
});
