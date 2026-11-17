import { CALM_ANNOTATIONS as ANN } from '@internal/backstage-plugin-calm-common';
import { OciError } from '@internal/backstage-plugin-calm-node';
import {
  BundleRegistryClient,
  MAX_KEPT_REFRESHES,
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
const ref1 = 'localhost:5050/calm-bundles/web-service:1.0.0';
const manifest1 =
  'http://localhost:5050/v2/calm-bundles/web-service/manifests/1.0.0';
const digestOf = (ref: string) =>
  `sha256:${ref.endsWith('1.0.0') ? 'aaa' : 'bbb'}`;

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
      digest: digestOf(ref),
      config: { description: `bundle at ${ref}`, pattern },
    }),
    headBundleDigest: async ref => digestOf(ref),
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

  it('reads a tag a second time when the first read fails', async () => {
    const reads: string[] = [];
    const heads: string[] = [];
    const read = await readRegistryBundles(
      registry,
      fakeClient({
        readBundleConfig: async ref => {
          reads.push(ref);
          if (ref === ref1 && reads.filter(r => r === ref1).length === 1) {
            throw new Error('read ECONNRESET');
          }
          return { digest: digestOf(ref), config: {} };
        },
        headBundleDigest: async ref => {
          heads.push(ref);
          return digestOf(ref);
        },
      }),
    );
    expect(read.bundles.map(b => [b.version, b.digest])).toEqual([
      ['1.0.0', 'sha256:aaa'],
      ['2.0.0', 'sha256:bbb'],
    ]);
    expect(read.warnings).toEqual([]);
    expect(read.unread).toEqual([]);
    expect(reads.filter(r => r === ref1)).toHaveLength(2);
    expect(heads).toEqual([]);
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
  /** A client whose 1.0.0 read fails while `broken()` says so, with a HEAD that `head` answers. */
  function brokenClient(
    broken: () => boolean,
    head: (ref: string) => Promise<string | undefined>,
    error: unknown = new Error('read ECONNRESET'),
    overrides: Partial<BundleRegistryClient> = {},
  ) {
    return fakeClient({
      readBundleConfig: async ref => {
        if (broken() && ref === ref1) {
          throw error;
        }
        return {
          digest: digestOf(ref),
          config: { description: `bundle at ${ref}`, pattern },
        };
      },
      headBundleDigest: head,
      ...overrides,
    });
  }

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

  it('serves a fresh read when a tag reads on the second try, without a HEAD', async () => {
    let failNext = false;
    const heads: string[] = [];
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => {
          const fail = failNext;
          failNext = false;
          return fail;
        },
        async ref => {
          heads.push(ref);
          return digestOf(ref);
        },
      ),
    );
    await read();
    failNext = true;
    const second = await read();
    expect(second.bundles.map(b => b.version)).toEqual(['1.0.0', '2.0.0']);
    expect(second.warnings).toEqual([]);
    expect(heads).toEqual([]);
  });

  it(`keeps the last copy of a bundle that cannot be read while a HEAD gives its digest, for ${MAX_KEPT_REFRESHES} refreshes`, async () => {
    let broken = false;
    const heads: string[] = [];
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => broken,
        async ref => {
          heads.push(ref);
          return digestOf(ref);
        },
        new Error('Digest mismatch'),
      ),
    );
    const first = await read();
    expect(first.warnings).toEqual([]);

    broken = true;
    for (let n = 1; n <= MAX_KEPT_REFRESHES; n++) {
      const next = await read();
      expect(next.failed).toBeUndefined();
      expect(next.bundles).toEqual(first.bundles);
      expect(next.bundles[0]).toBe(first.bundles[0]);
      expect(next.warnings).toEqual([
        `bundle ${ref1} not read: Error: Digest mismatch; keeping the copy from an earlier read (${n} of ${MAX_KEPT_REFRESHES}), the tag still has manifest sha256:aaa`,
      ]);
    }
    expect(heads).toEqual(Array(MAX_KEPT_REFRESHES).fill(ref1));

    const dropped = await read();
    expect(dropped.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(dropped.warnings).toEqual([
      `bundle ${ref1} not read: Error: Digest mismatch; skipped, not read for ${
        MAX_KEPT_REFRESHES + 1
      } refreshes in a row`,
    ]);
  });

  it('keeps the copy when the config blob answers 404 but the manifest is still there', async () => {
    const blob =
      'http://localhost:5050/v2/calm-bundles/web-service/blobs/sha256:ccc';
    let broken = false;
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => broken,
        async ref => digestOf(ref),
        new OciError(404, blob, `GET ${blob} -> 404`),
      ),
    );
    const first = await read();
    broken = true;
    const second = await read();
    expect(second.bundles).toEqual(first.bundles);
    expect(second.warnings).toEqual([
      `bundle ${ref1} not read: OciError: GET ${blob} -> 404; keeping the copy from an earlier read (1 of ${MAX_KEPT_REFRESHES}), the tag still has manifest sha256:aaa`,
    ]);
  });

  it('drops the copy when a HEAD shows the tag was pushed over', async () => {
    let broken = false;
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => broken,
        async ref => (broken && ref === ref1 ? 'sha256:new' : digestOf(ref)),
      ),
    );
    await read();
    broken = true;
    const second = await read();
    expect(second.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(second.warnings).toEqual([
      `bundle ${ref1} not read: Error: read ECONNRESET; skipped, the tag now has manifest sha256:new, the earlier copy is of sha256:aaa`,
    ]);
  });

  it('drops the copy when the manifest answers 404 to the read and to a HEAD, and a listing failure does not bring it back', async () => {
    let state: 'up' | 'gone' | 'down' = 'up';
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => state !== 'up',
        async ref =>
          state !== 'up' && ref === ref1 ? undefined : digestOf(ref),
        new OciError(404, manifest1, `GET ${manifest1} -> 404`),
        {
          listRepositories: async () => {
            if (state === 'down') {
              throw new Error('connect ECONNREFUSED');
            }
            return ['calm-bundles/web-service'];
          },
        },
      ),
    );
    await read();

    state = 'gone';
    const second = await read();
    expect(second.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(second.warnings).toEqual([
      `bundle ${ref1} not read: OciError: GET ${manifest1} -> 404; skipped, the registry has no manifest under the tag`,
    ]);

    state = 'down';
    expect((await read()).bundles).toEqual(second.bundles);
  });

  it(`keeps the copy for ${MAX_KEPT_REFRESHES} refreshes while the HEAD fails too, then drops it`, async () => {
    let state: 'up' | 'broken' | 'down' = 'up';
    const headError = new OciError(
      0,
      manifest1,
      `HEAD ${manifest1} failed: ECONNREFUSED`,
    );
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => state !== 'up',
        async ref => {
          if (ref === ref1) {
            throw headError;
          }
          return digestOf(ref);
        },
        new Error('read ECONNRESET'),
        {
          listRepositories: async () => {
            if (state === 'down') {
              throw new Error('connect ECONNREFUSED');
            }
            return ['calm-bundles/web-service'];
          },
        },
      ),
    );
    const first = await read();
    state = 'broken';
    for (let n = 1; n <= MAX_KEPT_REFRESHES; n++) {
      const next = await read();
      expect(next.bundles).toEqual(first.bundles);
      expect(next.warnings).toEqual([
        `bundle ${ref1} not read: Error: read ECONNRESET; keeping the copy from an earlier read (${n} of ${MAX_KEPT_REFRESHES}), its manifest could not be checked: ${headError}`,
      ]);
    }
    const dropped = await read();
    expect(dropped.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(dropped.warnings).toEqual([
      `bundle ${ref1} not read: Error: read ECONNRESET; skipped, not read for ${
        MAX_KEPT_REFRESHES + 1
      } refreshes in a row`,
    ]);

    // Gone from the last good read, so a listing failure does not bring it back.
    state = 'down';
    expect((await read()).bundles).toEqual(dropped.bundles);
  });

  it('counts kept refreshes again from one after a good read', async () => {
    let broken = false;
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => broken,
        async () => {
          throw new Error('HEAD failed');
        },
      ),
    );
    await read();
    broken = true;
    for (let n = 1; n < MAX_KEPT_REFRESHES; n++) {
      await read();
    }
    broken = false;
    expect((await read()).warnings).toEqual([]);
    broken = true;
    const again = await read();
    expect(again.bundles.map(b => b.version)).toEqual(['1.0.0', '2.0.0']);
    expect(again.warnings).toEqual([
      `bundle ${ref1} not read: Error: read ECONNRESET; keeping the copy from an earlier read (1 of ${MAX_KEPT_REFRESHES}), its manifest could not be checked: Error: HEAD failed`,
    ]);
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
    const heads: string[] = [];
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => true,
        async ref => {
          heads.push(ref);
          return digestOf(ref);
        },
        new Error('Digest mismatch'),
      ),
    );
    const first = await read();
    expect(first.failed).toBeUndefined();
    expect(first.bundles.map(b => b.version)).toEqual(['2.0.0']);
    expect(first.warnings).toEqual([
      `bundle ${ref1} skipped: Error: Digest mismatch`,
    ]);
    expect(heads).toEqual([]);
  });

  it('still gives the last good bundles, kept copies included, when the registry then cannot be listed', async () => {
    let state: 'up' | 'one-unreadable' | 'down' = 'up';
    const read = lastGoodRegistryReader(
      registry,
      brokenClient(
        () => state === 'one-unreadable',
        async ref => digestOf(ref),
        new Error('read ECONNRESET'),
        {
          listRepositories: async () => {
            if (state === 'down') {
              throw new Error('connect ECONNREFUSED');
            }
            return ['calm-bundles/web-service'];
          },
        },
      ),
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
  // The import Template is always emitted; these tests are about the bundle entities.
  const buildWithoutImport = (snap: Parameters<typeof buildEntities>[0]) => {
    const built = buildEntities(snap);
    return {
      ...built,
      entities: built.entities.filter(
        e => e.metadata.name !== 'calm-import-diagram',
      ),
    };
  };
  const snapshot = (bundles: BundleInfo[]) => ({
    hubUrl: 'http://localhost:8090',
    patterns: [],
    architectures: [],
    controls: [],
    bundles,
  });

  it('records the reference and digest of a registry bundle', () => {
    const { entities } = buildWithoutImport(
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
    const { entities } = buildWithoutImport(
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
