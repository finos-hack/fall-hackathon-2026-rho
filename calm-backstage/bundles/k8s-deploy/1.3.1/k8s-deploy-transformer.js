// Deployment rules: turns any architecture made from the web-service or event-streaming pattern into the model the
// templates read. The workloads that run in the cluster, the environment every starter reads (the starter contract),
// and the network policies that permit the architecture's `connects` relationships. Knows nothing about the starter
// beyond the contract: it listens on $PORT, answers /health and its image is called calm-service.

const RULES = { name: 'k8s-deploy', version: '1.3.1' };
// Hardening (since 1.1.0): resource limits, liveness probes, no service-account tokens, app.kubernetes.io labels.
// Backing services (their data is in the pod) never run twice during a rollout: 1.2.0 used type Recreate, which an
// existing Deployment refuses; 1.2.1 uses a rolling update with maxSurge 0, which applies over 1.0.0 and 1.1.0.
// 1.2.2 gives objects valid Kubernetes names when a unique-id is not one (see kubernetesNames).
// 1.3.0 adds TLS between two in-cluster workloads joined by an HTTPS relationship (see TLS below).
// 1.3.1 is 1.3.0 with the valid Kubernetes names of 1.2.2, also for the TLS objects.
const HARDENING = true;
const NISSHI_IMAGE = 'ghcr.io/nisshi-io/nisshi:0.8.2';

const GATEWAY_NODE = 'api-gateway';
// The gateway's address inside the cluster is fixed by the rules. The `host` and `port` in the architecture are its
// external address and do not resolve in the cluster.
const GATEWAY_SERVICE_PORT = 80;
const GATEWAY_CONTAINER_PORT = 8080;

// TLS (since 1.3.0). The destination of an HTTPS `connects` relationship whose source is in the cluster too gets an
// nginx sidecar that serves TLS on TLS.containerPort and proxies to the app container over localhost, behind port
// TLS.servicePort on its Service. cert-manager (installed by `yarn k8s:up`) issues its certificate from a self-signed
// CA in the namespace; the source mounts only the CA certificate. A relationship from outside the cluster (the web
// client to the gateway) stays as it was: the rules know no certificate the client would trust.
const TLS = {
    containerPort: 8443,
    servicePort: 443,
    image: 'nginxinc/nginx-unprivileged:1.27-alpine',
    // The sidecar's certificate secret (tls.crt, tls.key, ca.crt) and its nginx config.
    certDir: '/etc/nginx/tls',
    // Where a source finds the CA certificate.
    caDir: '/etc/calm-tls',
    selfSignedIssuer: 'calm-selfsigned',
    ca: 'calm-ca',
    cpu: '25m',
    memory: '32Mi',
    cpuLimit: '500m',
    memoryLimit: '64Mi',
};

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

