// Test doubles: an in-memory CALM Hub, a Gitea backed by real bare git repositories, and a kubectl whose Flux
// follows the repository's main branch. Patterned on calm-backstage's fakeHub (actions/hub.test.ts) and fakeKubectl
// (actions/gitops.test.ts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { FetchLike } from '@internal/backstage-plugin-calm-common';
import type { AppDeps } from '../app';
import { readSettings, type Settings } from '../config';
import { Gitea } from '../gitea';
import { HubClient } from '../hub';
import type { HubClaims } from '../identity';
import { silentLogger } from '../logger';
import { RouteTable } from '../routes';
import { Jobs, type Render, type Validate } from '../deploy/job';
import { CONTROL_EVALUATION_STANDARD } from '../evaluation';
import { KUBERNETES_DEPLOYMENT_STANDARD } from '../record';
import type { Kubectl } from '../deploy/kube';

const HUB = 'http://hub.test';
const GITEA = 'http://gitea.test';

function reply(status: number, body?: unknown) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}

/** An architecture document: a gateway, the service and one node per extra; relationships service → each extra. */
export function architectureDoc(name: string, version: string, extras: string[]): any {
  return {
    $schema: `${HUB}/calm/namespaces/hackathon/patterns/web-service/versions/1.0.0`,
    $id: `${HUB}/calm/namespaces/hackathon/architectures/${name}/versions/${version}`,
    title: name,
    nodes: [
      { 'unique-id': 'api-gateway', 'node-type': 'system', name: 'gateway', description: '' },
      { 'unique-id': 'web-service', 'node-type': 'service', name: 'service', description: '' },
      ...extras.map(e => ({ 'unique-id': e, 'node-type': 'database', name: e, description: '' })),
    ],
    relationships: extras.map(e => ({
      'unique-id': `web-service-${e}`,
      'relationship-type': { connects: { source: { node: 'web-service' }, destination: { node: e } } },
    })),
  };
}

/**
 * What CALM Hub would refuse in a decorator stamped with the Kubernetes deployment standard (a few of its rules: the
 * required fields, and `data.kubernetes` holding exactly a cluster and a namespace), in its `errors` shape.
 */
export function standardErrors(d: any): { location: string; error: string }[] {
  if (d?.$schema === CONTROL_EVALUATION_STANDARD) return evaluationErrors(d);
  if (d?.$schema !== KUBERNETES_DEPLOYMENT_STANDARD) return [];
  const errors: { location: string; error: string }[] = [];
  if (d.type !== 'deployment') errors.push({ location: '/type', error: 'must be "deployment"' });
  if (!Array.isArray(d['target-type']) || !d['target-type'].length) errors.push({ location: '/target-type', error: 'required' });
  for (const k of ['start-time', 'status']) {
    if (typeof d.data?.[k] !== 'string') errors.push({ location: `/data/${k}`, error: 'required property missing' });
  }
  const kube = d.data?.kubernetes;
  if (typeof kube !== 'object' || kube === null) {
    errors.push({ location: '/data', error: 'required property kubernetes missing' });
  } else {
    for (const k of ['cluster', 'namespace']) {
      if (typeof kube[k] !== 'string' || !kube[k]) errors.push({ location: '/data/kubernetes', error: `required property ${k} missing` });
    }
    for (const k of Object.keys(kube)) {
      if (k !== 'cluster' && k !== 'namespace') errors.push({ location: '/data/kubernetes', error: `property ${k} is not allowed` });
    }
  }
  return errors;
}

const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0;

/**
 * What CALM Hub would refuse in a decorator stamped with the control-evaluation standard: the type, target-type
 * `architecture`, the control's unique-id and requirement-url, the status enum, evaluated-at, and findings (each with
 * a subject and a description) required for `not-met` and refused otherwise.
 */
export function evaluationErrors(d: any): { location: string; error: string }[] {
  const errors: { location: string; error: string }[] = [];
  if (d.type !== 'control-evaluation') errors.push({ location: '/type', error: 'must be "control-evaluation"' });
  const tt = d['target-type'];
  if (!Array.isArray(tt) || !tt.length || tt.some((t: unknown) => t !== 'architecture')) {
    errors.push({ location: '/target-type', error: 'must be ["architecture"]' });
  }
  if (!Array.isArray(d.target) || !d.target.length) errors.push({ location: '/target', error: 'required' });
  const data = d.data ?? {};
  for (const k of ['unique-id', 'requirement-url']) {
    if (!nonEmpty(data.control?.[k])) errors.push({ location: '/data/control', error: `required property ${k} missing` });
  }
  if (!['met', 'not-met', 'not-applicable'].includes(data.status)) errors.push({ location: '/data/status', error: 'not in enum' });
  if (!nonEmpty(data['evaluated-at']) || Number.isNaN(Date.parse(data['evaluated-at']))) {
    errors.push({ location: '/data/evaluated-at', error: 'must be a date-time' });
  }
  if (data.status === 'not-met') {
    if (!Array.isArray(data.findings) || !data.findings.length) {
      errors.push({ location: '/data', error: 'required property findings missing' });
    } else {
      data.findings.forEach((f: any, i: number) => {
        for (const k of ['subject', 'description']) {
          if (!nonEmpty(f?.[k])) errors.push({ location: `/data/findings/${i}`, error: `required property ${k} missing` });
        }
      });
    }
  } else if (data.findings !== undefined) {
    errors.push({ location: '/data/findings', error: 'only allowed when not-met' });
  }
  return errors;
}

