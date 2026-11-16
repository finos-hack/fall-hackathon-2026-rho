import { allPodsPolicies, hubRecords, inSync, policiesNaming, type DriftReason, type HubRecord, type Platform, type PlatformView } from './platform';
import type { ServiceRow } from './services';
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

const http = (u?: string) => (u && /^https?:\/\//.test(u) ? u : undefined);
const short = (sha?: string) => (sha ? sha.slice(0, 12) : 'none');

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

const fluxText = (p: Platform) =>
  p.flux.ready === undefined ? p.flux.message ?? 'unknown' : p.flux.ready ? 'Ready' : `Not ready: ${p.flux.message ?? ''}`;

const deployingAlert = (d: NonNullable<Platform['deploying']>): Block => ({
  type: 'alert',
  tone: 'info',
  text: `Deploying ${d.version ?? 'a version'} (${d.status})${d.notes ? `: ${d.notes}` : ''}`,
});

/** A drift alert: negative when Flux is not ready, a warning otherwise. */
const driftAlert = (p: Platform, reasons: DriftReason[]): Block => ({
  type: 'alert',
  tone: p.flux.ready === false ? 'negative' : 'warning',
  text: `Drift: ${reasons.map(r => r.text).join('; ')}`,
});

/** The headline: deploying, else drift, else whether the version on screen is the one running. */
function headline(p: Platform, version?: string): Block {
  if (p.deploying) return deployingAlert(p.deploying);
  if (p.drift.length) return driftAlert(p, p.drift.slice(0, 1));
  if (p.problems.length) return { type: 'alert', tone: 'warning', text: p.problems[0] };
  if (!version || !p.version) {
    return { type: 'alert', tone: 'info', text: `${p.environment} runs ${p.version ?? 'no recorded version'}.` };
  }
  if (version === p.version) {
    return { type: 'alert', tone: 'positive', text: `This version (${version}) is the one running in ${p.environment}.` };
  }
  return {
    type: 'alert',
    tone: 'warning',
    text: `${p.environment} runs ${p.version}; this page shows ${version}. Use "Deploy this version" to deploy it.`,
  };
}

/** CALM Hub's newest deployment record and whether its newest completed one matches what runs. */
export function recordLine(p: Platform): string {
  const r = p.record;
  if (!r) return 'none';
  const c = p.completed;
  const verdict = c?.version && p.version ? (c.version === p.version ? 'matches the platform' : `drift: the platform runs ${p.version}`) : undefined;
  const head = `${r.version ?? 'unknown version'} ${r.status}`;
  if (r.status === 'completed') return verdict ? `${head} — ${verdict}` : head;
  return c ? `${head}; newest completed ${c.version ?? 'unknown version'}${verdict ? ` — ${verdict}` : ''}` : head;
}

const notManaged = (s: Status): Block => ({ type: 'alert', tone: 'info', text: `Not deployed through GitOps. ${s.reason ?? ''}`.trim() });

/** The designer tab for an architecture version: what runs, and whether it matches Git and CALM Hub's record. */
export function tabReply(view: PlatformView, version?: string): BlocksReply {
  const { status: s, platform: p } = view;
  if (!s.managed || !p) {
    return {
      hubApi: 0,
      blocks: [
        notManaged(s),
        {
          type: 'markdown',
          text: 'This extension deploys services created from a CALM pattern with a starter and deployment rules (calm-backstage), which live in Git and are applied by Flux.',
        },
      ],
    };
  }
  const items = [
    { label: 'Environment', value: p.environment },
    { label: 'Running version', value: p.version ?? 'unknown' },
    { label: 'This version', value: version ?? 'unknown' },
    { label: 'Flux', value: fluxText(p) },
    { label: 'Commit applied', value: short(p.flux.commit) },
    { label: "CALM Hub's record", value: recordLine(p) },
    ...(p.pendingApproval ? [{ label: 'Pending approval', value: `pull request #${p.pendingApproval.number}` }] : []),
  ];
  const links: Link[] = [
    ...(http(s.repository) ? [{ label: 'Service repository', href: s.repository! }] : []),
    ...(http(s.commitUrl) ? [{ label: `Commit ${short(s.commit)}`, href: s.commitUrl! }] : []),
    ...(p.pendingApproval && http(p.pendingApproval.url)
      ? [{ label: `Pending pull request #${p.pendingApproval.number}`, href: p.pendingApproval.url }]
      : []),
  ];
  return {
    hubApi: 0,
    blocks: [
      headline(p, version),
      { type: 'keyValue', items },
      ...(links.length ? [{ type: 'links' as const, items: links }] : []),
      { type: 'markdown', text: 'Deployment history: the Deployments view on the diagram (View all).' },
    ],
  };
}

const listOr = (names: string[], none = 'none') => (names.length ? names.join('; ') : none);

/** The detail panel for one node (or relationship) of the diagram: what the platform runs for it. */
export function nodeReply(view: PlatformView, node: string): BlocksReply {
  const { status: s, platform: p } = view;
  if (!s.managed || !p) return { hubApi: 0, blocks: [notManaged(s)] };
  const workloads = p.workloads.filter(w => w.node === node);
  // Deployments Git asks for that the cluster read did not return (deleted, or the cluster could not be read).
  const absent = (view.service?.deployments ?? []).filter(d => d.node === node && !workloads.some(w => w.name === d.name));
  if (!workloads.length && !absent.length) {
    const named = policiesNaming(p, node);
    return {
      hubApi: 0,
      blocks: [
        { type: 'alert', tone: 'info', text: 'Not run by the platform' },
        ...(named.length
          ? [
              {
                type: 'keyValue' as const,
                items: named.map(x => ({
                  label: x.name,
                  value: `${[x.ingress && 'Ingress', x.egress && 'Egress'].filter(Boolean).join(' and ')} of ${
                    x.allPods ? 'all pods' : x.node ?? 'selected pods'
                  }: ${x.peers}`,
                })),
              },
            ]
          : []),
      ],
    };
  }
  const names = new Set([...workloads, ...absent].map(w => w.name));
  const reasons = p.drift.filter(d => !d.workload || names.has(d.workload));
  const alert: Block = p.deploying
    ? deployingAlert(p.deploying)
    : reasons.length
      ? driftAlert(p, reasons)
      : p.problems.length
        ? { type: 'alert', tone: 'warning', text: p.problems[0] }
        : absent.length
          ? { type: 'alert', tone: 'warning', text: `Git asks the platform to run ${node}, but the cluster does not` }
          : { type: 'alert', tone: 'positive', text: `In sync: ${node} runs as Git asks.` };
  const mine = p.policies.filter(x => x.node === node);
  const policy = (x: { name: string; peers: string }) => `${x.name} (${x.peers})`;
  const records = hubRecords(view.history).filter(r => r.appliesTo?.includes(node));
  const record = records[0];
  const completed = record && record.status !== 'completed' ? records.find(r => r.status === 'completed') : undefined;
  const at = (r: HubRecord) => `${r.version ?? 'unknown version'} ${r.status} at ${when(r.endTime ?? r.startTime)}`;
  return {
    hubApi: 0,
    blocks: [
      alert,
      ...workloads.map(w => ({
        type: 'keyValue' as const,
        items: [
          { label: 'Workload', value: w.name },
          {
            label: 'Replicas ready',
            value: `${w.ready}/${w.desired ?? w.replicas}${w.desired !== undefined && w.desired !== w.replicas ? ` (the cluster asks for ${w.replicas})` : ''}`,
          },
          { label: 'Image', value: w.images.join(', ') || 'none' },
          { label: 'Last change', value: p.flux.commit ? `commit ${short(p.flux.commit)}` : 'unknown' },
        ],
      })),
      ...absent.map(d => {
        const missing = p.missing.includes(d.name);
        return {
          type: 'keyValue' as const,
          items: [
            { label: 'Workload', value: d.name },
            { label: 'Replicas ready', value: missing ? `0/${d.replicas} (not in the cluster)` : `unknown/${d.replicas} (cannot read the cluster)` },
            { label: 'Image', value: missing ? 'none' : 'unknown' },
            { label: 'Last change', value: p.flux.commit ? `commit ${short(p.flux.commit)}` : 'unknown' },
          ],
        };
      }),
      {
        type: 'keyValue',
        items: [
          { label: 'Ingress allowed by', value: listOr(mine.filter(x => x.ingress).map(policy)) },
          { label: 'Egress allowed by', value: listOr(mine.filter(x => x.egress).map(policy)) },
          { label: 'Applies to all pods', value: allPodsPolicies(p).map(x => x.name).join(', ') || 'none' },
        ],
      },
      {
        type: 'keyValue',
        items: [
          {
            label: "CALM Hub's record",
            value: record
              ? `${at(record)}${completed ? `; newest completed ${completed.version ?? 'unknown version'} at ${when(completed.endTime ?? completed.startTime)}` : ''}`
              : 'none',
          },
        ],
      },
    ],
  };
}

/** Counts of the services, in sync and drifted. */
function serviceStats(rows: ServiceRow[]): Block {
  const platforms = rows.map(r => r.view?.platform);
  return {
    type: 'stats',
    items: [
      { label: 'Services', value: String(rows.length) },
      { label: 'In sync', value: String(platforms.filter(p => p && inSync(p)).length) },
      { label: 'Drifted', value: String(platforms.filter(p => p && !p.deploying && p.drift.length).length) },
    ],
  };
}

/** The landing card: the counts and, when a service drifted, the first one's first reason. */
export function cardReply(rows: ServiceRow[]): BlocksReply {
  const drifted = rows.find(r => r.view?.platform && !r.view.platform.deploying && r.view.platform.drift.length);
  return {
    hubApi: 0,
    blocks: [
      serviceStats(rows),
      ...(drifted
        ? [{ type: 'alert' as const, tone: 'warning' as const, text: `${drifted.architecture}: ${drifted.view!.platform!.drift[0].text}` }]
        : []),
    ],
  };
}

function driftCell(r: ServiceRow): Cell {
  const p = r.view?.platform;
  if (!p) return r.error ?? r.view?.status.reason ?? 'unknown';
  if (p.deploying) return { badge: 'deploying', tone: 'info' };
  if (p.drift.length) return p.drift.map(d => d.text).join('; ');
  if (p.problems.length) return p.problems.join('; ');
  return { badge: 'in sync', tone: 'positive' };
}

/** The extension's screen: the counts and a row per service. */
export function screenReply(rows: ServiceRow[], settings: { servicesOrg: string; namespaces: string[] }): BlocksReply {
  const table: Cell[][] = rows.map(r => {
    const p = r.view?.platform;
    const version = p?.version;
    return [
      version ? { label: r.architecture, hub: { namespace: r.namespace, type: 'architectures', id: r.architecture, version } } : r.architecture,
      version ?? 'unknown',
      p ? fluxText(p) : 'unknown',
      driftCell(r),
    ];
  });
  return {
    hubApi: 0,
    title: 'Services',
    blocks: [
      serviceStats(rows),
      table.length
        ? { type: 'table', columns: ['Service', 'Running version', 'Flux', 'Drift'], rows: table }
        : {
            type: 'markdown',
            text: `No repository in ${settings.servicesOrg} names an architecture in ${settings.namespaces.join(', ')}.`,
          },
    ],
  };
}

/** A reply for a request that failed in a way the user should read (shown in place of the tab). */
export function errorReply(message: string): BlocksReply {
  return { hubApi: 0, blocks: [{ type: 'alert', tone: 'negative', text: message }] };
}