// Kubernetes names for CALM unique-ids (since 1.2.2). A unique-id may hold upper case, `_` and other characters a
// Kubernetes name may not. An id that is already a valid name is used as it is, so nothing rendered by 1.2.1 is
// renamed. Any other id is lower-cased, each run of other characters becomes one `-` and `x-` goes in front when it
// would not start with a letter; that name gets a short hash of the id when another id has it too, when it is cut to
// `max` characters, or when it is still not `valid` (a word YAML reads as a boolean or null). The original id stays in
// an annotation.
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const hash = s => {
    let h = 0x811c9dc5; // FNV-1a, 32 bits
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h.toString(36);
};
// Returns id => name for `ids`. `valid` says whether an id (or a converted one) can be used as it is.
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
        if (c.length <= max && valid(c) && !taken.has(c) && count.get(c) === 1) {
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
// Words kustomize's YAML reads as a boolean or null: a name or label value that is one of them must not be written
// bare. (It quotes the YAML 1.1 words such as `on` and `yes` itself.)
const YAML_WORD = /^(true|True|TRUE|false|False|FALSE|null|Null|NULL)$/;
// A node's name is its Deployment, Service, container and DNS name and a label value: an RFC 1035 label (a Service
// name must start with a letter) of at most 63 characters.
const NODE_NAME_MAX = 63;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const isNodeName = id => id.length <= NODE_NAME_MAX && DNS_1035_LABEL.test(id) && !YAML_WORD.test(id);
// A label value: at most 63 characters, alphanumeric at both ends, `-`, `_` and `.` between. Not empty: an empty value
// renders as null.
const isLabelValue = v => v.length <= 63 && /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(v) && !YAML_WORD.test(v);
// A label value that starts with a digit may read as a number or a date (`2024`, `1.0`, `1e3`, `0x1F`, `2024-01-01`),
// so it is written quoted. Any other label value is written bare, as before 1.2.2: a valid one that starts with a letter
// is a string, and kustomize quotes the YAML 1.1 words (`on`, `yes`) itself.
const labelYaml = v => (/^[0-9]/.test(String(v)) ? JSON.stringify(String(v)) : String(v));

const twice = q => q.replace(/^(\d+)(.*)$/, (_, n, unit) => `${Number(n) * 2}${unit}`);

export default class K8sDeployTransformer {
    registerTemplateHelpers() {
        return {
            // JSON for a value. A JSON string is also a valid YAML string. Use with a triple-stash: {{{json value}}}.
            json: value => JSON.stringify(value, null, 2),
            // A label value as YAML: quoted when it would not read as a string. Use with a triple-stash.
            label: labelYaml,
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
        // An empty or blank service name counts as none, and a number is its string.
        const named = app?.metadata?.['service-name'];
        const serviceName = (typeof named === 'string' || typeof named === 'number') && String(named).trim()
            ? String(named) : appNode;
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
        // `id` stays the node's unique-id; `k8sName` is what the objects, labels, selectors and DNS use.
        const nodeName = kubernetesNames(workloads.map(w => w.id), { max: NODE_NAME_MAX, valid: isNodeName });
        for (const w of workloads) {
            w.memoryLimit = w.memoryLimit ?? twice(w.memory);
            w.cpuLimit = w.cpuLimit ?? '500m';
            w.k8sName = nodeName(w.id);
            w.renamed = w.k8sName !== String(w.id);
        }

        // Nisshi: the advertised address is its in-cluster name, and its storage is the node the pattern's choice gave.
        const broker = workload('nisshi-broker');
        if (broker) {
            const pg = workload('broker-postgres');
            broker.env.push(
                { name: 'CLUSTER_ID', value: serviceName },
                { name: 'ADVERTISED_LISTENER_URL', value: `tcp://${broker.k8sName}:${broker.servicePort}` },
                {
                    name: 'STORAGE_ENGINE',
                    value: pg
                        ? `postgres://postgres:change-me@${pg.k8sName}:${pg.servicePort}`
                        : sqlite ? 'sqlite:///data/nisshi.db' : 'memory://nisshi/',
                },
                { name: 'TMP', value: '/tmp' },
            );
            if (!pg && sqlite) {
                broker.volumes.push({ name: 'data', mountPath: '/data' });
            }
            broker.volumes.push({ name: 'tmp', mountPath: '/tmp' });
        }

        // Every `connects` relationship, and how the rules render it. HTTPS between two workloads goes to the
        // destination's TLS sidecar, so its policies name the sidecar's port.
        const connects = relationships
            .filter(r => r['relationship-type']?.connects)
            .map(r => {
                const c = r['relationship-type'].connects;
                const source = c.source?.node;
                const destination = c.destination?.node;
                const protocol = r.protocol ?? 'TCP';
                const from = workload(source);
                const to = workload(destination);
                const tls = Boolean(from && to && protocol === 'HTTPS');
                if (tls) {
                    to.tls = { containerPort: TLS.containerPort, servicePort: TLS.servicePort,
                        secretName: `${to.k8sName}-tls`, configMap: `${to.k8sName}-tls-proxy` };
                    from.tlsCa = true;
                }
                const rendered = !to
                    ? 'not rendered (the destination is outside the cluster)'
                    : from
                        ? `egress from the source and ingress to the destination${tls ? ' (TLS)' : ''}`
                        : 'ingress to the destination from anywhere (the source is outside the cluster)';
                return { id: r['unique-id'], protocol, source, destination, sourceInCluster: Boolean(from), tls,
                    port: tls ? TLS.containerPort : to?.containerPort, rendered };
            });
        const tlsWorkloads = workloads.filter(w => w.tls);
        // The gateway's nginx proxies to the app: over TLS when that relationship is HTTPS.
        const gatewayTls = connects.some(c => c.tls && c.source === GATEWAY_NODE && c.destination === appNode);

        // What each pod mounts: the gateway's config, the emptyDir volumes, the CA for a TLS source, and the
        // certificate and nginx config of a TLS sidecar (mounted by the sidecar only).
        for (const w of workloads) {
            w.mounts = [];
            w.podVolumes = [];
            if (w.isGateway) {
                w.mounts.push({ name: 'config', mountPath: '/etc/nginx/conf.d' });
                w.podVolumes.push({ name: 'config', configMap: 'gateway-config' });
            }
            for (const v of w.volumes) {
                w.mounts.push(v);
                w.podVolumes.push({ name: v.name, emptyDir: true });
            }
            if (w.tlsCa) {
                w.mounts.push({ name: 'tls-ca', mountPath: TLS.caDir, readOnly: true });
                w.podVolumes.push({ name: 'tls-ca', secret: TLS.ca, items: ['ca.crt'] });
            }
            if (w.tls) {
                w.podVolumes.push({ name: 'tls-proxy-config', configMap: w.tls.configMap },
                    { name: 'tls', secret: w.tls.secretName });
            }
        }

        // A NetworkPolicy selects one set of pods, so a relationship between two workloads needs two policies. They
        // are named after the relationship's unique-id, made a valid Kubernetes name, and select pods by node name.
        const withPolicies = connects.filter(x => x.port !== undefined);
        const policyName = kubernetesNames(
            withPolicies.map(c => c.id),
            { max: POLICY_PREFIX_MAX, valid: id => id.length <= POLICY_PREFIX_MAX && SUBDOMAIN.test(id) },
        );
        const pod = id => workload(id).k8sName;
        const policies = [];
        for (const c of withPolicies) {
            const prefix = policyName(c.id);
            const common = { relationship: c.id, protocol: c.protocol, port: c.port };
            if (c.sourceInCluster) {
                policies.push({ ...common, name: `${prefix}-egress`, pod: pod(c.source), peer: pod(c.destination),
                    isEgress: true });
            }
            policies.push({ ...common, name: `${prefix}-ingress`, pod: pod(c.destination),
                peer: c.sourceInCluster ? pod(c.source) : undefined, isIngress: true });
        }
        // Relationships whose policies are not named after their unique-id as it is.
        const renamedPolicies = withPolicies
            .filter(c => policyName(c.id) !== String(c.id))
            .map(c => ({ relationship: c.id, prefix: policyName(c.id) }));

        // The starter contract: what the app container is told.
        const connections = connects
            .filter(c => c.source === appNode && workload(c.destination))
            .map(c => {
                const w = workload(c.destination);
                return { id: w.id, name: w.name, technology: w.technology, host: w.k8sName,
                    port: c.tls ? w.tls.servicePort : w.servicePort };
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
                // The app.kubernetes.io/part-of label: the service name, converted when it is not a label value. The
                // template writes it with the `label` helper.
                partOf: kubernetesNames([serviceName], { max: 63, valid: isLabelValue })(serviceName),
                owner,
                servicePort,
                hardening: HARDENING,
                rules: RULES,
                gatewayHost: gateway?.interfaces?.find(i => 'host' in i)?.host,
                gatewayPort: archPort(gateway),
                gatewayServicePort: GATEWAY_SERVICE_PORT,
                gatewayContainerPort: GATEWAY_CONTAINER_PORT,
                appNode,
                appName: workload(appNode)?.k8sName ?? appNode,
                gatewayNode: GATEWAY_NODE,
                gatewayTls,
                tls: TLS,
                tlsWorkloads,
                workloads,
                renamedWorkloads: workloads.filter(w => w.renamed),
                connects,
                policies,
                renamedPolicies,
                connections,
                architectureId: data['$id'],
                patternId: data['$schema'],
            },
        };
    }
}
