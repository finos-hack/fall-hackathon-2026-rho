// Cases from finos/architecture-as-code calm-widgets/src/widgets/c4-diagram/index.spec.ts at commit b6d71d52: the
// Mermaid C4 the widget writes (`lines`, copied from the spec's expectations) and what CALM held for that view
// (`calm`, read off the spec's CALM input). Where the spec asserts only some lines (`toContain`), the other lines are
// completed by hand the way `Writer` in the widget's index.ts writes them; those cases say so.
//
// The widget turns a quote into an apostrophe, so a description with quotes comes back with apostrophes.

export interface CalmNode {
  id: string;
  type: string;
  name: string;
}

/** A relationship as the import writes it: the kind, the node ids it joins, its description and protocol. */
export interface CalmRel {
  kind: 'connects' | 'interacts' | 'composed-of' | 'deployed-in';
  /** connects: source, destination; interacts: actor, node; the others: container, then the contained nodes. */
  ids: string[];
  description?: string;
  protocol?: string;
}

export interface WidgetCase {
  name: string;
  lines: string[];
  nodes: CalmNode[];
  relationships: CalmRel[];
}

export const WIDGET_CASES: WidgetCase[] = [
  {
    name: 'a context diagram of the first system, with relationships lifted to systems and merged',
    lines: [
      'C4Context',
      '    System(shop, "Shop System", "")',
      '    Person(buyer, "Buyer", "Buys \'things\'")',
      '    System(vendor, "Vendor", "")',
      '    Rel(buyer, shop, "Browses")',
      '    Rel(shop, vendor, "Pays (2 relationships)")',
    ],
    nodes: [
      { id: 'shop', type: 'system', name: 'Shop System' },
      { id: 'buyer', type: 'actor', name: 'Buyer' },
      { id: 'vendor', type: 'system', name: 'Vendor' },
    ],
    relationships: [
      { kind: 'interacts', ids: ['buyer', 'shop'], description: 'Browses' },
      { kind: 'connects', ids: ['shop', 'vendor'], description: 'Pays' },
    ],
  },
  {
    // Hand-completed: the spec asserts the title, the boundary line, two containers and three Rel lines.
    name: 'the containers of a system inside its boundary, with technology and database shapes',
    lines: [
      'C4Container',
      '    title Shop containers',
      '    System_Boundary(shop, "Shop System") {',
      '        Container(web, "Web", "webclient", "")',
      '        Container(orders, "Orders", "service", "")',
      '        ContainerDb(orders_db, "Orders DB", "database", "")',
      '        Container(worker, "Worker", "acme:worker", "")',
      '    }',
      '    Person(buyer, "Buyer", "Buys \'things\'")',
      '    System(vendor, "Vendor", "")',
      '    Rel(buyer, web, "Browses")',
      '    Rel(web, orders, "Places orders", "HTTPS")',
      '    Rel(orders, orders_db, "Stores orders", "JDBC")',
      '    Rel(orders, vendor, "Pays")',
      '    Rel(worker, vendor, "Settles")',
    ],
    nodes: [
      { id: 'shop', type: 'system', name: 'Shop System' },
      { id: 'web', type: 'webclient', name: 'Web' },
      { id: 'orders', type: 'service', name: 'Orders' },
      { id: 'orders_db', type: 'database', name: 'Orders DB' },
      { id: 'worker', type: 'acme:worker', name: 'Worker' },
      { id: 'buyer', type: 'actor', name: 'Buyer' },
      { id: 'vendor', type: 'system', name: 'Vendor' },
    ],
    relationships: [
      { kind: 'interacts', ids: ['buyer', 'web'], description: 'Browses' },
      {
        kind: 'connects',
        ids: ['web', 'orders'],
        description: 'Places orders',
        protocol: 'HTTPS',
      },
      {
        kind: 'connects',
        ids: ['orders', 'orders_db'],
        description: 'Stores orders',
        protocol: 'JDBC',
      },
      { kind: 'connects', ids: ['orders', 'vendor'], description: 'Pays' },
      { kind: 'connects', ids: ['worker', 'vendor'], description: 'Settles' },
      {
        kind: 'composed-of',
        ids: ['shop', 'web', 'orders', 'orders_db', 'worker'],
      },
    ],
  },
  {
    name: 'an enterprise boundary at context level, with external systems outside it',
    lines: [
      'C4Context',
      '    Enterprise_Boundary(bank, "Bank") {',
      '        System(core, "Core", "")',
      '    }',
      '    System_Ext(vendor, "Vendor", "")',
      '    Rel(core, vendor, "Calls")',
    ],
    nodes: [
      { id: 'bank', type: 'ecosystem', name: 'Bank' },
      { id: 'core', type: 'system', name: 'Core' },
      { id: 'vendor', type: 'system', name: 'Vendor' },
    ],
    relationships: [
      { kind: 'connects', ids: ['core', 'vendor'], description: 'Calls' },
      { kind: 'composed-of', ids: ['bank', 'core'] },
    ],
  },
  {
    // Hand-completed: the spec asserts the boundary line and two component and Rel lines; `orders` is a node of the
    // wider architecture that the view draws only as the boundary.
    name: 'the components of a container, through the detailed architecture of a node',
    lines: [
      'C4Component',
      '    Container_Boundary(orders, "Orders") {',
      '        Component(orders_api, "API", "service", "")',
      '        Component(orders_repo, "Repo", "service", "")',
      '    }',
      '    Rel(orders_api, orders_repo, "Saves")',
    ],
    nodes: [
      { id: 'orders', type: 'service', name: 'Orders' },
      { id: 'orders_api', type: 'service', name: 'API' },
      { id: 'orders_repo', type: 'service', name: 'Repo' },
    ],
    relationships: [
      {
        kind: 'connects',
        ids: ['orders_api', 'orders_repo'],
        description: 'Saves',
      },
      { kind: 'composed-of', ids: ['orders', 'orders_api', 'orders_repo'] },
    ],
  },
  {
    name: 'deployed nodes grouped by deployment node',
    lines: [
      'C4Deployment',
      '    Deployment_Node(k8s, "Cluster", "network") {',
      '        Container(api, "API", "service", "")',
      '    }',
    ],
    nodes: [
      { id: 'k8s', type: 'network', name: 'Cluster' },
      { id: 'api', type: 'service', name: 'API' },
    ],
    relationships: [{ kind: 'deployed-in', ids: ['k8s', 'api'] }],
  },
  {
    name: 'a deployment node nested in the node it is deployed in, each declared once',
    lines: [
      'C4Deployment',
      '    Deployment_Node(cloud, "Cloud", "network") {',
      '        Deployment_Node(cluster, "Cluster", "network") {',
      '            Container(api, "API", "service", "")',
      '        }',
      '    }',
      '    Deployment_Node(a, "A", "network") {',
      '        Deployment_Node(b, "B", "network") {',
      '        }',
      '    }',
    ],
    nodes: [
      { id: 'cloud', type: 'network', name: 'Cloud' },
      { id: 'cluster', type: 'network', name: 'Cluster' },
      { id: 'api', type: 'service', name: 'API' },
      { id: 'a', type: 'network', name: 'A' },
      { id: 'b', type: 'network', name: 'B' },
    ],
    relationships: [
      { kind: 'deployed-in', ids: ['cloud', 'cluster'] },
      { kind: 'deployed-in', ids: ['cluster', 'api'] },
      { kind: 'deployed-in', ids: ['a', 'b'] },
    ],
  },
  {
    name: 'a deployment node that a relationship names, declared as an element inside its own block',
    lines: [
      'C4Deployment',
      '    Deployment_Node(cloud, "Cloud", "network") {',
      '        Deployment_Node(deployment_cluster, "Cluster", "network") {',
      '            Container(cluster, "Cluster", "network", "")',
      '            Container(api, "API", "service", "")',
      '        }',
      '    }',
      '    Rel(api, cluster, "Registers with")',
    ],
    nodes: [
      { id: 'cloud', type: 'network', name: 'Cloud' },
      { id: 'cluster', type: 'network', name: 'Cluster' },
      { id: 'api', type: 'service', name: 'API' },
    ],
    relationships: [
      {
        kind: 'connects',
        ids: ['api', 'cluster'],
        description: 'Registers with',
      },
      { kind: 'deployed-in', ids: ['cloud', 'cluster'] },
      { kind: 'deployed-in', ids: ['cluster', 'api'] },
    ],
  },
  {
    name: 'what a hidden top-level node holds, drawn outside any deployment node',
    lines: [
      'C4Deployment',
      '    Container(api, "API", "service", "")',
      '    ContainerDb(db, "DB", "database", "")',
      '    Rel(api, db, "Reads")',
    ],
    nodes: [
      { id: 'api', type: 'service', name: 'API' },
      { id: 'db', type: 'database', name: 'DB' },
    ],
    relationships: [{ kind: 'connects', ids: ['api', 'db'], description: 'Reads' }],
  },
  {
    // Hand-completed: the spec asserts the Rel line only.
    name: 'a distinct alias for each element when ids differ only in punctuation',
    lines: [
      'C4Context',
      '    System(a_b, "One", "")',
      '    System(a_b_2, "Two", "")',
      '    Rel(a_b, a_b_2, "Calls")',
    ],
    nodes: [
      { id: 'a_b', type: 'system', name: 'One' },
      { id: 'a_b_2', type: 'system', name: 'Two' },
    ],
    relationships: [
      { kind: 'connects', ids: ['a_b', 'a_b_2'], description: 'Calls' },
    ],
  },
];
