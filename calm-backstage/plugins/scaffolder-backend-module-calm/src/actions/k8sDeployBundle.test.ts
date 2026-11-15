/*
 * Renders the deployment rules bundles/k8s-deploy/1.3.1 with the published `calm template` against a generated
 * web-service architecture (gateway → service over HTTPS, service → PostgreSQL over JDBC, service → Redis over TCP)
 * and checks the TLS the rules add between two in-cluster workloads.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { renderBundle } from '@internal/backstage-plugin-calm-node';

const REPO = path.resolve(__dirname, '../../../..');
const BUNDLE = path.join(REPO, 'bundles/k8s-deploy/1.3.1');
const ARCHITECTURE = path.join(
  REPO,
  'plugins/calm-common/src/__fixtures__/generated-web-service-postgresql-cache.json',
);

let dir: string;
let objects: Record<string, any[]> = {};

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as any;

const FILES = [
  'workloads.yaml',
  'gateway-config.yaml',
  'network-policy.yaml',
  'tls.yaml',
  'kustomization.yaml',
];

/** Renders the bundle against an architecture into `<dir>/<outputDir>` and parses the manifests it wrote. */
async function render(
  architecturePath: string,
  outputDir: string,
): Promise<Record<string, any[]>> {
  await renderBundle({
    architecturePath,
    bundleDir: BUNDLE,
    dir,
    outputDir,
    logger,
  });
  const parsed: Record<string, any[]> = {};
  for (const name of FILES) {
    const text = await fs.readFile(
      path.join(dir, outputDir, 'deploy/k8s', name),
      'utf8',
    );
    parsed[name] = parseAllDocuments(text)
      .map(d => d.toJS())
      .filter(Boolean);
  }
  return parsed;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-deploy-'));
  objects = await render(ARCHITECTURE, 'https');
}, 30_000);

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const find = (file: string, kind: string, name: string) =>
  objects[file].find(o => o.kind === kind && o.metadata?.name === name);

