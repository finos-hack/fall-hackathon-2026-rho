import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertC4 } from './index';
import type { ConvertResult } from '../result';

interface Node {
  'unique-id': string;
  'node-type': string;
  name: string;
  description: string;
}
interface Relationship {
  'unique-id': string;
  description?: string;
  protocol?: string;
  'relationship-type': Record<string, any>;
}

const nodesOf = (r: ConvertResult) => r.architecture.nodes as Node[];
const relsOf = (r: ConvertResult) =>
  r.architecture.relationships as Relationship[];
const node = (r: ConvertResult, id: string) =>
  nodesOf(r).find(n => n['unique-id'] === id)!;
const connects = (r: ConvertResult) =>
  relsOf(r).filter(rel => 'connects' in rel['relationship-type']);

const convert = (body: string, header = 'C4Container') =>
  convertC4(`${header}\n${body}\n`);

describe('convertC4: elements', () => {
  it('maps Person to an actor, with no guess', async () => {
    const r = await convert('Person(p, "Trader", "Trades")');

    expect(node(r, 'p')).toEqual({
      'unique-id': 'p',
      'node-type': 'actor',
      name: 'Trader',
      description: 'Trades',
    });
    expect(r.guesses).toEqual([]);
  });

  it('maps System to a system and SystemDb to a database, with no guess', async () => {
    const r = await convert('System(s, "S")\nSystemDb(d, "D")', 'C4Context');

    expect(node(r, 's')['node-type']).toBe('system');
    expect(node(r, 'd')['node-type']).toBe('database');
    expect(r.guesses).toEqual([]);
  });

  it('maps ContainerDb and ComponentDb to a database, with no guess', async () => {
    const r = await convert('ContainerDb(a, "A")\nComponentDb(b, "B")');

    expect(node(r, 'a')['node-type']).toBe('database');
    expect(node(r, 'b')['node-type']).toBe('database');
    expect(r.guesses).toEqual([]);
  });

  it('takes a CALM node type from the technology of a Container or Component, with no guess', async () => {
    const r = await convert(
      'Container(a, "A", "service", "")\nComponent(b, "B", "webclient", "")\nContainer(c, "C", "acme:worker", "")',
    );

    expect(nodesOf(r).map(n => n['node-type'])).toEqual([
      'service',
      'webclient',
      'acme:worker',
    ]);
    expect(r.guesses).toEqual([]);
  });

  it('guesses service for other technology and keeps the technology after the description', async () => {
    const r = await convert(
      'Container(a, "Orders", "Java, Spring Boot", "Takes orders")',
    );

    expect(node(r, 'a')['node-type']).toBe('service');
    expect(node(r, 'a').description).toBe(
      'Takes orders. Technology: Java, Spring Boot',
    );
    expect(r.guesses).toHaveLength(1);
    expect(r.guesses[0]).toMatch(/^Orders — node type: service \(/);
  });

  it('guesses service for a Container with no technology at all', async () => {
    const r = await convert('Container(a, "Orders", "", "Takes orders")');

    expect(node(r, 'a')['node-type']).toBe('service');
    expect(node(r, 'a').description).toBe('Takes orders');
    expect(r.guesses).toHaveLength(1);
  });

  it('guesses webclient when the technology or the name has a web-client word', async () => {
    const r = await convert(
      'Container(a, "Shop", "React SPA", "")\nContainer(b, "Trading UI", "", "")\nComponent(c, "Portal", "Angular", "")',
    );

    expect(nodesOf(r).map(n => n['node-type'])).toEqual([
      'webclient',
      'webclient',
      'webclient',
    ]);
    expect(r.guesses).toHaveLength(3);
  });

  it('maps a Queue to a system with the draw.io queue guess', async () => {
    const r = await convert(
      'ContainerQueue(q, "Trade Events", "Kafka", "Events")\nSystemQueue(s, "S")\nComponentQueue(c, "C")',
    );

    expect(nodesOf(r).map(n => n['node-type'])).toEqual([
      'system',
      'system',
      'system',
    ]);
    expect(r.guesses[0]).toBe(
      'Trade Events — node type: system (C4 queue; CALM has no queue type)',
    );
    expect(r.guesses).toHaveLength(3);
    expect(node(r, 'q').description).toBe('Events. Technology: Kafka');
  });

  it('uses the name as the description when there is none', async () => {
    const r = await convert('Person(p, "Trader")\nPerson(q, "Quant", "")');

    expect(node(r, 'p').description).toBe('Trader');
    expect(node(r, 'q').description).toBe('Quant');
  });

  it('notes an _Ext element and converts it as the macro without _Ext', async () => {
    const r = await convert('System_Ext(v, "Vendor")\nPerson_Ext(c, "Clerk")');

    expect(node(r, 'v')['node-type']).toBe('system');
    expect(node(r, 'c')['node-type']).toBe('actor');
    expect(r.report).toContain(
      'Vendor — external in C4; CALM marks external by position',
    );
    expect(r.report).toContain('Changed:');
  });

  it('keeps the first element of a duplicate alias and notes the second', async () => {
    const r = await convert(
      'Person(a, "First")\nSystem(a, "Second")\nRel(a, a, "x")',
    );

    expect(nodesOf(r)).toHaveLength(1);
    expect(node(r, 'a').name).toBe('First');
    expect(r.report).toContain('Second — alias "a" is already used, kept the first');
  });

  it('names an element with no name after its alias', async () => {
    const r = await convert('Container(web, "", "service", "")');

    expect(node(r, 'web').name).toBe('web');
    expect(r.report).toContain('no name, used the alias');
  });
});

describe('convertC4: boundaries', () => {
  it('maps Enterprise_Boundary to an ecosystem that composes its contents', async () => {
    const r = await convert(
      'Enterprise_Boundary(bank, "Bank") {\n  System(core, "Core")\n}\nSystem_Ext(v, "Vendor")',
      'C4Context',
    );

    expect(node(r, 'bank')['node-type']).toBe('ecosystem');
    expect(relsOf(r)).toEqual([
      {
        'unique-id': 'bank-composed-of',
        'relationship-type': {
          'composed-of': { container: 'bank', nodes: ['core'] },
        },
      },
    ]);
    expect(r.guesses).toEqual([]);
  });

  it('maps System_Boundary to the system node of that alias, created when no element has it', async () => {
    const r = await convert(
      'System_Boundary(shop, "Shop") {\n  Container(web, "Web", "webclient", "")\n}',
    );

    expect(node(r, 'shop')).toMatchObject({
      'node-type': 'system',
      name: 'Shop',
    });
    expect(relsOf(r)[0]!['relationship-type']).toEqual({
      'composed-of': { container: 'shop', nodes: ['web'] },
    });
    expect(r.guesses).toEqual([]);
  });

  it('reuses the element that has the alias of a System_Boundary', async () => {
    const r = await convert(
      'System(shop, "Shop", "The shop")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Web", "webclient", "")\n}',
    );

    expect(nodesOf(r).filter(n => n['unique-id'] === 'shop')).toHaveLength(1);
    expect(node(r, 'shop').description).toBe('The shop');
    expect(relsOf(r)).toHaveLength(1);
  });

  it('notes a boundary that reuses an element of its alias, and keeps the element as it is', async () => {
    const r = await convert(
      'Container(s, "Shop", "service", "")\nEnterprise_Boundary(s, "Shop") {\n  Person(p, "P")\n}',
    );

    expect(node(r, 's')['node-type']).toBe('service');
    expect(r.report).toContain(
      'Shop — Enterprise_Boundary reuses the element s; kept it as service',
    );
  });

  it('maps Container_Boundary to the container node, created as a guessed service when missing', async () => {
    const r = await convert(
      'Container_Boundary(orders, "Orders") {\n  Component(api, "API", "service", "")\n}',
      'C4Component',
    );

    expect(node(r, 'orders')['node-type']).toBe('service');
    expect(relsOf(r)[0]!['relationship-type']).toEqual({
      'composed-of': { container: 'orders', nodes: ['api'] },
    });
    expect(r.guesses).toEqual([
      'Orders — node type: service (C4 container boundary with no container of its own)',
    ]);
  });

  it('maps a plain Boundary to a guessed system that composes its contents', async () => {
    const r = await convert(
      'Boundary(b, "Area") {\n  Person(p, "P")\n}',
      'C4Context',
    );

    expect(node(r, 'b')['node-type']).toBe('system');
    expect(r.guesses).toEqual([
      'Area — node type: system (C4 boundary; CALM has no boundary type)',
      'Area — containment: composed-of (C4 boundary; could mean "runs in" or "is part of")',
    ]);
  });

  it('maps a plain Boundary named like a place things run in to a network its contents are deployed in, by rule', async () => {
    const r = await convert(
      'Boundary(k8s, "Kubernetes Cluster") {\n  Container(api, "API", "service", "")\n}',
    );

    expect(node(r, 'k8s')['node-type']).toBe('network');
    expect(relsOf(r)[0]!['relationship-type']).toEqual({
      'deployed-in': { container: 'k8s', nodes: ['api'] },
    });
    expect(r.guesses).toEqual([]);
  });

  it('reads the place word from the type argument of a plain Boundary too', async () => {
    const r = await convert(
      'Boundary(prod, "Production", "vpc") {\n  Container(api, "API", "service", "")\n}',
    );

    expect(node(r, 'prod')['node-type']).toBe('network');
    expect(relsOf(r)[0]!['relationship-type']).toEqual({
      'deployed-in': { container: 'prod', nodes: ['api'] },
    });
    expect(r.guesses).toEqual([]);
  });

  it('maps Deployment_Node with a CALM node type to that type and deployed-in, with no guess', async () => {
    const r = await convert(
      'Deployment_Node(k8s, "Cluster", "network") {\n  Container(api, "API", "service", "")\n}',
      'C4Deployment',
    );

    expect(node(r, 'k8s')['node-type']).toBe('network');
    expect(relsOf(r)[0]!['relationship-type']).toEqual({
      'deployed-in': { container: 'k8s', nodes: ['api'] },
    });
    expect(r.guesses).toEqual([]);
  });

  it('guesses network for a Node whose type is not a CALM node type, and keeps the text', async () => {
    const r = await convert(
      'Node(vm, "Server", "Ubuntu 24.04") {\n  Container(api, "API", "service", "")\n}\nNode_L(x, "X")',
      'C4Deployment',
    );

    expect(node(r, 'vm')['node-type']).toBe('network');
    expect(node(r, 'vm').description).toBe('Server. Technology: Ubuntu 24.04');
    expect(node(r, 'x')['node-type']).toBe('network');
    expect(r.guesses).toHaveLength(2);
  });

  it('nests deployment nodes: the inner one is deployed in the outer one', async () => {
    const r = await convert(
      'Deployment_Node(cloud, "Cloud", "network") {\n  Deployment_Node(k8s, "Cluster", "network") {\n    Container(api, "API", "service", "")\n  }\n}',
      'C4Deployment',
    );

    expect(relsOf(r).map(rel => rel['relationship-type'])).toEqual([
      { 'deployed-in': { container: 'cloud', nodes: ['k8s'] } },
      { 'deployed-in': { container: 'k8s', nodes: ['api'] } },
    ]);
  });

  it('merges a Deployment_Node with the element of the same name that the widget declares inside it', async () => {
    const r = await convert(
      'Deployment_Node(deployment_api, "API", "network") {\n  Container(api, "API", "service", "")\n}',
      'C4Deployment',
    );

    expect(nodesOf(r)).toHaveLength(1);
    expect(node(r, 'api')).toMatchObject({
      'node-type': 'service',
      name: 'API',
    });
    expect(relsOf(r)).toEqual([]);
  });

  it('keeps the other children of a merged deployment node, and lets a Rel name it by either alias', async () => {
    const r = await convert(
      'Deployment_Node(cloud, "Cloud", "network") {\n' +
        '  Deployment_Node(deployment_cluster, "Cluster", "network") {\n' +
        '    Container(cluster, "Cluster", "network", "")\n' +
        '    Container(api, "API", "service", "")\n' +
        '  }\n}\n' +
        'Rel(api, cluster, "Registers with")\nRel(api, deployment_cluster, "Heartbeats")',
      'C4Deployment',
    );

    expect(nodesOf(r).map(n => n['unique-id'])).toEqual([
      'cloud',
      'cluster',
      'api',
    ]);
    expect(
      relsOf(r)
        .filter(rel => 'deployed-in' in rel['relationship-type'])
        .map(rel => rel['relationship-type']),
    ).toEqual([
      { 'deployed-in': { container: 'cloud', nodes: ['cluster'] } },
      { 'deployed-in': { container: 'cluster', nodes: ['api'] } },
    ]);
    expect(connects(r).map(rel => rel.description)).toEqual([
      'Registers with',
      'Heartbeats',
    ]);
  });
});

describe('convertC4: relationships', () => {
  const two = 'Person(p, "P")\nContainer(a, "A", "service", "")\nContainer(b, "B", "service", "")\n';

  it('maps a Rel from a Person to interacts', async () => {
    const r = await convert(`${two}Rel(p, a, "Uses")`);

    expect(relsOf(r)).toEqual([
      {
        'unique-id': 'p-to-a',
        description: 'Uses',
        'relationship-type': { interacts: { actor: 'p', nodes: ['a'] } },
      },
    ]);
  });

  it('maps any other Rel to connects, with the label as the description', async () => {
    const r = await convert(`${two}Rel(a, b, "Calls")`);

    expect(relsOf(r)).toEqual([
      {
        'unique-id': 'a-to-b',
        description: 'Calls',
        'relationship-type': {
          connects: { source: { node: 'a' }, destination: { node: 'b' } },
        },
      },
    ]);
  });

  it('leaves the description out when the Rel has no label', async () => {
    const r = await convert(`${two}Rel(a, b, "")`);

    expect(relsOf(r)[0]).not.toHaveProperty('description');
  });

  it('takes a technology that is a CALM protocol as the protocol, in any case, with no guess', async () => {
    const r = await convert(
      `${two}Rel(a, b, "Calls", "https")\nRel(b, a, "Reads", "jdbc")`,
    );

    expect(relsOf(r).map(rel => rel.protocol)).toEqual(['HTTPS', 'JDBC']);
    expect(r.guesses).toEqual([]);
  });

  it('guesses no protocol for a technology that is not one, and keeps the technology in the description', async () => {
    const r = await convert(`${two}Rel(a, b, "Publishes", "Kafka")\nRel(b, a, "", "gRPC")`);

    expect(relsOf(r)[0]).not.toHaveProperty('protocol');
    expect(relsOf(r)[0]!.description).toBe('Publishes. Technology: Kafka');
    expect(relsOf(r)[1]!.description).toBe('Technology: gRPC');
    expect(r.guesses).toEqual([
      'A → B — protocol: none ("Kafka" is not a CALM protocol)',
      'B → A — protocol: none ("gRPC" is not a CALM protocol)',
    ]);
  });

  it('points Rel_Back from the second alias to the first', async () => {
    const r = await convert(`${two}Rel_Back(a, b, "Replies")`);

    expect(relsOf(r)[0]!['relationship-type']).toEqual({
      connects: { source: { node: 'b' }, destination: { node: 'a' } },
    });
  });

  it('reads the directional Rel variants as Rel', async () => {
    const r = await convert(`${two}Rel_Down(a, b, "x")\nRel_R(b, a, "y")`);

    expect(connects(r)).toHaveLength(2);
  });

  it('keeps one connects for a BiRel, in the written direction, and says so', async () => {
    const r = await convert(`${two}BiRel(a, b, "Syncs")`);

    expect(connects(r)).toHaveLength(1);
    expect(connects(r)[0]!['relationship-type']).toEqual({
      connects: { source: { node: 'a' }, destination: { node: 'b' } },
    });
    expect(r.report).toContain(
      'A ↔ B — two-way relationship, kept the written direction',
    );
  });

  it('strips the widget’s "(N relationships)" suffix and says it stood for N', async () => {
    const r = await convert(`${two}Rel(a, b, "Pays (2 relationships)")`);

    expect(relsOf(r)[0]!.description).toBe('Pays');
    expect(r.report).toContain('A → B — stood for 2 relationships');
  });

  it('leaves a label that only looks like the suffix alone', async () => {
    const r = await convert(
      `${two}Rel(a, b, "Pays (2 relationships) now")\nRel(b, a, "Many (x relationships)")`,
    );

    expect(relsOf(r).map(rel => rel.description)).toEqual([
      'Pays (2 relationships) now',
      'Many (x relationships)',
    ]);
  });

  it('numbers the id of a second relationship between the same nodes', async () => {
    const r = await convert(`${two}Rel(a, b, "One")\nRel(a, b, "Two")`);

    expect(relsOf(r).map(rel => rel['unique-id'])).toEqual(['a-to-b', 'a-to-b-2']);
    expect(r.report).toContain('A → B — id "a-to-b" was taken, used "a-to-b-2"');
  });

  it('never gives a relationship the id of a node', async () => {
    const r = await convert(
      'Container(a, "A", "service", "")\nContainer(b, "B", "service", "")\nContainer(a-to-b, "AB", "service", "")\nRel(a, b, "x")',
    );

    expect(relsOf(r)[0]!['unique-id']).toBe('a-to-b-2');
  });

  it('skips a Rel that names an unknown alias, and lists it', async () => {
    const r = await convert(`${two}Rel(a, nope, "Calls")\nRel(ghost, a, "Calls")`);

    expect(relsOf(r)).toEqual([]);
    expect(r.report).toContain('Skipped:');
    expect(r.report).toContain('A → nope — unknown alias "nope"');
    expect(r.report).toContain('ghost → A — unknown alias "ghost"');
  });
});

describe('convertC4: the result', () => {
  it('has the CALM 1.3 $schema and no layout', async () => {
    const r = await convert('Person(p, "P")');

    expect(r.architecture.$schema).toBe(
      'https://calm.finos.org/release/1.3/meta/calm.json',
    );
    expect(r.architecture).not.toHaveProperty('metadata');
  });

  it('counts the nodes and the relationships, containment included', async () => {
    const r = await convert(
      'Person(p, "P")\nSystem_Boundary(s, "S") {\n  Container(a, "A", "service", "")\n}\nRel(p, a, "Uses")',
    );

    expect([r.nodes, r.relationships]).toEqual([3, 2]);
    expect(r.report).toMatch(/^Converted 3 nodes, 2 relationships/);
  });

  it('reads C4-PlantUML as well', async () => {
    const r = await convertC4(
      '@startuml\n!include C4_Container.puml\nPerson(p, "P")\nContainer(a, "A", $techn="service")\nRel(p, a, "Uses")\n@enduml\n',
    );

    expect(nodesOf(r).map(n => n['node-type'])).toEqual(['actor', 'service']);
    expect(relsOf(r)).toHaveLength(1);
  });

  it('lists the skipped statements of the diagram', async () => {
    const r = await convert('Person(p, "P")\nFrobnicate(x)');

    expect(r.report).toContain('Skipped:');
    expect(r.report).toContain('line 3: Frobnicate(x)');
  });
});

describe('convertC4: finding the diagram', () => {
  it('reads the C4 block of a Markdown file that has a flowchart block before it', async () => {
    const r = await convertC4(
      '# Docs\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nC4Context\nPerson(p, "P")\n```\n',
    );

    expect(nodesOf(r).map(n => n['unique-id'])).toEqual(['p']);
  });

  it('numbers a skipped line by its place in the Markdown file', async () => {
    const r = await convertC4(
      '# Docs\n\n```mermaid\nC4Context\nPerson(p, "P")\nWhat(x)\n```\n',
    );

    expect(r.report).toContain('line 6: What(x)');
  });

  it('reads only the first C4 block and reports the later ones as skipped', async () => {
    const r = await convertC4(
      '```mermaid\nC4Context\nPerson(a, "A")\n```\n\n```mermaid\nC4Container\nPerson(b, "B")\n```\n',
    );

    expect(nodesOf(r).map(n => n['unique-id'])).toEqual(['a']);
    expect(r.report).toContain(
      'C4 diagram at line 7 — only the first C4 diagram of a file is imported',
    );
  });

  it('reads a C4-PlantUML block inside a Markdown file', async () => {
    const r = await convertC4(
      '# Docs\n```plantuml\n@startuml\nPerson(p, "P")\n@enduml\n```\n',
    );

    expect(nodesOf(r)).toHaveLength(1);
  });

  it('refuses a file with no C4 diagram', async () => {
    await expect(convertC4('hello')).rejects.toThrow(
      'No C4 diagram found; expected C4Context, C4Container, C4Component or C4Deployment',
    );
  });

  it('hints at draw.io when the file is a draw.io file', async () => {
    await expect(convertC4('<mxfile><diagram/></mxfile>')).rejects.toThrow(
      'No C4 diagram found; expected C4Context, C4Container, C4Component or C4Deployment; this looks like draw.io: choose "draw.io" as the format',
    );
  });

  it('hints at Mermaid when the file is a Mermaid flowchart', async () => {
    await expect(convertC4('flowchart LR\n A --> B\n')).rejects.toThrow(
      'No C4 diagram found; expected C4Context, C4Container, C4Component or C4Deployment; this looks like Mermaid flowchart: choose "Mermaid flowchart" as the format',
    );
  });

  it('refuses a C4 diagram with no elements', async () => {
    await expect(convertC4('C4Context\ntitle Empty\n')).rejects.toThrow(
      'The C4 diagram has no elements to convert',
    );
  });

  it('refuses C4Dynamic, the PlantUML preprocessor and unbalanced braces with the parser’s message', async () => {
    await expect(convertC4('C4Dynamic\nPerson(a, "A")')).rejects.toThrow(
      'C4Dynamic diagrams are not supported',
    );
    await expect(
      convertC4('@startuml\n!define X 1\n@enduml'),
    ).rejects.toThrow('The PlantUML preprocessor is not supported (line 2)');
    await expect(convertC4('C4Context\nBoundary(a, "A") {\n')).rejects.toThrow(
      'Unbalanced "{" opened at line 2',
    );
  });
});

describe('convertC4: the trading sample', () => {
  const sample = () =>
    convertC4(
      readFileSync(join(__dirname, '../../examples/trading.c4.md'), 'utf-8'),
    );

  it('has the 7 nodes and 7 relationships of trading.drawio', async () => {
    const r = await sample();

    expect([r.nodes, r.relationships]).toEqual([7, 7]);
    expect(nodesOf(r).map(n => [n['unique-id'], n['node-type']])).toEqual([
      ['trader', 'actor'],
      ['ui', 'webclient'],
      ['k8s', 'network'],
      ['order', 'service'],
      ['events', 'system'],
      ['risk', 'service'],
      ['db', 'database'],
    ]);
    expect(
      relsOf(r).map(rel => [rel['unique-id'], rel.protocol ?? null]),
    ).toEqual([
      ['trader-to-ui', null],
      ['ui-to-order', 'HTTPS'],
      ['order-to-db', 'JDBC'],
      ['order-to-events', null],
      ['events-to-risk', 'AMQP'],
      ['order-to-risk', null],
      ['k8s-deployed-in', null],
    ]);
  });

  it('lists its guesses and what it changed', async () => {
    const r = await sample();

    expect(r.guesses).toEqual([
      'Trading UI — node type: webclient (name or technology looks like a web client)',
      'Order Service — node type: service (technology "Java, Spring Boot" is not a CALM node type)',
      'Trade Events — node type: system (C4 queue; CALM has no queue type)',
      'Risk Service — node type: service (technology "Java, Spring Boot" is not a CALM node type)',
      'Order Service → Trade Events — protocol: none ("Kafka" is not a CALM protocol)',
    ]);
    expect(r.report).toContain(
      'Order Service ↔ Risk Service — two-way relationship, kept the written direction',
    );
  });
});