const rejection = (errors: { location: string; error: string }[]) =>
  reply(400, { error: 'Decorator does not match its $schema', errors });

export class FakeHub {
  architectures = new Map<string, { numericId: number; versions: Map<string, any> }>();
  decorators = new Map<number, any>();
  puts: { id: number; status: string; notes: string }[] = [];
  /** Makes CALM Hub refuse the n-th PUT (1-based) as not matching its $schema. */
  rejectPut?: (n: number) => boolean;
  private putCount = 0;
  private nextId = 100;

  addArchitecture(name: string, numericId: number, docs: Record<string, any>) {
    this.architectures.set(name, { numericId, versions: new Map(Object.entries(docs)) });
  }

  private camel(id: number, d: any) {
    return {
      id,
      schema: d.$schema,
      uniqueId: d['unique-id'],
      type: d.type,
      target: d.target,
      targetType: d['target-type'],
      appliesTo: d['applies-to'],
      data: d.data,
    };
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const p = u.pathname;
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/calm\/namespaces\/([^/]+)\/architectures$/.exec(p))) {
      if (m[1] !== 'hackathon') return reply(404);
      return reply(200, {
        values: [...this.architectures].map(([customId, a]) => ({
          customId,
          namespace: 'hackathon',
          numericId: a.numericId,
          resourceType: 'ARCHITECTURE',
        })),
      });
    }
    if (method === 'GET' && (m = /^\/calm\/namespaces\/hackathon\/architectures\/([^/]+)\/versions$/.exec(p))) {
      const a = this.architectures.get(decodeURIComponent(m[1]));
      return a ? reply(200, { values: [...a.versions.keys()] }) : reply(404);
    }
    if (method === 'GET' && (m = /^\/calm\/namespaces\/hackathon\/architectures\/([^/]+)\/versions\/([^/]+)$/.exec(p))) {
      const doc = this.architectures.get(decodeURIComponent(m[1]))?.versions.get(decodeURIComponent(m[2]));
      return doc ? reply(200, doc) : reply(404);
    }
    if ((m = /^\/api\/calm\/namespaces\/hackathon\/decorators(?:\/(\d+))?$/.exec(p))) {
      if (method === 'GET' && !m[1]) {
        const target = u.searchParams.get('target');
        const type = u.searchParams.get('type');
        const ids = [...this.decorators]
          .filter(([, d]) => (!target || d.target.includes(target)) && (!type || d.type === type))
          .map(([id]) => id);
        return reply(200, { values: ids });
      }
      if (method === 'GET') {
        const d = this.decorators.get(Number(m[1]));
        return d ? reply(200, this.camel(Number(m[1]), d)) : reply(404);
      }
      if (method === 'POST') {
        const errors = standardErrors(JSON.parse(init.body));
        if (errors.length) return rejection(errors);
        const id = this.nextId++;
        this.decorators.set(id, JSON.parse(init.body));
        return reply(201, { id });
      }
      if (method === 'PUT') {
        const id = Number(m[1]);
        if (!this.decorators.has(id)) return reply(404);
        const d = JSON.parse(init.body);
        const errors = standardErrors(d);
        if (this.rejectPut?.(++this.putCount)) errors.push({ location: '/data/kubernetes', error: 'refused by the test' });
        if (errors.length) return rejection(errors);
        this.decorators.set(id, d);
        this.puts.push({ id, status: d.data.status, notes: d.data.notes });
        return reply(200);
      }
    }
    return reply(404, `fake hub: no route ${method} ${p}`);
  };

  /** The decorator with the highest id, as posted (kebab case). */
  latest(): any {
    return this.decorators.get(Math.max(...this.decorators.keys()));
  }
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();

export interface PullRequest {
  number: number;
  head: string;
  state: 'open' | 'closed';
  merged: boolean;
}