describe('k8s-deploy 1.3.1', () => {
  it('lists tls.yaml in the kustomization', () => {
    expect(objects['kustomization.yaml'][0].resources).toContain('tls.yaml');
  });

  it('issues a certificate for the service from a self-signed CA', () => {
    const tls = objects['tls.yaml'];
    expect(
      tls.every(
        o => o.apiVersion === 'cert-manager.io/v1' || o.kind === 'ConfigMap',
      ),
    ).toBe(true);
    expect(find('tls.yaml', 'Issuer', 'calm-selfsigned').spec).toEqual({
      selfSigned: {},
    });
    const ca = find('tls.yaml', 'Certificate', 'calm-ca').spec;
    expect(ca).toMatchObject({
      isCA: true,
      secretName: 'calm-ca',
      issuerRef: { kind: 'Issuer', name: 'calm-selfsigned' },
    });
    expect(find('tls.yaml', 'Issuer', 'calm-ca').spec).toEqual({
      ca: { secretName: 'calm-ca' },
    });
    expect(
      find('tls.yaml', 'Certificate', 'web-service-tls').spec,
    ).toMatchObject({
      secretName: 'web-service-tls',
      dnsNames: ['web-service'],
      issuerRef: { kind: 'Issuer', name: 'calm-ca' },
    });
    // Only the HTTPS destination inside the cluster gets one.
    expect(
      tls.filter(o => o.kind === 'Certificate').map(o => o.metadata.name),
    ).toEqual(['calm-ca', 'web-service-tls']);
  });

  it('makes the gateway proxy https:// to the service and verify it', () => {
    const conf = find('gateway-config.yaml', 'ConfigMap', 'gateway-config')
      .data['default.conf'];
    expect(conf).toContain('proxy_pass https://web-service:443;');
    expect(conf).toContain('proxy_ssl_verify on;');
    expect(conf).toContain(
      'proxy_ssl_trusted_certificate /etc/calm-tls/ca.crt;',
    );
    expect(conf).toContain('proxy_ssl_name web-service;');
    expect(conf).toContain('proxy_ssl_server_name on;');
    expect(conf).not.toContain('http://');
  });

  it('mounts the CA certificate, and only that, into the gateway', () => {
    const pod = find('workloads.yaml', 'Deployment', 'api-gateway').spec
      .template.spec;
    expect(pod.volumes).toContainEqual({
      name: 'tls-ca',
      secret: {
        secretName: 'calm-ca',
        items: [{ key: 'ca.crt', path: 'ca.crt' }],
      },
    });
    expect(pod.containers[0].volumeMounts).toContainEqual({
      name: 'tls-ca',
      mountPath: '/etc/calm-tls',
      readOnly: true,
    });
  });

  it('puts a TLS sidecar on 8443 in front of the service', () => {
    const pod = find('workloads.yaml', 'Deployment', 'web-service').spec
      .template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    const [app, sidecar] = pod.containers;
    expect(app.name).toBe('web-service');
    expect(app.ports).toEqual([{ containerPort: 8080 }]);
    expect(sidecar).toMatchObject({
      name: 'tls-proxy',
      image: 'nginxinc/nginx-unprivileged:1.27-alpine',
      ports: [{ containerPort: 8443 }],
      readinessProbe: { tcpSocket: { port: 8443 } },
      livenessProbe: { tcpSocket: { port: 8443 } },
      resources: { requests: {}, limits: {} },
    });
    expect(sidecar.resources.limits).toHaveProperty('memory');
    expect(sidecar.volumeMounts).toEqual(
      expect.arrayContaining([
        { name: 'tls-proxy-config', mountPath: '/etc/nginx/conf.d' },
        { name: 'tls', mountPath: '/etc/nginx/tls', readOnly: true },
      ]),
    );
    expect(pod.volumes).toEqual(
      expect.arrayContaining([
        { name: 'tls', secret: { secretName: 'web-service-tls' } },
        {
          name: 'tls-proxy-config',
          configMap: { name: 'web-service-tls-proxy' },
        },
      ]),
    );
    const conf = find('tls.yaml', 'ConfigMap', 'web-service-tls-proxy').data[
      'default.conf'
    ];
    expect(conf).toContain('listen 8443 ssl;');
    expect(conf).toContain('ssl_certificate /etc/nginx/tls/tls.crt;');
    expect(conf).toContain('ssl_certificate_key /etc/nginx/tls/tls.key;');
    expect(conf).toContain('proxy_pass http://localhost:8080;');

    const service = find('workloads.yaml', 'Service', 'web-service').spec;
    expect(service.ports).toContainEqual({
      name: 'https',
      port: 443,
      targetPort: 8443,
    });
  });

  it('allows 8443 for the HTTPS relationship and keeps the others as they were', () => {
    const port = (name: string) =>
      find('network-policy.yaml', 'NetworkPolicy', name).spec;
    expect(port('api-gateway-web-service-ingress').ingress).toEqual([
      {
        from: [
          {
            podSelector: {
              matchLabels: { 'calm.finos.org/node': 'api-gateway' },
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8443 }],
      },
    ]);
    expect(port('api-gateway-web-service-egress').egress[0].ports).toEqual([
      { protocol: 'TCP', port: 8443 },
    ]);
    // The client is outside the cluster: the gateway's plain port, as before.
    expect(port('web-client-api-gateway-ingress').ingress[0].ports).toEqual([
      { protocol: 'TCP', port: 8080 },
    ]);
    expect(port('web-service-postgres-egress').egress[0].ports).toEqual([
      { protocol: 'TCP', port: 5432 },
    ]);
    expect(port('web-service-postgres-ingress').ingress[0].ports).toEqual([
      { protocol: 'TCP', port: 5432 },
    ]);
    expect(port('web-service-cache-egress').egress[0].ports).toEqual([
      { protocol: 'TCP', port: 6379 },
    ]);
    expect(port('web-service-cache-ingress').ingress[0].ports).toEqual([
      { protocol: 'TCP', port: 6379 },
    ]);
  });

  it('leaves the backing services without TLS', () => {
    for (const id of ['postgres-database', 'cache']) {
      const pod = find('workloads.yaml', 'Deployment', id).spec.template.spec;
      expect(pod.containers).toHaveLength(1);
      expect(find('workloads.yaml', 'Service', id).spec.ports).toHaveLength(1);
    }
  });

  it('stays on plain HTTP, with no certificates, when the gateway relationship is not HTTPS', async () => {
    const architecture = JSON.parse(await fs.readFile(ARCHITECTURE, 'utf8'));
    architecture.relationships.find(
      (r: any) => r['unique-id'] === 'api-gateway-web-service',
    ).protocol = 'HTTP';
    const file = path.join(dir, 'http.json');
    await fs.writeFile(file, JSON.stringify(architecture));
    const plain = await render(file, 'http');

    expect(plain['kustomization.yaml'][0].resources).not.toContain('tls.yaml');
    expect(plain['tls.yaml']).toEqual([]);
    const conf = plain['gateway-config.yaml'][0].data['default.conf'];
    expect(conf).toContain('proxy_pass http://web-service:8080;');
    expect(conf).not.toContain('proxy_ssl');
    const deployment = plain['workloads.yaml'].find(
      o => o.kind === 'Deployment' && o.metadata.name === 'web-service',
    );
    expect(deployment.spec.template.spec.containers).toHaveLength(1);
    const ingress = plain['network-policy.yaml'].find(
      o => o.metadata.name === 'api-gateway-web-service-ingress',
    );
    expect(ingress.spec.ingress[0].ports).toEqual([
      { protocol: 'TCP', port: 8080 },
    ]);
  });

  it('names the TLS objects, the gateway upstream and the certificate after a valid Kubernetes name when the service id is not one', async () => {
    const architecture = JSON.parse(await fs.readFile(ARCHITECTURE, 'utf8'));
    const rename = (value: any): any => {
      if (Array.isArray(value)) {
        return value.map(rename);
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            (k === 'unique-id' || k === 'node') && v === 'web-service'
              ? 'Orders_Service'
              : rename(v),
          ]),
        );
      }
      return value;
    };
    const file = path.join(dir, 'renamed.json');
    await fs.writeFile(file, JSON.stringify(rename(architecture)));
    const renamed = await render(file, 'renamed');

    const deployment = renamed['workloads.yaml'].find(
      o => o.kind === 'Deployment' && o.metadata.name === 'orders-service',
    );
    expect(deployment.metadata.annotations).toEqual({
      'calm.finos.org/unique-id': 'Orders_Service',
    });
    const pod = deployment.spec.template.spec;
    expect(pod.containers.map((c: any) => c.name)).toEqual([
      'orders-service',
      'tls-proxy',
    ]);
    expect(pod.volumes).toContainEqual({
      name: 'tls',
      secret: { secretName: 'orders-service-tls' },
    });
    expect(pod.volumes).toContainEqual({
      name: 'tls-proxy-config',
      configMap: { name: 'orders-service-tls-proxy' },
    });
    const tls = renamed['tls.yaml'];
    expect(
      tls.find(
        (o: any) =>
          o.kind === 'Certificate' && o.metadata.name === 'orders-service-tls',
      ).spec,
    ).toMatchObject({
      secretName: 'orders-service-tls',
      dnsNames: ['orders-service'],
    });
    expect(
      tls.find(
        (o: any) =>
          o.kind === 'ConfigMap' &&
          o.metadata.name === 'orders-service-tls-proxy',
      ),
    ).toBeDefined();
    const conf = renamed['gateway-config.yaml'][0].data['default.conf'];
    expect(conf).toContain('proxy_pass https://orders-service:443;');
    expect(conf).toContain('proxy_ssl_name orders-service;');
    expect(conf).not.toContain('Orders_Service');
  });
});
