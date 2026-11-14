// The starter spring-boot-service: what the templates need from the architecture. The service node (node-type `service`)
// gives the name, owner and port; nothing about how it is deployed.
const STARTER = { name: 'spring-boot-service', version: '1.0.0', runtime: 'Spring Boot 4.0.9 on Java 21' };

export default class StarterTransformer {
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
                // A Maven artifactId: the service name, which is already lower-case letters, digits and hyphens.
                artifactId: serviceName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                owner: app?.metadata?.owner ?? 'unknown',
                servicePort: Number.isInteger(port) && port > 0 ? port : 8080,
                // `${PORT:<port>}` in application.properties (written whole: three braces in a row confuse Handlebars).
                portProperty: `\${PORT:${Number.isInteger(port) && port > 0 ? port : 8080}}`,
                architectureId: data['$id'] ?? '',
                patternId: data['$schema'] ?? '',
                starter: STARTER,
            },
        };
    }
}
