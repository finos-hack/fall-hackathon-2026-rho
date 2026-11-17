import { parseC4 } from './parse';

/** The model without line numbers, so the Mermaid and PlantUML forms of one model compare equal. */
function bare(text: string) {
  const model = parseC4(text);
  const strip = <T extends { line: number }>(items: T[]) =>
    items.map(({ line: _line, ...rest }) => rest);
  return {
    level: model.level,
    elements: strip(model.elements),
    boundaries: strip(model.boundaries),
    rels: strip(model.rels),
  };
}

const MERMAID = `C4Container
  title Shop
  Person(buyer, "Buyer", "Buys things")
  System_Boundary(shop, "Shop") {
    Container(web, "Web", "React", "The site")
    ContainerDb(db, "DB", "PostgreSQL", "Orders")
  }
  Rel(buyer, web, "Browses", "HTTPS")
`;

const PLANTUML = `@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
title Shop
Person(buyer, "Buyer", "Buys things")
System_Boundary(shop, "Shop") {
  Container(web, "Web", "React", "The site")
  ContainerDb(db, "DB", "PostgreSQL", "Orders")
}
Rel(buyer, web, "Browses", "HTTPS")
SHOW_LEGEND()
@enduml
`;

describe('parseC4', () => {
  it('reads elements, a boundary with its children, and a relationship', () => {
    const model = parseC4(MERMAID);

    expect(model.level).toBe('container');
    expect(model.elements.map(e => [e.macro, e.alias, e.name])).toEqual([
      ['Person', 'buyer', 'Buyer'],
      ['Container', 'web', 'Web'],
      ['ContainerDb', 'db', 'DB'],
    ]);
    expect(model.elements[1]).toMatchObject({
      kind: 'container',
      technology: 'React',
      description: 'The site',
      parent: 0,
      db: false,
      queue: false,
      external: false,
    });
    expect(model.elements[2]).toMatchObject({ db: true, parent: 0 });
    expect(model.elements[0]!.parent).toBeUndefined();
    expect(model.boundaries).toMatchObject([
      { kind: 'system', alias: 'shop', name: 'Shop' },
    ]);
    expect(model.rels).toMatchObject([
      {
        from: 'buyer',
        to: 'web',
        label: 'Browses',
        technology: 'HTTPS',
        back: false,
        both: false,
      },
    ]);
  });

  it('gives equal results for the Mermaid and the PlantUML form of one model', () => {
    expect(bare(PLANTUML)).toEqual(bare(MERMAID));
  });

  it('reads named arguments, in any order, and mixes them with positional ones', () => {
    const model = parseC4(
      'C4Container\nContainer(api, "API", $descr="Takes orders", $techn="Java")\n' +
        'Rel(a, b, "Calls", $techn="gRPC")\n',
    );

    expect(model.elements[0]).toMatchObject({
      name: 'API',
      technology: 'Java',
      description: 'Takes orders',
    });
    expect(model.rels[0]).toMatchObject({ label: 'Calls', technology: 'gRPC' });
  });

  it('keeps commas and parentheses inside quoted arguments', () => {
    const model = parseC4(
      'C4Container\nContainer(a, "Orders, (v2)", "Java (17), Spring", "Does (x), then y")\n' +
        'Rel(a, b, "Calls (2 times), maybe", "HTTPS")\n',
    );

    expect(model.elements[0]).toMatchObject({
      name: 'Orders, (v2)',
      technology: 'Java (17), Spring',
      description: 'Does (x), then y',
    });
    expect(model.rels[0]).toMatchObject({
      label: 'Calls (2 times), maybe',
      technology: 'HTTPS',
    });
    expect(model.skipped).toEqual([]);
  });

  it('keeps unquoted parentheses, and the commas inside them, in one argument', () => {
    const model = parseC4(
      'C4Container\nRel(a, b, "x", $techn=foo(1,2))\nContainer(c, "C", Java(17), "d")\n',
    );

    expect(model.skipped).toEqual([]);
    expect(model.rels[0]).toMatchObject({ label: 'x', technology: 'foo(1,2)' });
    expect(model.elements[0]).toMatchObject({
      technology: 'Java(17)',
      description: 'd',
    });
  });

  it('keeps an apostrophe or %% inside a quoted argument, not a comment', () => {
    const model = parseC4(
      'C4Context\nPerson(a, "O\'Brien", "100%% sure 50 %% off")\n',
    );

    expect(model.elements[0]).toMatchObject({
      name: "O'Brien",
      description: '100%% sure 50 %% off',
    });
  });

  it('nests blocks and records each parent', () => {
    const model = parseC4(
      'C4Deployment\n' +
        'Deployment_Node(cloud, "Cloud", "network") {\n' +
        '  Deployment_Node(k8s, "Cluster", "network") {\n' +
        '    Container(api, "API", "service", "")\n' +
        '  }\n' +
        '  Container(db, "DB", "database", "")\n' +
        '}\n' +
        'Container(out, "Out", "service", "")\n',
    );

    expect(model.level).toBe('deployment');
    expect(model.boundaries).toMatchObject([
      { alias: 'cloud', kind: 'deployment', technology: 'network' },
      { alias: 'k8s', kind: 'deployment', parent: 0 },
    ]);
    expect(model.elements.map(e => [e.alias, e.parent])).toEqual([
      ['api', 1],
      ['db', 0],
      ['out', undefined],
    ]);
  });

  it('reads a block written on one line, and statements after a { or before a } on the same line', () => {
    const model = parseC4(
      'C4Container\n' +
        'Boundary(b, "B") { Container(c, "C") }\n' +
        'System_Boundary(s, "S") { Person(p, "P")\n' +
        '  Container(d, "D") }\n' +
        'Container(out, "Out")\n',
    );

    expect(model.boundaries.map(b => b.alias)).toEqual(['b', 's']);
    expect(model.elements.map(e => [e.alias, e.parent, e.line])).toEqual([
      ['c', 0, 2],
      ['p', 1, 3],
      ['d', 1, 4],
      ['out', undefined, 5],
    ]);
    expect(model.skipped).toEqual([]);
  });

  it('reads a block opened without a space before the brace', () => {
    const model = parseC4(
      'C4Deployment\nDeployment_Node(d, "D", ""){\nContainer(a, "A", "", "x")\n}\n',
    );

    expect(model.elements[0]!.parent).toBe(0);
  });

  it('skips %% and \' comments and /\' … \'/ blocks, including multi-line ones', () => {
    const model = parseC4(
      "C4Context\n%% Person(no, \"No\")\n' Person(no2, \"No\")\n" +
        "/' Person(no3, \"No\")\nPerson(no4, \"No\")\n'/\n" +
        "/' one line '/ Person(yes, \"Yes\")\nPerson(also, \"Also\") %% trailing\n",
    );

    expect(model.elements.map(e => e.alias)).toEqual(['yes', 'also']);
  });

  it('reads CRLF line endings, tabs and a byte order mark', () => {
    const model = parseC4(
      '﻿C4Context\r\n\tPerson(a,\t"A",\t"x")\r\n\tRel( a , b , "L" )\r\n',
    );

    expect(model.level).toBe('context');
    expect(model.elements[0]).toMatchObject({
      alias: 'a',
      name: 'A',
      description: 'x',
    });
    expect(model.rels[0]).toMatchObject({ from: 'a', to: 'b', label: 'L' });
  });

  it('reads a Mermaid file that starts with front matter', () => {
    const model = parseC4(
      '---\ntitle: Shop\n---\nC4Context\nPerson(a, "A")\n',
    );

    expect(model.level).toBe('context');
    expect(model.elements).toHaveLength(1);
  });

  it('reads the macro families: _Ext, Db, Queue, Component, Node variants', () => {
    const model = parseC4(
      'C4Component\nPerson_Ext(p, "P")\nSystemDb_Ext(s, "S")\nContainerQueue(q, "Q")\n' +
        'ComponentDb(c, "C")\nSystemQueue_Ext(sq, "SQ")\nNode_L(n, "N", "network")\nNode_R(m, "M")\n',
    );

    expect(model.elements.map(e => [e.kind, e.db, e.queue, e.external])).toEqual(
      [
        ['person', false, false, true],
        ['system', true, false, true],
        ['container', false, true, false],
        ['component', true, false, false],
        ['system', false, true, true],
      ],
    );
    expect(model.boundaries.map(b => [b.kind, b.alias])).toEqual([
      ['deployment', 'n'],
      ['deployment', 'm'],
    ]);
  });

  it('reads the boundary macros', () => {
    const model = parseC4(
      'C4Context\nEnterprise_Boundary(e, "E") {\n}\nSystem_Boundary(s, "S") {\n}\n' +
        'Container_Boundary(c, "C") {\n}\nBoundary(b, "B") {\n}\n',
    );

    expect(model.boundaries.map(b => b.kind)).toEqual([
      'enterprise',
      'system',
      'container',
      'generic',
    ]);
  });

  it('reads the relationship macros and their direction', () => {
    const model = parseC4(
      'C4Context\nRel(a, b, "1")\nRel_U(a, b, "2")\nRel_Down(a, b, "3")\n' +
        'Rel_Left(a, b, "4")\nRel_Neighbor(a, b, "5")\nRel_Back(a, b, "6")\nBiRel(a, b, "7")\nBiRel_R(a, b, "8")\n',
    );

    expect(model.rels.map(r => [r.label, r.back, r.both])).toEqual([
      ['1', false, false],
      ['2', false, false],
      ['3', false, false],
      ['4', false, false],
      ['5', false, false],
      ['6', true, false],
      ['7', false, true],
      ['8', false, true],
    ]);
  });

  it('infers the level of PlantUML without an include from what the file has', () => {
    expect(parseC4('@startuml\nPerson(a, "A")\n@enduml').level).toBe('context');
    expect(parseC4('@startuml\nContainer(a, "A")\n@enduml').level).toBe(
      'container',
    );
    expect(parseC4('@startuml\nComponent(a, "A")\n@enduml').level).toBe(
      'component',
    );
    expect(parseC4('@startuml\nNode(a, "A")\n@enduml').level).toBe(
      'deployment',
    );
  });

  it('uses the level the PlantUML include names', () => {
    expect(
      parseC4('@startuml\n!include C4_Component.puml\nPerson(a, "A")\n@enduml')
        .level,
    ).toBe('component');
  });

  it('reads only what is between @startuml and @enduml', () => {
    const model = parseC4(
      'Some text\nPerson(no, "No")\n@startuml\nPerson(yes, "Yes")\n@enduml\nPerson(no2, "No")\n',
    );

    expect(model.elements.map(e => e.alias)).toEqual(['yes']);
  });

  it('numbers lines from the first line given', () => {
    const model = parseC4('C4Context\nPerson(a, "A")\nWhat(x)\n', 10);

    expect(model.elements[0]!.line).toBe(11);
    expect(model.skipped).toEqual([{ line: 12, text: 'What(x)' }]);
  });

  it('refuses a C4Dynamic diagram: it is a flow, not structure', () => {
    expect(() => parseC4('C4Dynamic\nPerson(a, "A")\n')).toThrow(
      'C4Dynamic diagrams are not supported: they describe a flow, not structure',
    );
  });

  it('refuses RelIndex, which only dynamic diagrams use', () => {
    expect(() => parseC4('C4Context\nRelIndex(1, a, b, "x")\n')).toThrow(
      'C4Dynamic diagrams are not supported',
    );
  });

  it('refuses the PlantUML preprocessor, naming the line', () => {
    expect(() =>
      parseC4('@startuml\nPerson(a, "A")\n!define X Y\n@enduml'),
    ).toThrow('The PlantUML preprocessor is not supported (line 3)');
    expect(() => parseC4('C4Context\n!$x = 1\n')).toThrow(
      'The PlantUML preprocessor is not supported (line 2)',
    );
    expect(() => parseC4('C4Context\n!ifdef X\n')).toThrow(
      'The PlantUML preprocessor is not supported (line 2)',
    );
  });

  it('ignores !include lines without fetching anything', () => {
    const model = parseC4(
      '@startuml\n!include https://example.invalid/C4_Context.puml\n!includeurl x\nPerson(a, "A")\n@enduml',
    );

    expect(model.elements).toHaveLength(1);
    expect(model.skipped).toEqual([]);
  });

  it('ignores the layout and style macros without a report entry', () => {
    const model = parseC4(
      'C4Context\ntitle T\nUpdateLayoutConfig($c4ShapeInRow="3")\nUpdateElementStyle(a, $bgColor="red")\n' +
        'UpdateRelStyle(a, b)\nUpdateBoundaryStyle(a)\nAddElementTag("x", $bgColor="y")\nAddRelTag("x")\n' +
        'SHOW_LEGEND()\nLAYOUT_WITH_LEGEND()\nLAYOUT_TOP_DOWN()\nLay_D(a, b)\nLay_Right(a, b)\n',
    );

    expect(model.skipped).toEqual([]);
    expect(model.elements).toEqual([]);
  });

  it('reports an unknown macro as skipped with its line', () => {
    const model = parseC4(
      'C4Context\nPerson(a, "A")\nFrobnicate(a, "x")\nrandom words\n',
    );

    expect(model.skipped).toEqual([
      { line: 3, text: 'Frobnicate(a, "x")' },
      { line: 4, text: 'random words' },
    ]);
    expect(model.elements).toHaveLength(1);
  });

  it('reports a macro without a closing parenthesis as skipped', () => {
    const model = parseC4('C4Context\nPerson(a, "A"\nPerson(b, "B")\n');

    expect(model.skipped).toMatchObject([{ line: 2 }]);
    expect(model.elements.map(e => e.alias)).toEqual(['b']);
  });

  it('throws on a { that is never closed, naming its line', () => {
    expect(() =>
      parseC4('C4Context\nSystem_Boundary(a, "A") {\nPerson(p, "P")\n'),
    ).toThrow('Unbalanced "{" opened at line 2');
  });

  it('throws on a } with no matching {, naming its line', () => {
    expect(() => parseC4('C4Context\nPerson(p, "P")\n}\n')).toThrow(
      'Unbalanced "}" at line 3',
    );
  });

  it('allows 50 nested blocks and refuses the 51st with its line', () => {
    const nest = (depth: number) =>
      `C4Context\n${'Boundary(b, "B") {\n'.repeat(depth)}${'}\n'.repeat(depth)}`;

    expect(() => parseC4(nest(50))).not.toThrow();
    expect(() => parseC4(nest(51))).toThrow(
      'Nesting deeper than 50 levels at line 52',
    );
  });
});
