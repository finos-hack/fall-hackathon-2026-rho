import { CALM_ANNOTATIONS as ANN } from '@internal/backstage-plugin-calm-common';
import { serviceEntity } from './publishLocal';
import { resolveBundle } from './template';

const registry = {
  url: 'http://localhost:5050',
  repositoryPrefix: 'calm-bundles',
};
const cacheDir = '/tmp/calm-bundles';

describe('resolveBundle', () => {
  it('uses a local folder in calm.bundles first, without touching the registry', async () => {
    const pull = jest.fn();
    expect(
      await resolveBundle('web-service@2.1.0', {
        bundles: [{ name: 'web-service', version: '2.1.0', path: '/b/2.1.0' }],
        registry,
        cacheDir,
        pull,
      }),
    ).toEqual({ name: 'web-service', version: '2.1.0', dir: '/b/2.1.0' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('pulls from the registry otherwise and gives the reference and digest', async () => {
    const pull = jest.fn(async () => ({
      digest: 'sha256:bbb',
      dir: '/tmp/calm-bundles/bbb',
      cached: false,
    }));
    expect(
      await resolveBundle('web-service@2.0.0', {
        bundles: [{ name: 'web-service', version: '2.1.0', path: '/b/2.1.0' }],
        registry,
        cacheDir,
        pull,
      }),
    ).toEqual({
      name: 'web-service',
      version: '2.0.0',
      dir: '/tmp/calm-bundles/bbb',
      ref: 'localhost:5050/calm-bundles/web-service:2.0.0',
      digest: 'sha256:bbb',
      cached: false,
    });
    expect(pull).toHaveBeenCalledWith({
      ref: 'localhost:5050/calm-bundles/web-service:2.0.0',
      cacheDir,
    });
  });

  it('names the reference when the pull fails', async () => {
    await expect(
      resolveBundle('web-service@9.9.9', {
        bundles: [],
        registry,
        cacheDir,
        pull: async () => {
          throw new Error('GET … -> 404');
        },
      }),
    ).rejects.toThrow(
      'Template bundle "web-service@9.9.9" could not be pulled from localhost:5050/calm-bundles/web-service:9.9.9: GET … -> 404',
    );
  });

  it('rejects a bundle that is nowhere, and a value that is not name@version', async () => {
    await expect(
      resolveBundle('web-service@2.0.0', { bundles: [], cacheDir }),
    ).rejects.toThrow(/no calm.bundleRegistry is configured/);
    await expect(
      resolveBundle('web-service', { bundles: [], registry, cacheDir }),
    ).rejects.toThrow(/must be <name>@<version>/);
  });
});

describe('serviceEntity', () => {
  const base = {
    name: 'orders',
    owner: 'group:default/guests',
    patternId: 'web-service',
    patternVersion: '1.0.0',
    bundleName: 'web-service',
    bundleVersion: '2.0.0',
  };

  it('records the bundle reference and digest of a registry bundle', () => {
    const entity = serviceEntity({
      ...base,
      bundleRef: 'localhost:5050/calm-bundles/web-service:2.0.0',
      bundleDigest: 'sha256:bbb',
    });
    expect(entity.metadata.annotations).toMatchObject({
      [ANN.bundle]: 'web-service',
      [ANN.bundleVersion]: '2.0.0',
      [ANN.bundleRef]: 'localhost:5050/calm-bundles/web-service:2.0.0',
      [ANN.bundleDigest]: 'sha256:bbb',
    });
  });

  it('records neither for a local bundle', () => {
    for (const entity of [
      serviceEntity(base),
      serviceEntity({ ...base, bundleRef: '', bundleDigest: '' }),
    ]) {
      expect(entity.metadata.annotations).not.toHaveProperty(ANN.bundleRef);
      expect(entity.metadata.annotations).not.toHaveProperty(ANN.bundleDigest);
    }
  });
});
