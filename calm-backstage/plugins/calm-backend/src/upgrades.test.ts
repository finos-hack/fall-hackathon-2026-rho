import { readBundleMeta } from '@internal/backstage-plugin-calm-common';
import { upgradesFor } from './upgrades';

const available = [
  readBundleMeta({
    name: 'node-service',
    version: '1.0.0',
    kind: 'starter',
    patterns: [{ patternId: 'web-service' }],
  }),
  readBundleMeta({
    name: 'k8s-deploy',
    version: '1.0.0',
    kind: 'deployment',
    patterns: [{ patternId: 'web-service' }],
  }),
  readBundleMeta({
    name: 'k8s-deploy',
    version: '1.1.0',
    kind: 'deployment',
    patterns: [{ patternId: 'web-service' }],
  }),
];
const entity = (annotations: Record<string, string>) =>
  ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'orders', annotations },
  } as any);
const base = {
  'calm.finos.org/namespace': 'hackathon',
  'calm.finos.org/pattern': 'web-service',
  'calm.finos.org/bundle': 'node-service',
  'calm.finos.org/bundle-version': '1.0.0',
};

describe('upgradesFor', () => {
  it('reports from and to for each side and links the upgrade Template', () => {
    expect(
      upgradesFor(
        entity({
          ...base,
          'calm.finos.org/deploy-bundle': 'k8s-deploy',
          'calm.finos.org/deploy-bundle-version': '1.0.0',
          'calm.finos.org/gitops': 'flux-system/calm-orders',
        }),
        available,
      ),
    ).toEqual({
      inGit: true,
      kind: 'starter',
      starter: { name: 'node-service', from: '1.0.0' },
      deploy: { name: 'k8s-deploy', from: '1.0.0', to: '1.1.0' },
      upgradePath:
        '/create/templates/default/calm-upgrade?formData=%7B%22service%22%3A%22component%3Adefault%2Forders%22%7D',
    });
  });

  it('says a full-bundle service has no upgrade path', () => {
    const r = upgradesFor(
      entity({
        ...base,
        'calm.finos.org/bundle': 'web-service',
        'calm.finos.org/bundle-version': '3.0.0',
      }),
      available,
    );
    expect(r.kind).toBe('full');
    expect(r.upgradePath).toBeUndefined();
    expect(r.note).toMatch(/create the service again with a starter/);
  });

  it('offers no upgrade for a service that is not in Git', () => {
    const r = upgradesFor(
      entity({
        ...base,
        'calm.finos.org/deploy-bundle': 'k8s-deploy',
        'calm.finos.org/deploy-bundle-version': '1.0.0',
      }),
      available,
    );
    expect(r.inGit).toBe(false);
    expect(r.upgradePath).toBeUndefined();
  });
});
