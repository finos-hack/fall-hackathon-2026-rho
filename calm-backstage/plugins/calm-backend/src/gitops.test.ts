import { gitopsInfo, kustomizationOf } from './gitops';

const entity = (gitops?: string) =>
  ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'orders',
      annotations: gitops ? { 'calm.finos.org/gitops': gitops } : {},
    },
  } as any);

const sha = '60177ebbea44d47ed9d54851a9287c18fc822cfa';

describe('gitops status', () => {
  it('reads only Kustomizations this plugin made', () => {
    expect(kustomizationOf(entity('flux-system/calm-orders'))).toEqual({
      namespace: 'flux-system',
      name: 'calm-orders',
    });
    expect(kustomizationOf(entity())).toBeUndefined();
    expect(kustomizationOf(entity('kube-system/calm-orders'))).toBeUndefined();
    expect(kustomizationOf(entity('flux-system/other'))).toBeUndefined();
    expect(kustomizationOf(entity('flux-system/calm-Bad_Name'))).toBeUndefined();
  });

  it('gives the applied commit and links it in the repository', () => {
    expect(
      gitopsInfo(
        { namespace: 'flux-system', name: 'calm-orders' },
        {
          status: {
            conditions: [{ type: 'Ready', status: 'True', message: 'Applied' }],
            lastAppliedRevision: `main@sha1:${sha}`,
          },
        },
        'http://localhost:3300/calm-services/orders',
      ),
    ).toEqual({
      kustomization: 'flux-system/calm-orders',
      ready: true,
      message: 'Applied',
      commit: sha,
      repoUrl: 'http://localhost:3300/calm-services/orders',
      commitUrl: `http://localhost:3300/calm-services/orders/commit/${sha}`,
    });
  });

  it('drops a repository link that is not http(s)', () => {
    const info = gitopsInfo(
      { namespace: 'flux-system', name: 'calm-orders' },
      {},
      'javascript:alert(1)',
    );
    expect(info.repoUrl).toBeUndefined();
    expect(info.ready).toBe(false);
  });
});
