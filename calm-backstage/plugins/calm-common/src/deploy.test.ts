import { deployNamespace, isDnsLabel, workloadNode } from './deploy';

describe('deployNamespace', () => {
  it('puts the prefix before the service name', () => {
    expect(deployNamespace('calm-', 'stock-api')).toBe('calm-stock-api');
  });

  it('rejects a name that is not a DNS label', () => {
    for (const name of [
      'Stock',
      'stock_api',
      'stock.api',
      '-stock',
      'a/b',
      '',
    ]) {
      expect(() => deployNamespace('calm-', name)).toThrow(
        /cannot name Kubernetes objects/,
      );
    }
  });

  it('rejects a namespace longer than 63 characters', () => {
    expect(() => deployNamespace('calm-', 'a'.repeat(59))).toThrow(
      /not a valid Kubernetes namespace name/,
    );
    expect(isDnsLabel(`calm-${'a'.repeat(58)}`)).toBe(true);
  });

  it('refuses default and kube-* whatever the prefix', () => {
    expect(() => deployNamespace('', 'default')).toThrow(/Refusing to deploy/);
    expect(() => deployNamespace('', 'kube-system')).toThrow(
      /Refusing to deploy/,
    );
    expect(() => deployNamespace('kube-', 'public')).toThrow(
      /Refusing to deploy/,
    );
  });
});

describe('workloadNode', () => {
  it('reads the unique-id annotation, then the node label, on the object or its pod template', () => {
    const annotations = { 'calm.finos.org/unique-id': 'Web_Service' };
    const labels = { 'calm.finos.org/node': 'web-service-ab12cd' };
    expect(workloadNode({ metadata: { annotations, labels } })).toBe(
      'Web_Service',
    );
    expect(
      workloadNode({
        metadata: { labels },
        spec: { template: { metadata: { annotations } } },
      }),
    ).toBe('Web_Service');
    expect(workloadNode({ metadata: { labels } })).toBe('web-service-ab12cd');
    expect(workloadNode({ spec: { template: { metadata: { labels } } } })).toBe(
      'web-service-ab12cd',
    );
    expect(workloadNode({ metadata: { name: 'x' } })).toBeUndefined();
    expect(workloadNode(undefined)).toBeUndefined();
  });
});
