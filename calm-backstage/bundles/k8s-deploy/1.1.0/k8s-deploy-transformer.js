// Deployment rules: turns any architecture made from the web-service or event-streaming pattern into the model the
// templates read. The workloads that run in the cluster, the environment every starter reads (the starter contract),
// and the network policies that permit the architecture's `connects` relationships. Knows nothing about the starter
// beyond the contract: it listens on $PORT, answers /health and its image is called calm-service.

const RULES = { name: 'k8s-deploy', version: '1.1.0' };
// Hardening (new in 1.1.0): resource limits, liveness probes, no service-account tokens, app.kubernetes.io labels.
const HARDENING = true;
const NISSHI_IMAGE = 'ghcr.io/nisshi-io/nisshi:0.8.2';

const GATEWAY_NODE = 'api-gateway';
// The gateway's address inside the cluster is fixed by the rules. The `host` and `port` in the architecture are its
// external address and do not resolve in the cluster.
const GATEWAY_SERVICE_PORT = 80;
const GATEWAY_CONTAINER_PORT = 8080;

// The app container gets one size, big enough for a JVM starter.
const APP = { cpu: '250m', memory: '384Mi', cpuLimit: '1', memoryLimit: '768Mi' };

// Backing services by node unique-id. `containerPort` is the port the image listens on.
const POSTGRES = {
    kind: 'postgres',
    technology: 'PostgreSQL',
    image: 'postgres:16-alpine',
    containerPort: 5432,
    env: [{ name: 'POSTGRES_PASSWORD', value: 'change-me' }],
    memory: '128Mi',
};
const BACKING = {
    'postgres-database': POSTGRES,
    'broker-postgres': POSTGRES,
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
    'nisshi-broker': {
        kind: 'nisshi',
        technology: 'Nisshi (Kafka-compatible broker)',
        image: NISSHI_IMAGE,
        containerPort: 9092,
        memory: '64Mi',
    },
};

const twice = q => q.replace(/^(\d+)(.*)$/, (_, n, unit) => `${Number(n) * 2}${unit}`);

export default class K8sDeployTransformer {
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

        // The service the developer builds: the node of type `service`.
        const app = nodes.find(n => n['node-type'] === 'service');
        const appNode = app?.['unique-id'] ?? 'web-service';
        const gateway = byId(GATEWAY_NODE);
        const serviceName = app?.metadata?.['service-name'] ?? appNode;
        const owner = app?.metadata?.owner ?? 'unknown';
        const topic = app?.metadata?.topic;
        const servicePort = archPort(app) ?? 8080;
        const sqlite = Boolean(byId('broker-sqlite'));

        const workloads = [];
        for (const node of nodes) {
            const id = node['unique-id'];
            const base = { id, name: node.name ?? id, env: [], cpu: '25m', volumes: [] };
            if (id === appNode) {
                workloads.push({ ...base, kind: 'app', technology: 'The starter’s image, built from `Dockerfile`',
                    image: 'calm-service:dev', servicePort, containerPort: servicePort,
                    cpu: APP.cpu, memory: APP.memory, cpuLimit: APP.cpuLimit, memoryLimit: APP.memoryLimit,
                    httpProbePath: '/health', probeDelay: 5, isApp: true });
            } else if (id === GATEWAY_NODE) {
                workloads.push({ ...base, kind: 'gateway', technology: 'nginx',
                    image: 'nginxinc/nginx-unprivileged:1.27-alpine', servicePort: GATEWAY_SERVICE_PORT,
                    containerPort: GATEWAY_CONTAINER_PORT, memory: '32Mi', httpProbePath: '/healthz', isGateway: true });
            } else if (BACKING[id]) {
                const backing = BACKING[id];
                workloads.push({ ...base, ...backing, env: [...(backing.env ?? [])],
                    servicePort: archPort(node) ?? backing.containerPort, stateful: true });
            }
        }
        const workload = id => workloads.find(w => w.id === id);
        for (const w of workloads) {
            w.memoryLimit = w.memoryLimit ?? twice(w.memory);
            w.cpuLimit = w.cpuLimit ?? '500m';
        }

