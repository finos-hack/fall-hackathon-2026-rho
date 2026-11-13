import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  fillPlaceholders,
  parseJsonPointer,
  scanPlaceholders,
  toJsonPointer,
} from './placeholders';

// `__fixtures__/generated-web-service-postgresql-cache.json` is the unmodified output of the published CLI
// (`@finos/calm-cli` 1.71.0) against the seeded CALM Hub (`hub/seed.sh`, Hub on http://localhost:8090):
//   echo '{"datastore-choice":"PostgreSQL","add-ons":["Cache (Redis)"]}' > choices.json
//   calm generate -p http://localhost:8090/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0 \
//     -c http://localhost:8090 -o generated-web-service-postgresql-cache.json --option-choices choices.json
const generated = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '__fixtures__/generated-web-service-postgresql-cache.json',
    ),
    'utf-8',
  ),
);

describe('scanPlaceholders', () => {
  it('finds the seed pattern placeholders in a generated architecture', () => {
    expect(scanPlaceholders(generated)).toEqual([
      {
        path: '/nodes/1/interfaces/0/host',
        kind: 'string',
        name: 'HOST',
        label: 'api-gateway › api-gateway-ingress › host',
      },
      {
        path: '/nodes/1/interfaces/0/port',
        kind: 'number',
        name: 'api-gateway-ingress.port',
        label: 'api-gateway › api-gateway-ingress › port',
      },
      {
        path: '/nodes/2/metadata/owner',
        kind: 'string',
        name: 'OWNER',
        label: 'web-service › metadata › owner',
      },
      {
        path: '/nodes/2/metadata/service-name',
        kind: 'string',
        name: 'SERVICE_NAME',
        label: 'web-service › metadata › service-name',
      },
      {
        path: '/nodes/2/interfaces/0/port',
        kind: 'number',
        name: 'web-service-api.port',
        label: 'web-service › web-service-api › port',
      },
    ]);
  });

  it('reads the other CLI placeholder forms and escapes pointers', () => {
    const doc = {
      nodes: [
        {
          'unique-id': 'n',
          tags: ['[[ TAGS ]]'],
          enabled: '[[ BOOLEAN_ENABLED ]]',
          'a/b~c': '[[ REF_THING ]]',
          port: 8080,
          name: 'not [[ A ]] placeholder',
        },
      ],
    };
    expect(scanPlaceholders(doc)).toEqual([
      {
        path: '/nodes/0/tags/0',
        kind: 'string',
        name: 'TAGS',
        label: 'n › tags[0]',
      },
      {
        path: '/nodes/0/enabled',
        kind: 'string',
        name: 'BOOLEAN_ENABLED',
        label: 'n › enabled',
      },
      {
        path: '/nodes/0/a~1b~0c',
        kind: 'string',
        name: 'REF_THING',
        label: 'n › a/b~c',
      },
    ]);
  });

  it('returns nothing for a filled document or a non-object', () => {
    expect(scanPlaceholders({ nodes: [{ port: 1, host: 'x' }] })).toEqual([]);
    expect(scanPlaceholders(undefined)).toEqual([]);
  });
});

describe('fillPlaceholders', () => {
  const values = {
    '/nodes/1/interfaces/0/host': 'gateway.example.com',
    '/nodes/1/interfaces/0/port': 443,
    '/nodes/2/metadata/owner': 'team-a',
    '/nodes/2/metadata/service-name': 'orders',
    '/nodes/2/interfaces/0/port': '8080',
  };

  it('sets every path, converts a numeric string, and leaves the input alone', () => {
    const filled = fillPlaceholders(generated, values);
    expect(scanPlaceholders(filled)).toEqual([]);
    expect(filled.nodes[1].interfaces[0]).toEqual({
      'unique-id': 'api-gateway-ingress',
      host: 'gateway.example.com',
      port: 443,
    });
    expect(filled.nodes[2].interfaces[0].port).toBe(8080);
    expect(filled.nodes[2].metadata).toEqual({
      owner: 'team-a',
      'service-name': 'orders',
    });
    expect(scanPlaceholders(generated)).toHaveLength(5);
  });

  it('throws on a missing path or a non-number for a number', () => {
    expect(() => fillPlaceholders(generated, { '/nodes/9/port': 1 })).toThrow(
      'No value at /nodes/9/port',
    );
    expect(() =>
      fillPlaceholders(generated, { '/nodes/2/interfaces/0/port': 'abc' }),
    ).toThrow('/nodes/2/interfaces/0/port needs a number, got "abc"');
  });
});

describe('JSON Pointer', () => {
  it('round-trips escaped segments', () => {
    const p = toJsonPointer(['a/b', 'c~d', 0]);
    expect(p).toBe('/a~1b/c~0d/0');
    expect(parseJsonPointer(p)).toEqual(['a/b', 'c~d', '0']);
  });
});
