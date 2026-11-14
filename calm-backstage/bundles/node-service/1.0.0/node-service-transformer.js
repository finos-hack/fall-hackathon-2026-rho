// The starter node-service: what the templates need from the architecture. The service node (node-type `service`)
// gives the name, owner and port; nothing about how it is deployed.
const STARTER_VERSION = '1.0.0';

export default class NodeServiceTransformer {
    registerTemplateHelpers() {
        return { json: value => JSON.stringify(value ?? null) };
    }

    getTransformedModel(calmJson) {
        const data = calmJson.originalJson ?? calmJson;
        const app = (data.nodes ?? []).find(n => n['node-type'] === 'service');
        const port = app?.interfaces?.find(i => 'port' in i)?.port;
        const serviceName = app?.metadata?.['service-name'] ?? app?.['unique-id'] ?? 'service';
        return {
            document: {
                title: data.title ?? serviceName,
                description: data.description ?? app?.description ?? '',
                serviceName,
                owner: app?.metadata?.owner ?? 'unknown',
                servicePort: Number.isInteger(port) && port > 0 ? port : 8080,
                architectureId: data['$id'] ?? '',
                patternId: data['$schema'] ?? '',
                starterVersion: STARTER_VERSION,
            },
        };
    }
}
