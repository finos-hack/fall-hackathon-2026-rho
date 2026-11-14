import { appTarget } from './appProxy';

describe('appTarget', () => {
  it('builds the service proxy path to the gateway, keeping the query', () => {
    expect(appTarget('orders', '/api/info?x=1', 'calm-')).toEqual({
      namespace: 'calm-orders',
      path: '/api/v1/namespaces/calm-orders/services/http:api-gateway:80/proxy/api/info?x=1',
    });
    expect(appTarget('orders', '/', 'calm-')?.path).toBe(
      '/api/v1/namespaces/calm-orders/services/http:api-gateway:80/proxy/',
    );
  });

  it('rejects .. segments, encoded slashes and backslashes', () => {
    for (const rest of ['/../../kube-system', '/a/%2e%2e/b', '/a%2Fb', '/a%5cb', '/a\\b', '/%zz']) {
      expect(appTarget('orders', rest, 'calm-')).toBeUndefined();
    }
  });

  it('rejects a name that is not a DNS label, and an empty prefix', () => {
    expect(appTarget('Orders_API', '/', 'calm-')).toBeUndefined();
    // A DNS label, but the namespace calm-<name> would be longer than 63 characters.
    expect(appTarget('a'.repeat(62), '/', 'calm-')).toBeUndefined();
    expect(appTarget('kube-system', '/', '')).toBeUndefined();
  });
});
