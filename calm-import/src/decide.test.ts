// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import { decide, Decision } from './decide';
import type { Arrow, Box, Diagram } from './diagram';

function box(
  id: string,
  label: string,
  shape: Box['shape'] = 'rectangle',
  extra: Partial<Box> = {},
): Box {
  return {
    id,
    label,
    shape,
    geometry: { x: 0, y: 0, width: 100, height: 50 },
    isContainer: false,
    ...extra,
  };
}

function diagram(partial: Partial<Diagram>): Diagram {
  return {
    boxes: [],
    arrows: [],
    annotations: [],
    pageNames: ['Page-1'],
    ...partial,
  };
}

function nodeType(decisions: Decision[], id: string): Decision {
  return decisions.find(d => d.kind === 'node-type' && d.targetId === id)!;
}

describe('decide', () => {
  describe('node types', () => {
    it('cylinder is a certain database', () => {
      const { decisions } = decide(
        diagram({ boxes: [box('a', 'Store', 'cylinder')] }),
      );
      expect(nodeType(decisions, 'a')).toMatchObject({
        value: 'database',
        certain: true,
        subject: 'Store',
      });
    });

    it('person, cloud and document shapes are certain', () => {
      const { decisions } = decide(
        diagram({
          boxes: [
            box('a', 'X', 'person'),
            box('b', 'Y', 'cloud'),
            box('c', 'Z', 'document'),
          ],
        }),
      );
      expect(decisions.map(d => [d.value, d.certain])).toEqual([
        ['actor', true],
        ['ecosystem', true],
        ['data-asset', true],
      ]);
    });

    it('plain box "Order Service" is a certain service', () => {
      const { decisions } = decide(
        diagram({ boxes: [box('a', 'Order Service')] }),
      );
      expect(nodeType(decisions, 'a')).toMatchObject({
        value: 'service',
        certain: true,
      });
    });

    it('plain box "Trading UI" is a certain webclient', () => {
      const { decisions } = decide(
        diagram({ boxes: [box('a', 'Trading UI')] }),
      );
      expect(nodeType(decisions, 'a')).toMatchObject({
        value: 'webclient',
        certain: true,
      });
    });

    it('plain box "Thing" is an unsure system', () => {
      const { decisions } = decide(diagram({ boxes: [box('a', 'Thing')] }));
      expect(nodeType(decisions, 'a')).toMatchObject({
        value: 'system',
        certain: false,
      });
    });

    it('a rounded box with no word match is an unsure service', () => {
      const { decisions } = decide(
        diagram({ boxes: [box('a', 'Thing', 'rounded-rectangle')] }),
      );
      expect(nodeType(decisions, 'a')).toMatchObject({
        value: 'service',
        certain: false,
      });
    });

    it('queue "Trade Events" is an unsure system with reason mentioning queue', () => {
      const { decisions } = decide(
        diagram({ boxes: [box('a', 'Trade Events', 'queue')] }),
      );
      const decision = nodeType(decisions, 'a');
      expect(decision).toMatchObject({ value: 'system', certain: false });
      expect(decision.reason).toMatch(/queue/i);
    });

    it('unsure node-type options start with the guess and end with "other…"', () => {
      const { decisions } = decide(diagram({ boxes: [box('a', 'Thing')] }));
      const { options } = nodeType(decisions, 'a');
      expect(options[0]).toBe('system');
      expect(options[options.length - 1]).toBe('other…');
      expect(new Set(options).size).toBe(options.length);
      expect(options).toHaveLength(10);
    });

    it('uses the first label line and names unlabelled boxes by cell id', () => {
      const { decisions } = decide(
        diagram({
          boxes: [box('a', 'Order Service\nTakes orders'), box('b', '')],
        }),
      );
      expect(decisions.map(d => d.subject)).toEqual([
        'Order Service',
        'cell b',
      ]);
    });
  });

  describe('containers', () => {
    it('"Kubernetes Cluster" containment is certain deployed-in and its type is certain network', () => {
      const { decisions } = decide(
        diagram({
          boxes: [
            box('k', 'Kubernetes Cluster', 'rectangle', { isContainer: true }),
          ],
        }),
      );
      expect(decisions.find(d => d.kind === 'containment')).toMatchObject({
        targetId: 'k',
        value: 'deployed-in',
        certain: true,
      });
      expect(nodeType(decisions, 'k')).toMatchObject({
        value: 'network',
        certain: true,
      });
    });

    it('"Payments Team" containment is an unsure composed-of and its type an unsure system', () => {
      const { decisions } = decide(
        diagram({
          boxes: [
            box('p', 'Payments Team', 'rounded-rectangle', {
              isContainer: true,
            }),
          ],
        }),
      );
      const containment = decisions.find(d => d.kind === 'containment')!;
      expect(containment).toMatchObject({
        value: 'composed-of',
        certain: false,
      });
      expect(containment.options).toEqual(['composed-of', 'deployed-in']);
      expect(nodeType(decisions, 'p')).toMatchObject({
        value: 'system',
        certain: false,
      });
    });

    it('zone and VPC containers are certain networks', () => {
      const { decisions } = decide(
        diagram({
          boxes: [
            box('z', 'DMZ Zone', 'rectangle', { isContainer: true }),
            box('v', 'Prod VPC', 'rectangle', { isContainer: true }),
          ],
        }),
      );
      expect(nodeType(decisions, 'z').certain).toBe(true);
      expect(nodeType(decisions, 'v').certain).toBe(true);
    });
  });

  describe('protocols', () => {
    const ends = { boxes: [box('a', 'A Service'), box('b', 'B Service')] };
    const arrow = (label: string): Arrow => ({
      id: 'e',
      label,
      sourceId: 'a',
      targetId: 'b',
      heads: 'end',
    });

    it('"https" label is a certain HTTPS protocol', () => {
      const { decisions } = decide(
        diagram({ ...ends, arrows: [arrow('https')] }),
      );
      expect(decisions.find(d => d.kind === 'protocol')).toMatchObject({
        value: 'HTTPS',
        certain: true,
        subject: 'A Service → B Service',
      });
    });

    it('"Kafka" is an unsure protocol with value none', () => {
      const { decisions } = decide(
        diagram({ ...ends, arrows: [arrow('Kafka')] }),
      );
      const decision = decisions.find(d => d.kind === 'protocol')!;
      expect(decision).toMatchObject({ value: 'none', certain: false });
      expect(decision.options.slice(0, 3)).toEqual(['none', 'HTTP', 'HTTPS']);
      expect(decision.options).toHaveLength(13);
    });

    it('"sends orders" has no protocol decision', () => {
      const { decisions } = decide(
        diagram({ ...ends, arrows: [arrow('sends orders')] }),
      );
      expect(decisions.filter(d => d.kind === 'protocol')).toEqual([]);
    });

    it('a lowercase word like "uses" has no protocol decision, but "gRPC" and "REST" do', () => {
      const words = ['uses', 'gRPC', 'REST'].map(
        label =>
          decide(diagram({ ...ends, arrows: [arrow(label)] })).decisions.filter(
            d => d.kind === 'protocol',
          ).length,
      );
      expect(words).toEqual([0, 1, 1]);
    });

    it('a loose arrow gets no protocol decision', () => {
      const { decisions } = decide(
        diagram({
          ...ends,
          arrows: [{ ...arrow('Kafka'), targetId: undefined }],
        }),
      );
      expect(decisions.filter(d => d.kind === 'protocol')).toEqual([]);
    });
  });

  it('notes list annotations, loose arrows, two-headed arrows and other pages', () => {
    const { notes } = decide(
      diagram({
        boxes: [box('a', 'A Service'), box('b', 'B Service')],
        arrows: [
          { id: 'l', label: '', sourceId: 'a', heads: 'end' },
          { id: 'm', label: 'calls', heads: 'end' },
          { id: 't', label: '', sourceId: 'a', targetId: 'b', heads: 'both' },
          { id: 'r', label: '', sourceId: 'b', targetId: 'a', heads: 'start' },
          { id: 'n', label: '', sourceId: 'a', targetId: 'b', heads: 'none' },
        ],
        annotations: [
          { id: 'n', label: 'TODO: add DR site', kind: 'note' },
          { id: 'g', label: 'Legend', kind: 'legend' },
          { id: 'i', label: '', kind: 'image' },
        ],
        pageNames: ['Arch', 'Ops'],
      }),
    );
    expect(notes).toEqual([
      { subject: 'TODO: add DR site', message: 'sticky note', kind: 'skipped' },
      { subject: 'Legend', message: 'legend', kind: 'skipped' },
      { subject: 'cell i', message: 'image', kind: 'skipped' },
      {
        subject: 'arrow l (A Service → ?)',
        message: 'arrow with a loose end',
        kind: 'skipped',
      },
      {
        subject: '"calls" (? → ?)',
        message: 'arrow with a loose end',
        kind: 'skipped',
      },
      {
        subject: 'A Service ↔ B Service',
        message: 'two-headed arrow, kept the drawn direction',
        kind: 'adjusted',
      },
      {
        subject: 'B Service → A Service',
        message: 'arrowhead only at the start, made it point that way',
        kind: 'adjusted',
      },
      {
        subject: 'A Service — B Service',
        message: 'no arrowheads, kept the drawn direction',
        kind: 'adjusted',
      },
      {
        subject: 'page "Ops"',
        message: 'page not converted (only the first page is)',
        kind: 'skipped',
      },
    ]);
  });
});
