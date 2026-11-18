// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
/* eslint-disable prefer-template -- the cells are concatenated as in the original */
import { readDrawio } from './read';

function model(cells: string): string {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
}

function vertex(
  id: string,
  value: string,
  style: string,
  x: number,
  y: number,
  w: number,
  h: number,
  parent = '1',
): string {
  return `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}

function edge(
  id: string,
  value: string,
  source: string,
  target: string,
  style = '',
): string {
  const ends = `${source ? ` source="${source}"` : ''}${
    target ? ` target="${target}"` : ''
  }`;
  return `<mxCell id="${id}" value="${value}" style="${style}" edge="1" parent="1"${ends}><mxGeometry relative="1" as="geometry"/></mxCell>`;
}

const CONTAINER = 'rounded=0;dashed=1;fillColor=none;';

describe('readDrawio', () => {
  it('reads boxes with shape hints', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'DB', 'shape=cylinder3;whiteSpace=wrap;', 0, 0, 60, 80) +
          vertex(
            'b',
            'User',
            'shape=umlActor;verticalLabelPosition=bottom;',
            100,
            0,
            30,
            60,
          ) +
          vertex('c', 'Svc', 'rounded=1;whiteSpace=wrap;', 200, 0, 120, 60) +
          vertex('d', 'Events', 'shape=queue;', 400, 0, 120, 60) +
          vertex('e', 'Box', 'whiteSpace=wrap;', 600, 0, 120, 60),
      ),
    );
    expect(diagram.boxes.map(b => [b.label, b.shape])).toEqual([
      ['DB', 'cylinder'],
      ['User', 'person'],
      ['Svc', 'rounded-rectangle'],
      ['Events', 'queue'],
      ['Box', 'rectangle'],
    ]);
    expect(diagram.pageNames).toEqual(['Page-1']);
  });

  it('reads mxgraph queue and topic icons as queues', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'SQS', 'shape=mxgraph.aws4.queue;', 0, 0, 60, 60) +
          vertex('b', 'Topic', 'shape=mxgraph.azure.topic;', 100, 0, 60, 60),
      ),
    );
    expect(diagram.boxes.map(b => b.shape)).toEqual(['queue', 'queue']);
  });

  it('cleans HTML labels', async () => {
    const label =
      '&lt;div&gt;Order&amp;nbsp;Service&lt;/div&gt;&lt;div&gt;Takes orders &amp;amp; fills&lt;/div&gt;';
    const diagram = await readDrawio(
      model(vertex('a', label, 'html=1;', 0, 0, 120, 60)),
    );
    expect(diagram.boxes[0]!.label).toBe('Order Service\nTakes orders & fills');
  });

  it('reads labels of object wrappers in file order', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'First', '', 0, 0, 120, 60) +
          '<object label="Second" id="b"><mxCell style="" vertex="1" parent="1"><mxGeometry x="200" y="0" width="120" height="60" as="geometry"/></mxCell></object>' +
          vertex('c', 'Third', '', 400, 0, 120, 60),
      ),
    );
    expect(diagram.boxes.map(b => [b.id, b.label])).toEqual([
      ['a', 'First'],
      ['b', 'Second'],
      ['c', 'Third'],
    ]);
  });

  it('marks a dashed unfilled box holding others as a container and sets containerId', async () => {
    const diagram = await readDrawio(
      model(
        vertex('k', 'Cluster', CONTAINER, 0, 0, 400, 300) +
          vertex('s', 'Svc', '', 50, 50, 120, 60),
      ),
    );
    const [k, s] = diagram.boxes;
    expect(k!.isContainer).toBe(true);
    expect(s!.isContainer).toBe(false);
    expect(s!.containerId).toBe('k');
    expect(k!.containerId).toBeUndefined();
  });

  it('treats draw.io containers and swimlanes as containers and adds their offset to children', async () => {
    const diagram = await readDrawio(
      model(
        vertex('lane', 'Team', 'swimlane;', 100, 100, 300, 200) +
          vertex('s', 'Svc', '', 20, 40, 120, 60, 'lane') +
          vertex('c', 'Pool', 'container=1;', 500, 100, 300, 200) +
          vertex('t', 'Other', '', 20, 40, 120, 60, 'c'),
      ),
    );
    const byId = Object.fromEntries(diagram.boxes.map(b => [b.id, b]));
    expect(byId.lane!.isContainer).toBe(true);
    expect(byId.c!.isContainer).toBe(true);
    expect(byId.s!.geometry).toEqual({
      x: 120,
      y: 140,
      width: 120,
      height: 60,
    });
    expect(byId.s!.containerId).toBe('lane');
    expect(byId.t!.containerId).toBe('c');
  });

  it('does not make an empty dashed box a container', async () => {
    const diagram = await readDrawio(
      model(vertex('k', 'Zone', CONTAINER, 0, 0, 400, 300)),
    );
    expect(diagram.boxes[0]!.isContainer).toBe(false);
  });

  it('uses the nearest container for nested containers', async () => {
    const diagram = await readDrawio(
      model(
        vertex('outer', 'Region', CONTAINER, 0, 0, 800, 600) +
          vertex('inner', 'Cluster', CONTAINER, 50, 50, 400, 300) +
          vertex('s', 'Svc', '', 100, 100, 120, 60),
      ),
    );
    const byId = Object.fromEntries(diagram.boxes.map(b => [b.id, b]));
    expect(byId.s!.containerId).toBe('inner');
    expect(byId.inner!.containerId).toBe('outer');
    expect(byId.inner!.isContainer).toBe(true);
  });

  it('makes unlabelled groups transparent and adds the group offset', async () => {
    const diagram = await readDrawio(
      model(
        vertex('k', 'Cluster', CONTAINER, 0, 0, 600, 400) +
          vertex('g', '', 'group', 100, 100, 200, 100) +
          vertex('s', 'Svc', '', 10, 10, 120, 60, 'g'),
      ),
    );
    expect(diagram.boxes.map(b => b.id)).toEqual(['k', 's']);
    const s = diagram.boxes[1]!;
    expect(s.geometry).toEqual({ x: 110, y: 110, width: 120, height: 60 });
    expect(s.containerId).toBe('k');
  });

  it('does not make a box with an icon on it a container', async () => {
    const diagram = await readDrawio(
      model(
        vertex('b', 'Svc', 'fillColor=#dae8fc;', 0, 0, 200, 160) +
          vertex(
            'i',
            '',
            'shape=image;image=data:image/png,abc;',
            10,
            10,
            24,
            24,
          ),
      ),
    );
    expect(diagram.boxes).toHaveLength(1);
    expect(diagram.boxes[0]!.isContainer).toBe(false);
    expect(diagram.annotations).toEqual([
      { id: 'i', label: '', kind: 'image' },
    ]);
  });

  it('reads notes, text, images and the legend with its contents as annotations', async () => {
    const diagram = await readDrawio(
      model(
        vertex('n', 'TODO: add DR site', 'shape=note;', 0, 0, 120, 60) +
          vertex('t', 'Title', 'text;html=1;', 0, 100, 120, 30) +
          vertex('img', 'Logo', 'image;image=img/logo.png;', 0, 200, 40, 40) +
          vertex('l', 'Legend', '', 300, 0, 200, 200) +
          vertex('l1', 'Service', 'rounded=1;', 320, 40, 80, 40) +
          vertex('s', 'Real', '', 600, 0, 120, 60),
      ),
    );
    expect(diagram.boxes.map(b => b.id)).toEqual(['s']);
    expect(diagram.annotations.map(a => [a.id, a.kind])).toEqual([
      ['n', 'note'],
      ['t', 'text'],
      ['img', 'image'],
      ['l', 'legend'],
      ['l1', 'legend'],
    ]);
  });

  it('reads arrows with labels, including edge label cells', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'A', '', 0, 0, 120, 60) +
          vertex('b', 'B', '', 300, 0, 120, 60) +
          edge('e1', 'HTTPS', 'a', 'b') +
          edge('e2', '', 'b', 'a') +
          '<mxCell id="lbl" value="JDBC" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e2"><mxGeometry x="-0.1" relative="1" as="geometry"/></mxCell>',
      ),
    );
    expect(diagram.arrows).toEqual([
      { id: 'e1', label: 'HTTPS', sourceId: 'a', targetId: 'b', heads: 'end' },
      { id: 'e2', label: 'JDBC', sourceId: 'b', targetId: 'a', heads: 'end' },
    ]);
    expect(diagram.boxes.map(b => b.id)).toEqual(['a', 'b']);
  });

  it('keeps a loose arrow with an undefined end and records arrowheads', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'A', '', 0, 0, 120, 60) +
          vertex('b', 'B', '', 300, 0, 120, 60) +
          edge('loose', '', 'a', '') +
          edge('both', '', 'a', 'b', 'startArrow=classic;') +
          edge('none', '', 'a', 'b', 'endArrow=none;'),
      ),
    );
    expect(
      diagram.arrows.map(a => [a.id, a.sourceId, a.targetId, a.heads]),
    ).toEqual([
      ['loose', 'a', undefined, 'end'],
      ['both', 'a', 'b', 'both'],
      ['none', 'a', 'b', 'none'],
    ]);
  });

  it('reverses an arrow whose only head is at the start', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'A', '', 0, 0, 120, 60) +
          vertex('b', 'B', '', 300, 0, 120, 60) +
          edge('e', '', 'a', 'b', 'startArrow=classic;endArrow=none;'),
      ),
    );
    expect(diagram.arrows[0]).toMatchObject({
      sourceId: 'b',
      targetId: 'a',
      heads: 'start',
    });
  });

  it('keeps a port with relative geometry as a box on its parent', async () => {
    const diagram = await readDrawio(
      model(
        vertex('p', 'Fraud Checker', '', 100, 100, 200, 100) +
          '<mxCell id="port" value="Card Port" style="ellipse;" vertex="1" parent="p"><mxGeometry x="1" y="0.5" width="20" height="20" relative="1" as="geometry"/></mxCell>',
      ),
    );
    expect(diagram.boxes.find(b => b.id === 'port')?.geometry).toEqual({
      x: 300,
      y: 150,
      width: 20,
      height: 20,
    });
  });

  it('uses the draw.io parent container even when the child sticks out', async () => {
    const diagram = await readDrawio(
      model(
        vertex('sys', 'Payments Platform', 'container=1;', 0, 0, 300, 200) +
          vertex('s', 'Settlement Engine', '', 240, 40, 100, 60, 'sys'),
      ),
    );
    const byId = Object.fromEntries(diagram.boxes.map(b => [b.id, b]));
    expect(byId.sys!.isContainer).toBe(true);
    expect(byId.s!.containerId).toBe('sys');
  });

  it('keeps a labelled group as a container', async () => {
    const diagram = await readDrawio(
      model(
        vertex('g', 'Back Office', 'group', 0, 0, 300, 200) +
          vertex('r', 'Reconciler', '', 10, 10, 120, 60, 'g'),
      ),
    );
    const byId = Object.fromEntries(diagram.boxes.map(b => [b.id, b]));
    expect(byId.g!.isContainer).toBe(true);
    expect(byId.r!.containerId).toBe('g');
  });

  it('keeps < and & in labels that are not HTML', async () => {
    const diagram = await readDrawio(
      model(
        vertex(
          'a',
          'Price &lt; 100 &amp; &gt; 5 store',
          'rounded=1;',
          0,
          0,
          120,
          60,
        ),
      ),
    );
    expect(diagram.boxes[0]!.label).toBe('Price < 100 & > 5 store');
  });

  it('detects a legend labelled "Legend:"', async () => {
    const diagram = await readDrawio(
      model(
        vertex('l', 'Legend:', '', 300, 0, 200, 200) +
          vertex('l1', 'Service', 'rounded=1;', 320, 40, 80, 40),
      ),
    );
    expect(diagram.boxes).toEqual([]);
    expect(diagram.annotations.map(a => a.kind)).toEqual(['legend', 'legend']);
  });

  it('drops arrow ends that point at annotations', async () => {
    const diagram = await readDrawio(
      model(
        vertex('a', 'A', '', 0, 0, 120, 60) +
          vertex('n', 'note', 'shape=note;', 300, 0, 120, 60) +
          edge('e', '', 'a', 'n'),
      ),
    );
    expect(diagram.arrows[0]!.targetId).toBeUndefined();
  });

  it('passes the page names through', async () => {
    const diagram = await readDrawio(
      `<mxfile><diagram name="Arch">${model(
        '',
      )}</diagram><diagram name="Ops">${model('')}</diagram></mxfile>`,
    );
    expect(diagram.pageNames).toEqual(['Arch', 'Ops']);
  });
});
