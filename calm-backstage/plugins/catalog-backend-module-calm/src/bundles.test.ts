import { CALM_ANNOTATIONS as ANN } from '@internal/backstage-plugin-calm-common';
import {
  BundleRegistryClient,
  mergeBundles,
  lastGoodRegistryReader,
  readRegistryBundles,
} from './bundles';
import { BundleInfo, buildEntities } from './entities';

const registry = {
  url: 'http://localhost:5050',
  repositoryPrefix: 'calm-bundles',
};
const pattern = { namespace: 'hackathon', patternId: 'web-service' };

function fakeClient(
  overrides: Partial<BundleRegistryClient> = {},
): BundleRegistryClient {
  return {
    listRepositories: async (url, prefix) => {
      expect(url).toBe(registry.url);
      expect(prefix).toBe('calm-bundles');
      return ['calm-bundles/web-service'];
    },
    listTags: async () => ['1.0.0', '2.0.0'],
    readBundleConfig: async ref => ({
      digest: `sha256:${ref.endsWith('1.0.0') ? 'aaa' : 'bbb'}`,
      config: { description: `bundle at ${ref}`, pattern },
    }),
    ...overrides,
  };
}

describe('readRegistryBundles', () => {
  it('gives one bundle per tag, with its reference, digest and config', async () => {
    const read = await readRegistryBundles(registry, fakeClient());
    expect(read.warnings).toEqual([]);
    expect(read.unread).toEqual([]);
    expect(JSON.parse(JSON.stringify(read.bundles))).toEqual([
      {
        name: 'web-service',
        version: '1.0.0',
        ref: 'localhost:5050/calm-bundles/web-service:1.0.0',
        digest: 'sha256:aaa',
        description: 'bundle at localhost:5050/calm-bundles/web-service:1.0.0',
        kind: 'full',
        patterns: [pattern],
      },
      {
        name: 'web-service',
        version: '2.0.0',
        ref: 'localhost:5050/calm-bundles/web-service:2.0.0',
        digest: 'sha256:bbb',
        description: 'bundle at localhost:5050/calm-bundles/web-service:2.0.0',
        kind: 'full',
        patterns: [pattern],
      },
    ]);
  });

  it('leaves out a tag it cannot read and says so', async () => {
    const read = await readRegistryBundles(
      registry,
      fakeClient({
        readBundleConfig: async ref => {
          if (ref.endsWith(':1.0.0')) {
            throw new Error('Digest mismatch');
          }
          return { digest: 'sha256:bbb', config: {} };
        },
      }),
    );
    expect(read.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(read.bundles[0].patterns).toEqual([]);
    expect(read.warnings).toEqual([
      'bundle localhost:5050/calm-bundles/web-service:1.0.0 skipped: Error: Digest mismatch',
    ]);
    expect(read.unread).toEqual([{ name: 'web-service', version: '1.0.0' }]);
  });

  it('throws when the registry cannot be listed', async () => {
    await expect(
      readRegistryBundles(
        registry,
        fakeClient({
          listRepositories: async () => {
            throw new Error('ECONNREFUSED');
          },
        }),
      ),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('lastGoodRegistryReader', () => {
  it('keeps the bundles of the last read that worked while the registry cannot be listed', async () => {
    let down = false;
    const read = lastGoodRegistryReader(
      registry,
      fakeClient({
        listRepositories: async () => {
          if (down) {
            throw new Error('connect ECONNREFUSED');
          }
          return ['calm-bundles/web-service'];
        },
      }),
    );
    const first = await read();
    expect(first.failed).toBeUndefined();
    expect(first.bundles.map(b => b.version)).toEqual(['1.0.0', '2.0.0']);

    down = true;
    const second = await read();
    expect(String(second.failed)).toMatch(/ECONNREFUSED/);
    expect(second.bundles).toEqual(first.bundles);
  });

  it('gives no bundles when the registry has never been read', async () => {
    const read = lastGoodRegistryReader(
      registry,
      fakeClient({
        listRepositories: async () => {
          throw new Error('down');
        },
      }),
    );
    expect((await read()).bundles).toEqual([]);
  });

  it('keeps the last copy of a bundle that is still listed but cannot be read, and says so', async () => {
    let broken = false;
    const read = lastGoodRegistryReader(
      registry,
      fakeClient({
        readBundleConfig: async ref => {
          if (broken && ref.endsWith(':1.0.0')) {
            throw new Error('read ECONNRESET');
          }
          return {
            digest: `sha256:${broken ? 'new' : 'old'}-${ref.slice(-5)}`,
            config: { description: `bundle at ${ref}`, pattern },
          };
        },
      }),
    );
    const first = await read();
    expect(first.warnings).toEqual([]);

    broken = true;
    const second = await read();
    expect(second.failed).toBeUndefined();
    expect(second.bundles.map(b => [b.version, b.digest])).toEqual([
      ['1.0.0', 'sha256:old-1.0.0'],
      ['2.0.0', 'sha256:new-2.0.0'],
    ]);
    expect(second.bundles[0]).toBe(first.bundles[0]);
    expect(second.warnings).toEqual([
      'bundle localhost:5050/calm-bundles/web-service:1.0.0 not read, keeping the copy from an earlier read: Error: read ECONNRESET',
    ]);

    // The kept copy is part of the last good read, so it survives a second failure too.
    const third = await read();
    expect(third.bundles).toEqual(second.bundles);
    expect(third.warnings).toEqual(second.warnings);
  });

  it('drops a bundle whose tag the registry no longer lists', async () => {
    let tags = ['1.0.0', '2.0.0'];
    const read = lastGoodRegistryReader(
      registry,
      fakeClient({ listTags: async () => tags }),
    );
    expect((await read()).bundles.map(b => b.version)).toEqual([
      '1.0.0',
      '2.0.0',
    ]);

    tags = ['2.0.0'];
    const second = await read();
    expect(second.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(second.warnings).toEqual([]);
  });

  it('leaves out a bundle that cannot be read and was never read before', async () => {
    const read = lastGoodRegistryReader(
      registry,
      fakeClient({
        readBundleConfig: async ref => {
          if (ref.endsWith(':1.0.0')) {
            throw new Error('Digest mismatch');
          }
          return { digest: 'sha256:bbb', config: {} };
        },
      }),
    );
    const first = await read();
    expect(first.failed).toBeUndefined();
    expect(first.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(first.warnings).toEqual([
      'bundle localhost:5050/calm-bundles/web-service:1.0.0 skipped: Error: Digest mismatch',
    ]);
  });

  it('still gives the last good bundles, kept copies included, when the registry then cannot be listed', async () => {
    let state: 'up' | 'one-unreadable' | 'down' = 'up';
    const read = lastGoodRegistryReader(
      registry,
      fakeClient({
        listRepositories: async () => {
          if (state === 'down') {
            throw new Error('connect ECONNREFUSED');
          }
          return ['calm-bundles/web-service'];
        },
        readBundleConfig: async ref => {
          if (state === 'one-unreadable' && ref.endsWith(':2.0.0')) {
            throw new Error('read ECONNRESET');
          }
          return { digest: `sha256:${ref.slice(-5)}`, config: {} };
        },
      }),
    );
    const first = await read();
    state = 'one-unreadable';
    expect((await read()).bundles).toEqual(first.bundles);

    state = 'down';
    const third = await read();
    expect(String(third.failed)).toMatch(/ECONNREFUSED/);
    expect(third.warnings).toEqual([]);
    expect(third.bundles).toEqual(first.bundles);
  });
});

describe('mergeBundles', () => {
  const local: BundleInfo[] = [
    { name: 'web-service', version: '2.0.0', path: '/b/2.0.0' },
    { name: 'web-service', version: '2.1.0', path: '/b/2.1.0' },
  ];
  const fromRegistry: BundleInfo[] = [
    { name: 'web-service', version: '1.0.0', ref: 'r:1.0.0', digest: 'd1' },
    { name: 'web-service', version: '2.0.0', ref: 'r:2.0.0', digest: 'd2' },
  ];

  it('lets a local folder take the place of a registry bundle of the same name and version, as calm:template does', () => {
    const { bundles, replaced } = mergeBundles(local, fromRegistry);
    expect(replaced).toEqual(['web-service@2.0.0']);
    expect(bundles).toEqual([...local, fromRegistry[0]]);
  });

  it('keeps the local folders when the registry gave nothing', () => {
    expect(mergeBundles(local, [])).toEqual({ bundles: local, replaced: [] });
  });
});

describe('bundle entities', () => {
  const snapshot = (bundles: BundleInfo[]) => ({
    hubUrl: 'http://localhost:8090',
    patterns: [],
    architectures: [],
    controls: [],
    bundles,
  });

  it('records the reference and digest of a registry bundle', () => {
    const { entities } = buildEntities(
      snapshot([
        {
          name: 'web-service',
          version: '2.0.0',
          ref: 'localhost:5050/calm-bundles/web-service:2.0.0',
          digest: 'sha256:bbb',
          description: 'v2 layout.',
          pattern,
        },
      ]),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0].metadata.name).toBe('bundle-web-service-2.0.0');
    expect(entities[0].metadata.annotations).toMatchObject({
      [ANN.bundle]: 'web-service',
      [ANN.bundleVersion]: '2.0.0',
      [ANN.bundleRef]: 'localhost:5050/calm-bundles/web-service:2.0.0',
      [ANN.bundleDigest]: 'sha256:bbb',
    });
    expect(entities[0].metadata.description).toBe(
      'v2 layout.\n\nStored in the OCI bundle registry as localhost:5050/calm-bundles/web-service:2.0.0.',
    );
  });

  it('leaves both off a local bundle', () => {
    const { entities } = buildEntities(
      snapshot([{ name: 'web-service', version: '2.1.0', path: '/b/2.1.0' }]),
    );
    expect(entities[0].metadata.annotations).not.toHaveProperty(ANN.bundleRef);
    expect(entities[0].metadata.annotations).not.toHaveProperty(
      ANN.bundleDigest,
    );
    expect(entities[0].metadata.description).toBe(
      'CALM template bundle web-service 2.1.0',
    );
  });
});

describe('deployable bundles', () => {
  it('reads deploy from the bundle config', async () => {
    const read = await readRegistryBundles(
      registry,
      fakeClient({
        listTags: async () => ['3.0.0'],
        readBundleConfig: async () => ({
          digest: 'sha256:ccc',
          config: { deploy: 'kubernetes', pattern },
        }),
      }),
    );
    expect(read.bundles[0].deploy).toBe('kubernetes');
  });
});
