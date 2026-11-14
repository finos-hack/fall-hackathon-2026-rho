import { deploymentFromObjects, readDeployment } from './deployment';

const settings = {
  kubeconfig: '/no/such/folder/.kube/config',
  context: 'calm-backstage',
  minikubeProfile: 'calm-backstage',
  namespacePrefix: 'calm-',
};
const entity = (annotations: Record<string, string>) =>
  ({ metadata: { name: 'stock-api', annotations } } as any);
const logger = () => ({ info: jest.fn(), warn: jest.fn() } as any);

describe('deploymentFromObjects', () => {
  it('gives the network policies with their relationship and the workloads with their readiness', () => {
    expect(
      deploymentFromObjects('calm-backstage', 'calm-stock-api', [
        {
          kind: 'NetworkPolicy',
          metadata: {
            name: 'web-service-postgres-egress',
            annotations: {
              'calm.finos.org/relationship': 'web-service-postgres',
              'calm.finos.org/protocol': 'JDBC',
            },
          },
        },
        { kind: 'NetworkPolicy', metadata: { name: 'default-deny' } },
        {
          kind: 'Deployment',
          metadata: { name: 'web-service' },
          spec: { replicas: 1 },
          status: { readyReplicas: 1 },
        },
        {
          kind: 'Deployment',
          metadata: { name: 'cache' },
          spec: { replicas: 1 },
          status: {},
        },
      ]),
    ).toEqual({
      cluster: 'calm-backstage',
      namespace: 'calm-stock-api',
      networkPolicies: [
        { name: 'default-deny' },
        {
          name: 'web-service-postgres-egress',
          relationship: 'web-service-postgres',
          protocol: 'JDBC',
        },
      ],
      workloads: [
        { name: 'cache', ready: false },
        { name: 'web-service', ready: true },
      ],
    });
  });
});

describe('readDeployment', () => {
  const annotations = {
    'backstage.io/kubernetes-id': 'stock-api',
    'backstage.io/kubernetes-namespace': 'calm-stock-api',
  };

  it('gives nothing without the annotations or the deploy config', async () => {
    expect(
      await readDeployment(entity({}), settings, logger()),
    ).toBeUndefined();
    expect(
      await readDeployment(entity(annotations), undefined, logger()),
    ).toBeUndefined();
  });

  it('does not read a namespace outside the prefix', async () => {
    const log = logger();
    expect(
      await readDeployment(
        entity({
          ...annotations,
          'backstage.io/kubernetes-namespace': 'kube-system',
        }),
        settings,
        log,
      ),
    ).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('kube-system is not under calm-'),
    );
  });

  it('gives nothing, with a warning, when the kubeconfig is missing', async () => {
    const log = logger();
    expect(
      await readDeployment(entity(annotations), settings, log),
    ).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('yarn k8s:up'),
    );
  });
});
