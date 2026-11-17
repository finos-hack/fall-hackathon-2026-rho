// Publishes the GitOps deployment decorator standard (standards/gitops.decorator.standard.json) to CALM Hub as the
// standard `gitops-deployment`, once: when the namespace already has a standard of that name it says so and stops.
//
//   npx tsx scripts/publish-standard.ts [namespace]      # default hackathon
//
// Environment: CALM_HUB_URL (default http://localhost:8090).
import fs from 'node:fs/promises';
import path from 'node:path';

const NAME = 'gitops-deployment';
const DESCRIPTION =
  'GitOps deployment decorator: the Kubernetes deployment standard plus data.gitops (connector, environment, repository, pull request, commit, requester, CALM Hub audit id, architecture version).';

async function main() {
  const namespace = process.argv[2] ?? 'hackathon';
  const hub = (process.env.CALM_HUB_URL ?? 'http://localhost:8090').replace(/\/+$/, '');
  const url = `${hub}/api/calm/namespaces/${encodeURIComponent(namespace)}/standards`;
  const standardJson = await fs.readFile(path.resolve(__dirname, '../standards/gitops.decorator.standard.json'), 'utf-8');

  const listed = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!listed.ok) throw new Error(`GET ${url} -> ${listed.status}: ${(await listed.text()).slice(0, 300)}`);
  const values: unknown[] = ((await listed.json()) as { values?: unknown[] }).values ?? [];
  const existing = values.find(v => v === NAME || (typeof v === 'object' && v !== null && (v as any).name === NAME));
  if (existing !== undefined) {
    console.log(`${namespace} already has the standard ${NAME}: ${JSON.stringify(existing)}`);
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, description: DESCRIPTION, standardJson }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  const location = res.headers.get('location');
  console.log(`Published ${NAME} to ${namespace} (${res.status})${location ? ` at ${location}` : ''}${text ? `: ${text}` : ''}`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
