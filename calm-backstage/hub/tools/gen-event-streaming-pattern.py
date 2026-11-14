#!/usr/bin/env python3
"""Writes seed/patterns/event-streaming.pattern.json from the building blocks of web-service.pattern.json.

Usage: python3 hub/tools/gen-event-streaming-pattern.py <repository root>. The output is committed; run again
only to change the pattern (then give it a new version: CALM Hub versions cannot change)."""
import copy, json, sys

ROOT = sys.argv[1]
ws = json.load(open(f'{ROOT}/seed/patterns/web-service.pattern.json'))
N = ws['properties']['nodes']['prefixItems']
R = ws['properties']['relationships']['prefixItems']
HUB = 'http://localhost:8090'

def const(node, key, value):
    node['properties'][key] = {'const': value}

def set_node(n, uid, ntype, name, desc):
    const(n, 'unique-id', uid); const(n, 'node-type', ntype); const(n, 'name', name); const(n, 'description', desc)
    return n

web_client = copy.deepcopy(N[0])
const(web_client, 'description', 'The browser that sends events and watches them arrive.')
gateway = copy.deepcopy(N[1])
const(gateway, 'description', 'Routes external requests to the stream app.')

app = copy.deepcopy(N[2])
set_node(app, 'stream-app', 'service', 'Stream App', 'The service the developer builds: it produces events to the broker and consumes them back.')
app['properties']['metadata']['properties']['topic'] = {'type': 'string'}
app['properties']['metadata']['required'] = ['owner', 'service-name', 'topic']
iface = app['properties']['interfaces']['prefixItems'][0]
const(iface, 'unique-id', 'stream-app-api')

broker = copy.deepcopy(N[1])
set_node(broker, 'nisshi-broker', 'system', 'Nisshi broker',
         'Nisshi (nisshi.io): a stateless, Kafka-compatible broker with pluggable storage.')
broker['properties']['interfaces']['prefixItems'][0] = {
    'type': 'object',
    'properties': {'unique-id': {'const': 'nisshi-kafka'}, 'port': {'const': 9092}},
    'required': ['unique-id', 'port'],
}

pg = copy.deepcopy(N[3]['oneOf'][0])
set_node(pg, 'broker-postgres', 'database', 'PostgreSQL', 'Durable storage for the broker’s topics.')
pg['properties']['interfaces']['prefixItems'][0]['properties']['unique-id'] = {'const': 'broker-postgres-port'}

sqlite = {
    '$ref': 'https://calm.finos.org/release/1.3/meta/core.json#/defs/node',
    'type': 'object',
    'properties': {
        'unique-id': {'const': 'broker-sqlite'},
        'node-type': {'const': 'data-asset'},
        'name': {'const': 'SQLite'},
        'description': {'const': 'An embedded SQLite file on the broker’s own volume: one broker, no database to run.'},
    },
    'required': ['unique-id', 'node-type', 'name', 'description'],
}

def rel(src, uid, desc, protocol, rtype, ctrl_desc=None, config=None):
    r = copy.deepcopy(src)
    const(r, 'unique-id', uid); const(r, 'description', desc)
    if protocol:
        const(r, 'protocol', protocol)
    r['properties']['relationship-type'] = {'const': rtype}
    if ctrl_desc:
        sec = r['properties']['controls']['properties']['security']['properties']
        sec['description'] = {'const': ctrl_desc}
        sec['requirements']['prefixItems'][0]['properties']['config-url'] = {
            'const': f'{HUB}/calm/domains/hackathon-security/controls/permitted-connection/configurations/{config}/versions/1.0.0'}
    return r

connects = lambda s, d: {'connects': {'source': {'node': s}, 'destination': {'node': d}}}
client_gw = copy.deepcopy(R[0])
const(client_gw, 'description', 'The browser calls the stream app through the gateway')
gw_app = rel(R[1], 'api-gateway-stream-app', 'The gateway forwards requests to the stream app', 'HTTPS', connects('api-gateway', 'stream-app'))
app_broker = rel(R[2]['oneOf'][0], 'stream-app-nisshi-broker', 'The stream app produces and consumes events with the Kafka protocol', 'TCP',
                 connects('stream-app', 'nisshi-broker'), 'Connections to the broker must be permitted', 'datastore')
broker_pg = rel(R[2]['oneOf'][0], 'nisshi-broker-postgres', 'The broker stores its topics in PostgreSQL', 'JDBC',
                connects('nisshi-broker', 'broker-postgres'))
broker_sqlite = {
    '$ref': 'https://calm.finos.org/release/1.3/meta/core.json#/defs/relationship',
    'type': 'object',
    'properties': {
        'unique-id': {'const': 'nisshi-broker-sqlite'},
        'description': {'const': 'The broker keeps its topics in an embedded SQLite file'},
        'relationship-type': {'const': {'composed-of': {'container': 'nisshi-broker', 'nodes': ['broker-sqlite']}}},
    },
    'required': ['unique-id', 'description', 'relationship-type'],
}

decision = copy.deepcopy(R[3])
const(decision, 'unique-id', 'broker-storage')
const(decision, 'description', 'Where does the Nisshi broker keep its topics?')
choices = decision['properties']['relationship-type']['properties']['options']['prefixItems'][0]['oneOf']
choices[0]['properties']['description'] = {'const': 'PostgreSQL'}
choices[0]['properties']['nodes'] = {'const': ['broker-postgres']}
choices[0]['properties']['relationships'] = {'const': ['nisshi-broker-postgres']}
choices[1]['properties']['description'] = {'const': 'SQLite on the broker’s volume'}
choices[1]['properties']['nodes'] = {'const': ['broker-sqlite']}
choices[1]['properties']['relationships'] = {'const': ['nisshi-broker-sqlite']}

pattern = {
    '$schema': ws['$schema'],
    '$id': f'{HUB}/calm/namespaces/hackathon/patterns/event-streaming/versions/1.0.0',
    'title': 'Event Streaming (Nisshi)',
    'description': 'A service that produces and consumes events through a Nisshi broker (Kafka-compatible, nisshi.io), behind an API gateway, with a choice of where the broker keeps its topics.',
    'type': 'object',
    'properties': {
        'nodes': {'type': 'array', 'maxItems': 5,
                  'prefixItems': [web_client, gateway, app, broker, {'oneOf': [pg, sqlite]}]},
        'relationships': {'type': 'array', 'maxItems': 5,
                          'prefixItems': [client_gw, gw_app, app_broker, {'oneOf': [broker_pg, broker_sqlite]}, decision]},
    },
    'required': ['nodes', 'relationships'],
}
open(f'{ROOT}/seed/patterns/event-streaming.pattern.json', 'w').write(json.dumps(pattern, indent=2) + '\n')
print('ok')
