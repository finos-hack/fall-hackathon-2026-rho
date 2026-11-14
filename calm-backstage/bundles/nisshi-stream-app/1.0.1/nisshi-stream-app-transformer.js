// The starter nisshi-stream-app: what the templates need from an event-streaming architecture. The service node
// (node-type `service`) gives the name, owner, port and topic; the deployment rules give the broker's address.
const STARTER_VERSION = '1.0.1';

export default class NisshiStreamAppTransformer {
    registerTemplateHelpers() {
        return { json: value => JSON.stringify(value ?? null) };
    }

    getTransformedModel(calmJson) {
        const data = calmJson.originalJson ?? calmJson;
        const app = (data.nodes ?? []).find(n => n['node-type'] === 'service');
        const port = app?.interfaces?.find(i => 'port' in i)?.port;
        const serviceName = app?.metadata?.['service-name'] ?? app?.['unique-id'] ?? 'stream-app';
        const storage = (data.nodes ?? []).some(n => n['unique-id'] === 'broker-postgres') ? 'PostgreSQL' : 'SQLite';
        return {
            document: {
                title: data.title ?? serviceName,
                description: data.description ?? app?.description ?? '',
                serviceName,
                owner: app?.metadata?.owner ?? 'unknown',
                topic: app?.metadata?.topic ?? 'events',
                storage,
                servicePort: Number.isInteger(port) && port > 0 ? port : 8080,
                architectureId: data['$id'] ?? '',
                patternId: data['$schema'] ?? '',
                starterVersion: STARTER_VERSION,
            },
        };
    }
}