/** Gitea over bare repositories in `root/<org>/<repo>.git`: raw files, folder listings and pull requests. */
export class FakeGitea {
  pulls: PullRequest[] = [];
  /** Merge calls that answer 405 before one succeeds (Gitea does this until it has checked mergeability). */
  merge405s = 0;

  constructor(readonly root: string) {}

  bare(repo: string) {
    return path.join(this.root, 'calm-services', `${repo}.git`);
  }

  head(repo: string, ref = 'main') {
    return sh(this.bare(repo), 'rev-parse', ref);
  }

  show(repo: string, file: string, ref = 'main'): string | undefined {
    try {
      return sh(this.bare(repo), 'show', `${ref}:${file}`);
    } catch {
      return undefined;
    }
  }

  merge(repo: string, number: number) {
    const pr = this.pulls.find(x => x.number === number)!;
    sh(this.bare(repo), 'update-ref', 'refs/heads/main', `refs/heads/${pr.head}`);
    pr.state = 'closed';
    pr.merged = true;
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const p = decodeURIComponent(u.pathname);
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/v1\/repos\/calm-services\/([^/]+)\/raw\/(.+)$/.exec(p))) {
      if (!fs.existsSync(this.bare(m[1]))) return reply(404);
      const text = this.show(m[1], m[2], u.searchParams.get('ref') ?? 'main');
      return text === undefined ? reply(404) : reply(200, text);
    }
    if ((m = /^\/api\/v1\/repos\/calm-services\/([^/]+)\/contents\/(.+)$/.exec(p))) {
      if (!fs.existsSync(this.bare(m[1]))) return reply(404);
      const out = sh(this.bare(m[1]), 'ls-tree', '--name-only', u.searchParams.get('ref') ?? 'main', `${m[2]}/`);
      return reply(
        200,
        out
          .split('\n')
          .filter(Boolean)
          .map(f => ({ type: 'file', name: path.basename(f) })),
      );
    }
    if (method === 'POST' && (m = /^\/api\/v1\/repos\/calm-services\/([^/]+)\/pulls$/.exec(p))) {
      const body = JSON.parse(init.body);
      const pr: PullRequest = { number: this.pulls.length + 1, head: body.head, state: 'open', merged: false };
      this.pulls.push(pr);
      return reply(201, { number: pr.number, html_url: `${GITEA}/calm-services/${m[1]}/pulls/${pr.number}` });
    }
    if (method === 'POST' && (m = /^\/api\/v1\/repos\/calm-services\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(p))) {
      if (this.merge405s > 0) {
        this.merge405s--;
        return reply(405, { message: 'not mergeable yet' });
      }
      this.merge(m[1], Number(m[2]));
      return reply(200);
    }
    if (method === 'GET' && (m = /^\/api\/v1\/repos\/calm-services\/([^/]+)\/pulls\/(\d+)$/.exec(p))) {
      const pr = this.pulls.find(x => x.number === Number(m![2]));
      if (!pr) return reply(404);
      return reply(200, {
        number: pr.number,
        html_url: `${GITEA}/calm-services/${m[1]}/pulls/${pr.number}`,
        state: pr.state,
        merged: pr.merged,
      });
    }
    return reply(404, `fake gitea: no route ${method} ${p}`);
  };
}

/** Kubernetes manifests the fake renderer writes: a labelled Deployment and one NetworkPolicy per relationship. */
export function manifestsFor(doc: any): Record<string, string> {
  const rels: any[] = doc.relationships ?? [];
  return {
    'deploy/k8s/kustomization.yaml': YAML.stringify({ resources: ['workloads.yaml', 'network-policy.yaml'] }),
    'deploy/k8s/workloads.yaml': YAML.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web-service', labels: { 'calm.finos.org/node': 'web-service' } },
    }),
    'deploy/k8s/network-policy.yaml': rels.length
      ? rels
          .map(r =>
            YAML.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: r['unique-id'] } }),
          )
          .join('---\n')
      : '# none\n',
  };
}

export const fakeRender: Render = async ({ architecturePath, dir }) => {
  const doc = JSON.parse(fs.readFileSync(architecturePath, 'utf-8'));
  const files = manifestsFor(doc);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'rendered', f)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rendered', f), text);
  }
  return Object.keys(files);
};

export function fakeValidate(errors: string[] = []): Validate {
  return async () => ({
    hasErrors: errors.length > 0,
    hasWarnings: false,
    errors: errors.map(message => ({ severity: 'error', message })),
    warnings: [],
    report: {},
  });
}

