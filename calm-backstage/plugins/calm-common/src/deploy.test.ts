import { deployNamespace, isDnsLabel } from './deploy';

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