        // Nisshi: the advertised address is its in-cluster name, and its storage is the node the pattern's choice gave.
        const broker = workload('nisshi-broker');
        if (broker) {
            const pg = workload('broker-postgres');
            broker.env.push(
                { name: 'CLUSTER_ID', value: serviceName },
                { name: 'ADVERTISED_LISTENER_URL', value: `tcp://${broker.id}:${broker.servicePort}` },
                {
                    name: 'STORAGE_ENGINE',
                    value: pg
                        ? `postgres://postgres:change-me@${pg.id}:${pg.servicePort}`
                        : sqlite ? 'sqlite:///data/nisshi.db' : 'memory://nisshi/',
                },
                { name: 'TMP', value: '/tmp' },
            );
            if (!pg && sqlite) {
                broker.volumes.push({ name: 'data', mountPath: '/data' });
            }
            broker.volumes.push({ name: 'tmp', mountPath: '/tmp' });
        }

        // Every `connects` relationship, and how the rules render it.
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
                return { id: r['unique-id'], protocol: r.protocol ?? 'TCP', source, destination,
                    sourceInCluster: Boolean(workload(source)), port: to?.containerPort, rendered };
            });

        // A NetworkPolicy selects one set of pods, so a relationship between two workloads needs two policies.
        const policies = [];
        for (const c of connects.filter(x => x.port !== undefined)) {
            const common = { relationship: c.id, protocol: c.protocol, port: c.port };
            if (c.sourceInCluster) {
                policies.push({ ...common, name: `${c.id}-egress`, pod: c.source, peer: c.destination, isEgress: true });
            }
            policies.push({ ...common, name: `${c.id}-ingress`, pod: c.destination,
                peer: c.sourceInCluster ? c.source : undefined, isIngress: true });
        }

        // The starter contract: what the app container is told.
        const connections = connects
            .filter(c => c.source === appNode && workload(c.destination))
            .map(c => {
                const w = workload(c.destination);
                return { id: w.id, name: w.name, technology: w.technology, host: w.id, port: w.servicePort };
            });
        const appWorkload = workload(appNode);
        if (appWorkload) {
            const db = connections.find(c => ['postgres-database', 'mongodb-database'].includes(c.id));
            const kafka = connections.find(c => c.id === 'nisshi-broker');
            appWorkload.env.push(
                { name: 'PORT', value: String(servicePort) },
                { name: 'SERVICE_NAME', value: serviceName },
                { name: 'SERVICE_OWNER', value: owner },
                { name: 'CALM_ARCHITECTURE', value: data['$id'] ?? '' },
                { name: 'CALM_PATTERN', value: data['$schema'] ?? '' },
                { name: 'CALM_DEPLOY_RULES', value: `${RULES.name}@${RULES.version}` },
                { name: 'CALM_CONNECTIONS', value: JSON.stringify(connections) },
                ...(db ? [{ name: 'DATABASE_HOST', value: db.host }, { name: 'DATABASE_PORT', value: String(db.port) }] : []),
                ...(kafka ? [{ name: 'KAFKA_BOOTSTRAP_SERVERS', value: `${kafka.host}:${kafka.port}` }] : []),
                ...(kafka && topic ? [{ name: 'KAFKA_TOPIC', value: topic }] : []),
                // Sizes the JVM of a Java starter to the container; ignored by other runtimes.
                { name: 'JAVA_TOOL_OPTIONS', value: HARDENING ? '-XX:MaxRAMPercentage=70' : '-Xmx320m' },
            );
        }

        return {
            document: {
                title: data.title ?? serviceName,
                serviceName,
                owner,
                servicePort,
                hardening: HARDENING,
                rules: RULES,
                gatewayHost: gateway?.interfaces?.find(i => 'host' in i)?.host,
                gatewayPort: archPort(gateway),
                gatewayServicePort: GATEWAY_SERVICE_PORT,
                gatewayContainerPort: GATEWAY_CONTAINER_PORT,
                appNode,
                gatewayNode: GATEWAY_NODE,
                workloads,
                connects,
                policies,
                connections,
                architectureId: data['$id'],
                patternId: data['$schema'],
            },
        };
    }
}
