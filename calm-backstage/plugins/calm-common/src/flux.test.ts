import {
  fluxObjects,
  gitopsAnnotationValue,
  readFluxStatus,
  revisionCommit,
  revisionHasCommit,
} from './flux';

const sha = '60177ebbea44d47ed9d54851a9287c18fc822cfa';

describe('flux', () => {
  it('builds a GitRepository and Kustomization named calm-orders in flux-system with path ./deploy/k8s-overlay and prune true', () => {
    const [repo, ks] = fluxObjects({
      name: 'orders',
      repoUrl: 'http://host.minikube.internal:3300/calm-services/orders.git',
      branch: 'main',
    }) as any[];
    expect(repo).toMatchObject({
      kind: 'GitRepository',
      metadata: { name: 'calm-orders', namespace: 'flux-system' },
      spec: {
        url: 'http://host.minikube.internal:3300/calm-services/orders.git',
        ref: { branch: 'main' },
        interval: '1m',
      },
    });
    expect(ks).toMatchObject({
      kind: 'Kustomization',
      metadata: { name: 'calm-orders', namespace: 'flux-system' },
      spec: {
        path: './deploy/k8s-overlay',
        prune: true,
        sourceRef: { kind: 'GitRepository', name: 'calm-orders' },
      },
    });
    expect(gitopsAnnotationValue('orders')).toBe('flux-system/calm-orders');
  });

  it('reads the Ready condition and the applied revision', () => {
    expect(
      readFluxStatus({
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'True',
              message: `Applied revision: main@sha1:${sha}`,
            },
          ],
          lastAppliedRevision: `main@sha1:${sha}`,
        },
      }),
    ).toEqual({
      ready: true,
      message: `Applied revision: main@sha1:${sha}`,
      appliedRevision: `main@sha1:${sha}`,
    });
    expect(readFluxStatus({})).toEqual({
      ready: false,
      message: 'no Ready condition yet',
    });
  });

  it('revisionHasCommit accepts main@sha1:<sha> and rejects another sha', () => {
    expect(revisionCommit(`main@sha1:${sha}`)).toBe(sha);
    expect(revisionHasCommit(`main@sha1:${sha}`, sha)).toBe(true);
    expect(revisionHasCommit(sha, sha)).toBe(true);
    expect(revisionHasCommit(`main@sha1:${'0'.repeat(40)}`, sha)).toBe(false);
    expect(revisionHasCommit(undefined, sha)).toBe(false);
    expect(revisionHasCommit(`main@sha1:${sha}`, '')).toBe(false);
  });
});
