// Turns a web-service architecture into the small model the templates read.
export default class WebServiceTransformer {
    registerTemplateHelpers() {
        return {};
    }

    getTransformedModel(calmJson) {
        const data = calmJson.originalJson ?? calmJson;
        const nodes = data.nodes ?? [];
        const byId = id => nodes.find(n => n['unique-id'] === id);
        const port = node => node?.interfaces?.find(i => 'port' in i)?.port;

        const service = byId('web-service');
        const gateway = byId('api-gateway');
        const postgres = byId('postgres-database');
        const mongodb = byId('mongodb-database');
        const datastore = postgres
            ? { kind: 'postgres', name: 'PostgreSQL', image: 'postgres:16', port: port(postgres), isPostgres: true }
            : mongodb
                ? { kind: 'mongodb', name: 'MongoDB', image: 'mongo:7', port: port(mongodb), isMongodb: true }
                : undefined;

        return {
            document: {
                title: data.title ?? service?.name,
                description: data.description ?? service?.description,
                serviceName: service?.metadata?.['service-name'] ?? 'web-service',
                owner: service?.metadata?.owner ?? 'unknown',
                servicePort: port(service),
                gatewayHost: gateway?.interfaces?.[0]?.host,
                gatewayPort: port(gateway),
                datastore,
                cache: byId('cache') ? { port: port(byId('cache')) } : undefined,
                messageQueue: byId('message-queue') ? { port: port(byId('message-queue')) } : undefined,
                observability: byId('observability') ? { port: port(byId('observability')) } : undefined,
                architectureId: data['$id'],
                patternId: data['$schema'],
            }
        };
    }
}
