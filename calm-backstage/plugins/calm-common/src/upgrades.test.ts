import { readBundleMeta } from './bundleMeta';
import {
  serviceBundles,
  upgradeTargets,
  upgradeTemplatePath,
} from './upgrades';

const meta = (
  name: string,
  version: string,
  kind: string,
  patternId = 'web-service',
) =>
  readBundleMeta({
    name,
    version,
    kind,
    patterns: [{ namespace: 'hackathon', patternId }],
  });
const pattern = { namespace: 'hackathon', patternId: 'web-service' };
const available = [
  meta('spring-boot-service', '1.0.0', 'starter'),
  meta('spring-boot-service', '1.1.0', 'starter'),
  meta('spring-boot-service', '2.0.0', 'starter', 'event-streaming'),
  meta('k8s-deploy', '1.0.0', 'deployment'),
  meta('k8s-deploy', '1.1.0', 'deployment'),
];

describe('upgradeTargets', () => {
  it('picks the newest fitting version per side', () => {
    expect(
      upgradeTargets(
        {
          starter: { name: 'spring-boot-service', version: '1.0.0' },
          deploy: { name: 'k8s-deploy', version: '1.0.0' },
        },
        available,
        pattern,
      ),
    ).toEqual({
      starter: { name: 'spring-boot-service', from: '1.0.0', to: '1.1.0' },
      deploy: { name: 'k8s-deploy', from: '1.0.0', to: '1.1.0' },
    });
  });

  it('ignores versions that do not fit the pattern', () => {
    const t = upgradeTargets(
      { starter: { name: 'spring-boot-service', version: '1.1.0' } },
      available,
      pattern,
    );
    expect(t.starter).toEqual({ name: 'spring-boot-service', from: '1.1.0' });
  });

  it('returns nothing to upgrade when up to date, and no side the service lacks', () => {
    expect(
      upgradeTargets(
        { deploy: { name: 'k8s-deploy', version: '1.1.0' } },
        available,
        pattern,
      ),
    ).toEqual({ deploy: { name: 'k8s-deploy', from: '1.1.0' } });
  });
});

describe('serviceBundles', () => {
  it('reads the starter, the deployment rules and the pattern from the annotations', () => {
    expect(
      serviceBundles({
        'calm.finos.org/bundle': 'node-service',
        'calm.finos.org/bundle-version': '1.0.0',
        'calm.finos.org/deploy-bundle': 'k8s-deploy',
        'calm.finos.org/deploy-bundle-version': '1.0.0',
        'calm.finos.org/namespace': 'hackathon',
        'calm.finos.org/pattern': 'web-service',
      }),
    ).toEqual({
      starter: { name: 'node-service', version: '1.0.0' },
      deploy: { name: 'k8s-deploy', version: '1.0.0' },
      pattern: { namespace: 'hackathon', patternId: 'web-service' },
    });
    expect(upgradeTemplatePath('component:default/orders')).toBe(
      '/create/templates/default/calm-upgrade?formData=%7B%22service%22%3A%22component%3Adefault%2Forders%22%7D',
    );
  });
});
