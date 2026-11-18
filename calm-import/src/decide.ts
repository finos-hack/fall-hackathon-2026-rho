// Copied from finos/architecture-as-code experimental/calm-import (branch feat/calm-import, 590a3dcc).
import type { Arrow, Box, Diagram, ShapeHint } from './diagram';

export const NODE_TYPES = [
  'actor',
  'ecosystem',
  'system',
  'service',
  'database',
  'network',
  'ldap',
  'webclient',
  'data-asset',
] as const;
export const PROTOCOLS = [
  'HTTP',
  'HTTPS',
  'FTP',
  'SFTP',
  'JDBC',
  'WebSocket',
  'SocketIO',
  'LDAP',
  'AMQP',
  'TLS',
  'mTLS',
  'TCP',
] as const;
export const OTHER = 'other…';

export type DecisionKind = 'node-type' | 'containment' | 'protocol';

export interface Decision {
  kind: DecisionKind;
  targetId: string;
  /** The label the user sees. */
  subject: string;
  /** A node type, 'deployed-in' | 'composed-of', a protocol, or 'none'. */
  value: string;
  /** The guess first. */
  options: string[];
  certain: boolean;
  reason: string;
  source?: 'rule' | 'guess' | 'user';
}

export interface Note {
  subject: string;
  message: string;
  kind: 'skipped' | 'adjusted';
}

const CERTAIN_SHAPES: Partial<Record<ShapeHint, string>> = {
  cylinder: 'database',
  person: 'actor',
  cloud: 'ecosystem',
  document: 'data-asset',
};

const SHAPE_GUESS: Partial<Record<ShapeHint, string>> = {
  'rounded-rectangle': 'service',
  hexagon: 'service',
  diamond: 'service',
  parallelogram: 'data-asset',
};

const WORD_RULES: Array<[RegExp, string]> = [
  [
    /\b(db|database|datastore|data.?store|storage|redis|postgres|mysql|mongo|dynamo|cassandra)\b/i,
    'database',
  ],
  [/\b(browser|web.?app|frontend|ui|spa|portal)\b/i, 'webclient'],
  [
    /\b(network|vpc|subnet|firewall|dmz|zone|vnet|cluster|kubernetes|k8s|region)\b/i,
    'network',
  ],
  [/\b(ldap|active.?directory)\b/i, 'ldap'],
  [/\b(service|api|microservice)\b/i, 'service'],
  [/\b(ecosystem|external|third.?party|cloud|platform)\b/i, 'ecosystem'],
  [/\b(user|actor|person|customer|client|operator)\b/i, 'actor'],
];

const DEPLOYED_IN =
  /\b(cluster|vpc|network|subnet|zone|region|k8s|kubernetes)\b/i;
const PROTOCOL_LIKE = /^(?=.*[A-Z0-9])[A-Za-z][\w.+-]*$/;

const ANNOTATION_NAMES = {
  note: 'sticky note',
  text: 'text',
  image: 'image',
  legend: 'legend',
} as const;

export function decide(diagram: Diagram): {
  decisions: Decision[];
  notes: Note[];
} {
  const names = new Map(diagram.boxes.map(box => [box.id, subjectOf(box)]));
  const decisions: Decision[] = [];
  for (const box of diagram.boxes) {
    const containment = box.isContainer ? decideContainment(box) : undefined;
    decisions.push(decideNodeType(box, containment?.certain ?? false));
    if (containment) decisions.push(containment);
  }
  for (const arrow of diagram.arrows) {
    if (!arrow.sourceId || !arrow.targetId) continue;
    const protocol = decideProtocol(
      arrow,
      `${names.get(arrow.sourceId)} → ${names.get(arrow.targetId)}`,
    );
    if (protocol) decisions.push(protocol);
  }

  const notes: Note[] = [
    ...diagram.annotations.map(
      (a): Note => ({
        subject: a.label.split('\n')[0] || `cell ${a.id}`,
        message: ANNOTATION_NAMES[a.kind],
        kind: 'skipped',
      }),
    ),
    ...diagram.arrows.flatMap((arrow): Note[] => {
      const source = names.get(arrow.sourceId ?? '') ?? '?';
      const target = names.get(arrow.targetId ?? '') ?? '?';
      if (!arrow.sourceId || !arrow.targetId) {
        const name = arrow.label
          ? `"${arrow.label.split('\n')[0]}"`
          : `arrow ${arrow.id}`;
        return [
          {
            subject: `${name} (${source} → ${target})`,
            message: 'arrow with a loose end',
            kind: 'skipped',
          },
        ];
      }
      if (arrow.heads === 'both')
        return [
          {
            subject: `${source} ↔ ${target}`,
            message: 'two-headed arrow, kept the drawn direction',
            kind: 'adjusted',
          },
        ];
      if (arrow.heads === 'start')
        return [
          {
            subject: `${source} → ${target}`,
            message: 'arrowhead only at the start, made it point that way',
            kind: 'adjusted',
          },
        ];
      if (arrow.heads === 'none')
        return [
          {
            subject: `${source} — ${target}`,
            message: 'no arrowheads, kept the drawn direction',
            kind: 'adjusted',
          },
        ];
      return [];
    }),
    ...diagram.pageNames.slice(1).map(
      (name): Note => ({
        subject: `page "${name}"`,
        message: 'page not converted (only the first page is)',
        kind: 'skipped',
      }),
    ),
  ];
  return { decisions, notes };
}

