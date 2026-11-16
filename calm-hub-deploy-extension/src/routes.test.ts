import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RouteTable } from './routes';

const table = RouteTable.fromManifest(path.join(__dirname, '../extension/platform-connector/extension.json'));

describe('RouteTable (from the manifest)', () => {
  it('matches each route with its parameters', () => {
    expect(table.match('GET', '/tab/hackathon/architectures/orders')).toMatchObject({
      kind: 'route',
      route: { id: 'tab' },
      params: { namespace: 'hackathon', resourceType: 'architectures', resourceId: 'orders' },
    });
    expect(table.match('GET', '/namespaces/hackathon/architectures/orders/status')).toMatchObject({ route: { id: 'status' } });
    expect(table.match('GET', '/history/namespaces/hackathon/architectures/orders/deployments')).toMatchObject({
      route: { id: 'history' },
    });
    expect(table.match('POST', '/deploy/hackathon/architectures/orders/1.0.1')).toMatchObject({
      route: { id: 'deploy-here' },
      params: { version: '1.0.1' },
    });
    expect(table.match('POST', '/namespaces/hackathon/architectures/orders/versions/1.0.1/deployments')).toMatchObject({
      route: { id: 'deploy' },
    });
  });

  it('answers 405 for a known path with another method, 404 otherwise', () => {
    expect(table.match('DELETE', '/tab/hackathon/architectures/orders').kind).toBe('method-not-allowed');
    expect(table.match('GET', '/tab/hackathon/architectures').kind).toBe('not-found');
    expect(table.match('GET', '/tab/hackathon/architectures/orders/').kind).toBe('not-found');
  });

  it('never decodes: an encoded slash or dot-dot is not a value', () => {
    expect(table.match('GET', '/tab/hackathon/architectures/a%2Fb').kind).toBe('not-found');
    expect(table.match('GET', '/tab/hackathon/architectures/..').kind).toBe('not-found');
    expect(table.match('GET', '/tab/hack;athon/architectures/a').kind).toBe('not-found');
  });
});
