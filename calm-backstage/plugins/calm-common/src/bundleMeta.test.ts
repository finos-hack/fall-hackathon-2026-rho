import { fitsPattern, newestFitting, readBundleMeta } from './bundleMeta';

describe('readBundleMeta', () => {
  it('treats a bundle without kind as full and reads the old single pattern', () => {
    expect(
      readBundleMeta({
        name: 'web-service',
        version: '3.0.0',
        deploy: 'kubernetes',
        pattern: {
          namespace: 'hackathon',
          patternId: 'web-service',
          version: '1.0.0',
        },
      }),
    ).toEqual({
      name: 'web-service',
      version: '3.0.0',
      kind: 'full',
      deploy: 'kubernetes',
      patterns: [
        { namespace: 'hackathon', patternId: 'web-service', version: '1.0.0' },
      ],
    });
  });

  it('reads kind, runtime and a list of patterns; a deployment bundle deploys to Kubernetes', () => {
    const meta = readBundleMeta({
      name: 'k8s-deploy',
      version: '1.0.0',
      kind: 'deployment',
      patterns: [
        { namespace: 'hackathon', patternId: 'web-service' },
        { namespace: 'hackathon', patternId: 'event-streaming' },
        { nonsense: true },
      ],
    });
    expect(meta.kind).toBe('deployment');
    expect(meta.deploy).toBe('kubernetes');
    expect(meta.patterns.map(p => p.patternId)).toEqual([
      'web-service',
      'event-streaming',
    ]);
    expect(
      readBundleMeta({
        kind: 'starter',
        runtime: 'Spring Boot 4.0.9 on Java 21',
      }),
    ).toMatchObject({
      kind: 'starter',
      runtime: 'Spring Boot 4.0.9 on Java 21',
    });
    expect(readBundleMeta({ kind: 'bogus' }).kind).toBe('full');
  });

  it('fits a pattern by id, and by namespace when both give one', () => {
    const meta = readBundleMeta({
      patterns: [{ namespace: 'hackathon', patternId: 'web-service' }],
    });
    expect(fitsPattern(meta, 'hackathon', 'web-service')).toBe(true);
    expect(fitsPattern(meta, 'other', 'web-service')).toBe(false);
    expect(fitsPattern(meta, 'hackathon', 'event-streaming')).toBe(false);
  });

  it('newestFitting picks the newest version of the name that fits', () => {
    const b = (version: string, patternId = 'web-service') =>
      readBundleMeta({
        name: 'spring-boot-service',
        version,
        kind: 'starter',
        patterns: [{ patternId }],
      });
    const all = [
      b('1.0.0'),
      b('1.10.0'),
      b('1.2.0'),
      b('2.0.0', 'event-streaming'),
    ];
    expect(
      newestFitting(all, 'spring-boot-service', 'hackathon', 'web-service')
        ?.version,
    ).toBe('1.10.0');
    expect(
      newestFitting(all, 'quarkus-service', 'hackathon', 'web-service'),
    ).toBeUndefined();
  });
});
