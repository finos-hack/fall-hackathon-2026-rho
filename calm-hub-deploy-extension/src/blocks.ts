import type { HistoryEntry } from './record';
import type { Status } from './status';

/** A reply CALM Hub draws (blocks schema 0). */
export interface BlocksReply {
  hubApi: 0;
  title?: string;
  blocks: Block[];
}

type Tone = 'positive' | 'negative' | 'warning' | 'info' | 'neutral';
type Link = { label: string; href: string } | { label: string; hub: { namespace: string; type: string; id: string; version?: string } };
type Cell = string | number | { badge: string; tone?: Tone } | Link;
export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'keyValue'; items: { label: string; value: string }[] }
  | { type: 'stats'; items: { label: string; value: string }[] }
  | { type: 'table'; columns: string[]; rows: Cell[][] }
  | { type: 'alert'; text: string; tone?: Tone }
  | { type: 'links'; items: Link[] };

const STATUS_TONE: Record<string, Tone> = {
  completed: 'positive',
  'in-progress': 'info',
  pending: 'info',
  failed: 'negative',
  'rolled-back': 'warning',
};

const http = (u?: string) => (u && /^https?:\/\//.test(u) ? u : undefined);

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** The headline for the version on screen: deployed, not deployed, or being deployed. */
function versionAlert(s: Status, version?: string): Block {
  if (s.running) {
    return {
      type: 'alert',
      tone: 'info',
      text: `Deploying ${s.running.version ?? 'a version'} (${s.running.status})${s.running.notes ? `: ${s.running.notes}` : ''}`,
    };
  }
  if (s.ready === false) {
    return { type: 'alert', tone: 'negative', text: `Flux is not ready: ${s.message ?? 'no message'}` };
  }
  if (!version || !s.deployedVersion) {
    return { type: 'alert', tone: 'info', text: `The cluster runs ${s.deployedVersion ?? 'no recorded version'}.` };
  }
  if (version === s.deployedVersion) {
    return { type: 'alert', tone: 'positive', text: `This version (${version}) is the one deployed to ${s.environment}.` };
  }
  return {
    type: 'alert',
    tone: 'warning',
    text: `${s.environment} runs ${s.deployedVersion}; this page shows ${version}. Use "Deploy this version" to deploy it.`,
  };
}

/** The designer tab for an architecture version. */
export function tabReply(s: Status, history: HistoryEntry[], version?: string): BlocksReply {
  if (!s.managed) {
    return {
      hubApi: 0,
      blocks: [
        { type: 'alert', tone: 'info', text: `Not deployed through GitOps. ${s.reason ?? ''}`.trim() },
        {
          type: 'markdown',
          text: 'This extension deploys services created from a CALM pattern with a starter and deployment rules (calm-backstage), which live in Git and are applied by Flux.',
        },
      ],
    };
  }
  const items = [
    { label: 'Environment', value: s.environment },
    { label: 'Deployed version', value: s.deployedVersion ?? 'unknown' },
    { label: 'This version', value: version ?? 'unknown' },
    { label: 'Latest version', value: s.latestVersion ?? 'unknown' },
    { label: 'Deployment rules', value: s.deploymentRules ?? 'none' },
    { label: 'Flux', value: s.ready === undefined ? s.message ?? 'unknown' : s.ready ? 'Ready' : `Not ready: ${s.message ?? ''}` },
    { label: 'Commit applied', value: s.commit ? s.commit.slice(0, 12) : 'none' },
  ];
  const links: Link[] = [
    ...(http(s.repository) ? [{ label: 'Service repository', href: s.repository! }] : []),
    ...(http(s.commitUrl) ? [{ label: `Commit ${s.commit!.slice(0, 12)}`, href: s.commitUrl! }] : []),
  ];
  const rows: Cell[][] = history.slice(0, 10).map(h => [
    h.version ?? '',
    { badge: h.status, tone: STATUS_TONE[h.status] ?? 'neutral' },
    when(h.startTime),
    h.requestedBy ?? (h.deployedBy ? '' : 'Backstage'),
    http(h.pullRequest) ? { label: `PR ${h.pullRequest!.split('/').pop()}`, href: h.pullRequest! } : '',
    h.notes ?? '',
  ]);
  return {
    hubApi: 0,
    blocks: [
      versionAlert(s, version),
      { type: 'keyValue', items },
      ...(links.length ? [{ type: 'links' as const, items: links }] : []),
      ...(rows.length
        ? [{ type: 'table' as const, columns: ['Version', 'Status', 'Started', 'Requested by', 'Pull request', 'Notes'], rows }]
        : [{ type: 'markdown' as const, text: 'No deployments recorded yet.' }]),
    ],
  };
}

/** A reply for a request that failed in a way the user should read (shown in place of the tab). */
export function errorReply(message: string): BlocksReply {
  return { hubApi: 0, blocks: [{ type: 'alert', tone: 'negative', text: message }] };
}