export function subjectOf(box: Box): string {
  return box.label.split('\n')[0] || `cell ${box.id}`;
}

function decideNodeType(box: Box, containmentCertain: boolean): Decision {
  // The first line is the name and decides with certainty; a word only in the lines below it (a description such as
  // "Writes to the database") is a guess.
  const [name, ...below] = box.label.split('\n');
  const word = WORD_RULES.find(([pattern]) => pattern.test(name));
  const described = word
    ? undefined
    : WORD_RULES.map(([pattern, type]) => [pattern.exec(below.join('\n')), type] as const).find(([m]) => m);
  const base = {
    kind: 'node-type' as const,
    targetId: box.id,
    subject: subjectOf(box),
  };
  const certainShape = CERTAIN_SHAPES[box.shape];
  if (box.shape === 'queue') {
    return nodeTypeDecision(
      base,
      'system',
      false,
      'queue shape; CALM has no queue type',
    );
  }
  if (certainShape && !box.isContainer) {
    return nodeTypeDecision(base, certainShape, true, `${box.shape} shape`);
  }
  if (word) {
    return nodeTypeDecision(
      base,
      word[1],
      true,
      `label matches "${word[0].source}"`,
    );
  }
  if (described) {
    const [match, type] = described;
    return nodeTypeDecision(
      base,
      type,
      false,
      `a line below the name says "${match![0]}"`,
    );
  }
  const guess = box.isContainer ? 'system' : SHAPE_GUESS[box.shape] ?? 'system';
  return nodeTypeDecision(
    base,
    guess,
    containmentCertain,
    'no rule matched the shape or label',
  );
}

function nodeTypeDecision(
  base: Pick<Decision, 'kind' | 'targetId' | 'subject'>,
  value: string,
  certain: boolean,
  reason: string,
): Decision {
  return {
    ...base,
    value,
    certain,
    reason,
    options: [value, ...NODE_TYPES.filter(type => type !== value), OTHER],
  };
}

function decideContainment(box: Box): Decision {
  const certain = DEPLOYED_IN.test(box.label);
  const value = certain ? 'deployed-in' : 'composed-of';
  return {
    kind: 'containment',
    targetId: box.id,
    subject: subjectOf(box),
    value,
    options: certain ? [value] : ['composed-of', 'deployed-in'],
    certain,
    reason: certain
      ? 'label names a place things run in'
      : 'a box drawn around others can mean "runs in" or "is part of"',
  };
}

function decideProtocol(arrow: Arrow, subject: string): Decision | undefined {
  const label = arrow.label.split('\n')[0]!.trim();
  const known = PROTOCOLS.find(
    protocol => protocol.toLowerCase() === label.toLowerCase(),
  );
  const base = { kind: 'protocol' as const, targetId: arrow.id, subject };
  if (known) {
    return {
      ...base,
      value: known,
      options: [known],
      certain: true,
      reason: 'label is a CALM protocol',
    };
  }
  if (PROTOCOL_LIKE.test(label)) {
    return {
      ...base,
      value: 'none',
      options: ['none', ...PROTOCOLS],
      certain: false,
      reason: `"${label}" is not a CALM protocol`,
    };
  }
  return undefined;
}