/** kubectl whose Flux has applied whatever `main` of the service repository points at. */
export function fakeKubectl(gitea: FakeGitea, opts: { fluxReady?: boolean; noKustomization?: boolean } = {}) {
  const calls: string[] = [];
  const kubectl: Kubectl = async args => {
    const line = args.join(' ');
    calls.push(line);
    if (line.includes('get kustomization')) {
      if (opts.noKustomization) return '';
      const svc = args[args.indexOf('kustomization') + 1].replace(/^calm-/, '');
      const sha = gitea.head(svc);
      const ready = opts.fluxReady ?? true;
      return JSON.stringify({
        status: {
          conditions: [{ type: 'Ready', status: ready ? 'True' : 'False', message: ready ? `Applied revision: main@sha1:${sha}` : 'kustomize build failed' }],
          lastAppliedRevision: `main@sha1:${sha}`,
        },
      });
    }
    if (line.includes('get deployments')) return JSON.stringify({ items: [{ metadata: { name: 'web-service' } }] });
    return '';
  };
  return { kubectl, calls };
}

export interface World {
  root: string;
  settings: Settings;
  hub: FakeHub;
  gitea: FakeGitea;
  deps: AppDeps;
  kubectlCalls: string[];
  claims: Pick<HubClaims, 'sub' | 'jti' | 'ns'>;
}

/**
 * A service `events-stream` made from a pattern, in Git and deployed at architecture 1.0.0 (two extras), with
 * version 1.0.1 (one extra fewer) in CALM Hub but not deployed.
 */
export function world(opts: { approval?: 'auto' | 'manual'; validateErrors?: string[]; fluxReady?: boolean } = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-connector-test-'));
  const settings = readSettings(
    {
      GITEA_URL: `file://${root}`,
      CALM_HUB_URL: HUB,
      WORK_DIR: path.join(root, 'work'),
      APPROVAL: opts.approval ?? 'auto',
      APPROVAL_TIMEOUT_SECONDS: '60',
      FLUX_TIMEOUT_SECONDS: '60',
    },
    path.resolve(__dirname, '../..'),
  );
  const hub = new FakeHub();
  const v100 = architectureDoc('events-stream', '1.0.0', ['database', 'cache']);
  const v101 = architectureDoc('events-stream', '1.0.1', ['database']);
  hub.addArchitecture('events-stream', 38, { '1.0.0': v100, '1.0.1': v101 });
  hub.addArchitecture('no-repo', 39, { '1.0.0': architectureDoc('no-repo', '1.0.0', []) });

  // The service repository, as calm-backstage leaves it after creating and deploying it.
  const gitea = new FakeGitea(root);
  const bare = gitea.bare('events-stream');
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  const files: Record<string, string> = {
    ...manifestsFor(v100),
    'catalog-info.yaml': YAML.stringify({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'events-stream',
        annotations: {
          'calm.finos.org/namespace': 'hackathon',
          'calm.finos.org/architecture': 'events-stream',
          'calm.finos.org/architecture-version': '1.0.0',
          'calm.finos.org/deploy-bundle': 'k8s-deploy',
          'calm.finos.org/deploy-bundle-version': '1.2.1',
          'calm.finos.org/gitops': 'flux-system/calm-events-stream',
          'backstage.io/kubernetes-namespace': 'calm-events-stream',
        },
        links: [{ url: `${HUB}/calm/namespaces/hackathon/architectures/events-stream/versions/1.0.0`, title: 'Architecture' }],
      },
      spec: { type: 'service', lifecycle: 'experimental', owner: 'guests' },
    }),
    'deploy/k8s-overlay/kustomization.yaml': YAML.stringify({
      resources: ['namespace.yaml', '../k8s'],
      images: [{ name: 'calm-service', newName: 'events-stream', newTag: 'abc123' }],
    }),
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
    fs.writeFileSync(path.join(seed, f), text);
  }
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'Create events-stream');
  sh(seed, 'push', '-q', bare, 'main');

  const { kubectl, calls } = fakeKubectl(gitea, { fluxReady: opts.fluxReady });
  const deps: AppDeps = {
    settings,
    logger: silentLogger,
    hub: new HubClient(HUB, hub.fetch),
    gitea: new Gitea(GITEA, settings.gitops.auth, gitea.fetch),
    kubectl,
    jobs: new Jobs(),
    routes: RouteTable.fromManifest(settings.manifestPath),
    verify: async (_t, req) =>
      ({ sub: 'alice', jti: 'aaaa1111-2222', ns: 'hackathon', iss: '', aud: '', iat: 0, exp: 0, htm: req.method, htp: req.pathAndQuery }) as any,
    render: fakeRender,
    validate: fakeValidate(opts.validateErrors),
    sleep: async () => {},
    approvalPollMs: 1,
    fluxPollMs: 1,
  };
  return { root, settings, hub, gitea, deps, kubectlCalls: calls, claims: { sub: 'alice', jti: 'aaaa1111-2222', ns: 'hackathon' } };
}
