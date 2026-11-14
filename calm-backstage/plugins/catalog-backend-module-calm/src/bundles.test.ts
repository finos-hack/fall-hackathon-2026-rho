import { CALM_ANNOTATIONS as ANN } from '@internal/backstage-plugin-calm-common';
import {
  BundleRegistryClient,
  mergeBundles,
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
    expect(read.bundles).toEqual([
      {
        name: 'web-service',
        version: '1.0.0',
        ref: 'localhost:5050/calm-bundles/web-service:1.0.0',
        digest: 'sha256:aaa',
        description: 'bundle at localhost:5050/calm-bundles/web-service:1.0.0',
        pattern,
      },
      {
        name: 'web-service',
        version: '2.0.0',
        ref: 'localhost:5050/calm-bundles/web-service:2.0.0',
        digest: 'sha256:bbb',
        description: 'bundle at localhost:5050/calm-bundles/web-service:2.0.0',
        pattern,
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
    expect(read.bundles[0].pattern).toBeUndefined();
    expect(read.warnings).toEqual([
      'bundle localhost:5050/calm-bundles/web-service:1.0.0 skipped: Error: Digest mismatch',
    ]);
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

describe('mergeBundles', () => {
  const local: BundleInfo[] = [
    { name: 'web-service', version: '2.0.0', path: '/b/2.0.0' },
    { name: 'web-service', version: '2.1.0', path: '/b/2.1.0' },
  ];
  const fromRegistry: BundleInfo[] = [
    { name: 'web-service', version: '1.0.0', ref: 'r:1.0.0', digest: 'd1' },
    { name: 'web-service', version: '2.0.0', ref: 'r:2.0.0', digest: 'd2' },
  ];

  it('lets a registry bundle take the place of a local folder of the same name and version', () => {
    const { bundles, replaced } = mergeBundles(local, fromRegistry);
    expect(replaced).toEqual(['web-service@2.0.0']);
    expect(bundles).toEqual([local[1], ...fromRegistry]);
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
