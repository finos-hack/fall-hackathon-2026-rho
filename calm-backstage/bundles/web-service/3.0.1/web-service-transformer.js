// Turns a web-service architecture into the model the templates read: the workloads that run in the cluster, the
// connections the service makes, and the network policies that permit the architecture's `connects` relationships.

const BUNDLE_VERSION = '3.0.1';
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

// Kubernetes names for CALM unique-ids (since 3.0.1). A unique-id may hold upper case, `_` and other characters a
// Kubernetes name may not. An id that is already a valid name is used as it is, so nothing rendered by 3.0.0 is
// renamed. Any other id is lower-cased, each run of other characters becomes one `-` and `x-` goes in front when it
// would not start with a letter; that name gets a short hash of the id when another id has it too, or when it is cut
// to `max` characters. The original id stays in an annotation.
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const hash = s => {
    let h = 0x811c9dc5; // FNV-1a, 32 bits
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h.toString(36);
};
// Returns id => name for `ids`. `valid` says whether an id can be used as it is.
const kubernetesNames = (ids, { max, valid }) => {
    const unique = [...new Set(ids.map(String))];
    const names = new Map(unique.filter(valid).map(id => [id, id]));
    const clean = id => {
        const c = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return /^[a-z]/.test(c) ? c : `x${c && `-${c}`}`;
    };
    const changed = unique.filter(id => !names.has(id));
    const count = new Map();
    for (const id of changed) count.set(clean(id), (count.get(clean(id)) ?? 0) + 1);
    const taken = new Set(names.values());
    const hashed = [];
    for (const id of changed) {
        const c = clean(id);
        if (c.length <= max && !taken.has(c) && count.get(c) === 1) {
            names.set(id, c);
            taken.add(c);
        } else {
            hashed.push(id);
        }
    }
    for (const id of hashed) {
        let name;
        for (let n = 0; !name || taken.has(name); n++) {
            const suffix = `-${hash(n ? `${id}#${n}` : id)}`;
            name = `${clean(id).slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
        }
        taken.add(name);
        names.set(id, name);
    }
    return id => names.get(String(id));
};
// A NetworkPolicy name is a DNS subdomain of at most 253 characters; `-ingress` takes 8 of them.
const POLICY_PREFIX_MAX = 253 - '-ingress'.length;

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

        // A NetworkPolicy selects one set of pods, so a relationship between two workloads needs two policies. They
        // are named after the relationship's unique-id, made a valid Kubernetes name.
        const withPolicies = connects.filter(x => x.port !== undefined);
        const policyName = kubernetesNames(
            withPolicies.map(c => c.id),
            { max: POLICY_PREFIX_MAX, valid: id => id.length <= POLICY_PREFIX_MAX && SUBDOMAIN.test(id) },
        );
        const policies = [];
        for (const c of withPolicies) {
            const prefix = policyName(c.id);
            const common = { relationship: c.id, protocol: c.protocol, port: c.port };
            if (c.sourceInCluster) {
                policies.push({ ...common, name: `${prefix}-egress`, pod: c.source, peer: c.destination, isEgress: true });
            }
            policies.push({
                ...common,
                name: `${prefix}-ingress`,
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

        // Relationships whose policies are not named after their unique-id as it is.
        const renamedPolicies = withPolicies
            .filter(c => policyName(c.id) !== String(c.id))
            .map(c => ({ relationship: c.id, prefix: policyName(c.id) }));

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
                renamedPolicies,
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
