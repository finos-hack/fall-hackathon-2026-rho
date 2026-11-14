// Turns a web-service architecture into the model the templates read: the workloads that run in the cluster, the
// connections the service makes, and the network policies that permit the architecture's `connects` relationships.

const BUNDLE_VERSION = '3.0.0';
const APP_NODE = 'web-service';
const GATEWAY_NODE = 'api-gateway';
// The gateway's address inside the cluster is fixed by the bundle. The `host` and `port` in the architecture are
// its external address and do not resolve in the cluster.
const GATEWAY_SERVICE_PORT = 80;
const GATEWAY_CONTAINER_PORT = 8080;

// Backing services by node unique-id. `containerPort` is the port the image listens on.
const BACKING = {
    'postgres-database': {
        kind: 'postgres',
        technology: 'PostgreSQL',
        image: 'postgres:16-alpine',
        containerPort: 5432,
        env: [{ name: 'POSTGRES_PASSWORD', value: 'change-me' }],
        memory: '128Mi',
    },
    'mongodb-database': { kind: 'mongodb', technology: 'MongoDB', image: 'mongo:7', containerPort: 27017, memory: '256Mi' },
    cache: { kind: 'redis', technology: 'Redis', image: 'redis:7-alpine', containerPort: 6379, memory: '32Mi' },
    'message-queue': {
        kind: 'rabbitmq',
        technology: 'RabbitMQ',
        image: 'rabbitmq:3-alpine',
        containerPort: 5672,
        memory: '256Mi',
    },
    observability: {
        kind: 'otel-collector',
        technology: 'OpenTelemetry collector',
        image: 'otel/opentelemetry-collector:0.110.0',
        containerPort: 4317,
        memory: '64Mi',
    },
};

export default class WebServiceTransformer {
    registerTemplateHelpers() {
        return {
            // JSON for a value. A JSON string is also a valid YAML string. Use with a triple-stash: {{{json value}}}.
            json: value => JSON.stringify(value, null, 2),
        };
    }

    getTransformedModel(calmJson) {
        const data = calmJson.originalJson ?? calmJson;
        const nodes = data.nodes ?? [];
        const relationships = data.relationships ?? [];
        const byId = id => nodes.find(n => n['unique-id'] === id);
        const archPort = node => {
            const port = node?.interfaces?.find(i => 'port' in i)?.port;
            return Number.isInteger(port) && port > 0 ? port : undefined;
        };

        const service = byId(APP_NODE);
        const gateway = byId(GATEWAY_NODE);
        const serviceName = service?.metadata?.['service-name'] ?? APP_NODE;
        const owner = service?.metadata?.owner ?? 'unknown';
        const servicePort = archPort(service) ?? 8080;

        // One workload per in-cluster node. `id` is the Deployment, Service and DNS name. `servicePort` is the port
        // other pods call; `containerPort` is the port the pod listens on (network policies match this one).
        const workloads = [];
        for (const node of nodes) {
            const id = node['unique-id'];
            const base = { id, name: node.name ?? id, env: [], cpu: '25m' };
            if (id === APP_NODE) {
                workloads.push({
                    ...base,
                    kind: 'app',
                    technology: 'Node service built from `Dockerfile`',
                    image: 'calm-service:dev',
                    servicePort,
                    containerPort: servicePort,
                    memory: '64Mi',
                    httpProbePath: '/health',
                });
            } else if (id === GATEWAY_NODE) {
                workloads.push({
                    ...base,
                    kind: 'gateway',
                    technology: 'nginx',
                    image: 'nginxinc/nginx-unprivileged:1.27-alpine',
                    servicePort: GATEWAY_SERVICE_PORT,
                    containerPort: GATEWAY_CONTAINER_PORT,
                    memory: '32Mi',
                    httpProbePath: '/healthz',
                    isGateway: true,
                });
            } else if (BACKING[id]) {
                const backing = BACKING[id];
                workloads.push({
                    ...base,
                    ...backing,
                    env: backing.env ?? [],
                    servicePort: archPort(node) ?? backing.containerPort,
                });
            }
        }
        const workload = id => workloads.find(w => w.id === id);

        // Every `connects` relationship, and how the bundle renders it.
        const connects = relationships
            .filter(r => r['relationship-type']?.connects)
            .map(r => {
                const c = r['relationship-type'].connects;
                const source = c.source?.node;
                const destination = c.destination?.node;
                const to = workload(destination);
                const rendered = !to
                    ? 'not rendered (the destination is outside the cluster)'
                    : workload(source)
                        ? 'egress from the source and ingress to the destination'
                        : 'ingress to the destination from anywhere (the source is outside the cluster)';
                return {
                    id: r['unique-id'],
                    protocol: r.protocol ?? 'TCP',
                    source,
                    destination,
                    sourceInCluster: Boolean(workload(source)),
                    port: to?.containerPort,
                    rendered,
                };
            });

        // A NetworkPolicy selects one set of pods, so a relationship between two workloads needs two policies.
        const policies = [];
        for (const c of connects.filter(x => x.port !== undefined)) {
            const common = { relationship: c.id, protocol: c.protocol, port: c.port };
            if (c.sourceInCluster) {
                policies.push({ ...common, name: `${c.id}-egress`, pod: c.source, peer: c.destination, isEgress: true });
            }
            policies.push({
                ...common,
                name: `${c.id}-ingress`,
                pod: c.destination,
                peer: c.sourceInCluster ? c.source : undefined,
                isIngress: true,
            });
        }

        // What `GET /connections` in the service tries: the service's own outgoing connections.
        const connections = connects
            .filter(c => c.source === APP_NODE && workload(c.destination))
            .map(c => ({
                node: c.destination,
                host: c.destination,
                port: workload(c.destination).servicePort,
                protocol: c.protocol,
            }));

        const title = data.title ?? serviceName;
        return {
            document: {
                title,
                description: data.description ?? service?.description,
                serviceName,
                owner,
                servicePort,
                gatewayHost: gateway?.interfaces?.find(i => 'host' in i)?.host,
                gatewayPort: archPort(gateway),
                gatewayServicePort: GATEWAY_SERVICE_PORT,
                gatewayContainerPort: GATEWAY_CONTAINER_PORT,
                appNode: APP_NODE,
                gatewayNode: GATEWAY_NODE,
                workloads,
                connects,
                policies,
                connections,
                info: {
                    service: serviceName,
                    owner,
                    pattern: data['$schema'] ?? null,
                    nodes: nodes.length,
                    relationships: relationships.length,
                    bundle: `web-service ${BUNDLE_VERSION}`,
                },
                architectureId: data['$id'],
                patternId: data['$schema'],
                bundleVersion: BUNDLE_VERSION,
            },
        };
    }
}
