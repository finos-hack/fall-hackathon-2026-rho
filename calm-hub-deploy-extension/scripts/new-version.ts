// Stores the next patch version of an architecture in CALM Hub, changed the way an architect would change it.
//
//   npx tsx scripts/new-version.ts <namespace> <architecture> --choose "<decision>=<choice>" [--dry-run]
//       Re-generates the architecture from its pattern with that decision changed (the other decisions stay as they
//       are) and keeps every value the current version fills in. Valid against the pattern by construction.
//       e.g. --choose "broker-storage=SQLite on the broker’s volume"
//
//   npx tsx scripts/new-version.ts <namespace> <architecture> --connect <source>:<destination>
//       Adds a direct connection the pattern does not allow, e.g. --connect stream-app:nisshi-broker-db. Use it to
//       show the controls gate: the deployment of that version fails validation and nothing reaches Git.
//
//   npx tsx scripts/new-version.ts <namespace> <architecture> --no-pattern
//       The same architecture, with a $schema that names no pattern (CALM's meta schema). The controls gate cannot
//       validate it, so deploying it is refused too (it fails closed) and nothing reaches Git.
//
// Environment: CALM_HUB_URL (default http://localhost:8090).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, nextPatchVersion, parsePatternUrl } from '@internal/backstage-plugin-calm-common';
import { generateArchitecture, validateArchitecture } from '@internal/backstage-plugin-calm-node';
import { HubClient } from '../src/hub';
import { createLogger } from '../src/logger';

/** CALM's own meta schema: a valid $schema for an architecture, but no pattern to validate it against. */
const META_SCHEMA = 'https://calm.finos.org/release/1.1/meta/calm.json';

const PLACEHOLDER = /\[\[[^\]]+\]\]|"-1"|:-1\b/;

function usage(): never {
  console.error('usage: new-version.ts <namespace> <architecture> (--choose "<decision>=<choice>" | --connect <source>:<destination> | --no-pattern)');
  process.exit(2);
}

/** The choice each `options` relationship records now: decision id → choice description. */
function currentChoices(doc: any): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const r of doc.relationships ?? []) {
    const options = r?.['relationship-type']?.options;
    if (Array.isArray(options) && options.length) {
      out[r['unique-id']] = options.length === 1 ? options[0].description : options.map((o: any) => o.description);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [namespace, name, flag, value] = args.filter(a => a !== '--dry-run');
  if (!namespace || !name || !flag || (!value && flag !== '--no-pattern')) usage();
  const hubUrl = (process.env.CALM_HUB_URL ?? 'http://localhost:8090').replace(/\/+$/, '');
  const hub = new HubClient(hubUrl);
  const logger = createLogger('new-version', 'warn');
  const versions = (await hub.architectureVersions(namespace, name)).sort(compareVersions);
  if (!versions.length) throw new Error(`No architecture ${namespace}/${name}`);
  const latest = versions[versions.length - 1];
  const next = nextPatchVersion(latest);
  // The version to change: the newest that names its pattern. A version stored with --no-pattern has none to
  // re-generate from or validate against, so it is skipped (the new version is still numbered after the latest).
  let current: any;
  for (const v of [...versions].reverse()) {
    const doc: any = await hub.architecture(namespace, name, v);
    if (parsePatternUrl(doc?.$schema)) {
      current = doc;
      break;
    }
  }
  if (!current) throw new Error(`No version of ${namespace}/${name} names a pattern`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'new-version-'));
  let doc: any;
  let summary: string;

  if (flag === '--choose') {
    const eq = value.indexOf('=');
    if (eq <= 0) usage();
    const decision = value.slice(0, eq);
    const choice = value.slice(eq + 1);
    const choices = { ...currentChoices(current), [decision]: choice };
    const generated = await generateArchitecture({ patternUrl: current.$schema, hubUrl, choices, dir: tmp, logger });
    // Keep the values the versions so far fill in (the newest version that has a node or relationship wins), so a
    // choice made before and undone comes back with its old values; take anything new as generated.
    const nodes = new Map<string, any>();
    const rels = new Map<string, any>();
    for (const v of [...versions].reverse()) {
      const doc: any = await hub.architecture(namespace, name, v);
      for (const n of doc.nodes ?? []) if (!nodes.has(n['unique-id'])) nodes.set(n['unique-id'], n);
      for (const r of doc.relationships ?? []) if (!rels.has(r['unique-id'])) rels.set(r['unique-id'], r);
    }
    doc = {
      ...generated.architecture,
      nodes: generated.architecture.nodes.map((n: any) => nodes.get(n['unique-id']) ?? n),
      relationships: generated.architecture.relationships.map((r: any) =>
        r['relationship-type']?.options ? r : rels.get(r['unique-id']) ?? r,
      ),
    };
    summary = `${decision}: ${JSON.stringify(currentChoices(current)[decision])} → ${JSON.stringify(choice)}`;
  } else if (flag === '--connect') {
    const [source, destination] = value.split(':');
    if (!source || !destination) usage();
    doc = structuredClone(current);
    doc.relationships.push({
      'unique-id': `${source}-${destination}`,
      description: `A direct connection from ${source} to ${destination}`,
      protocol: 'TCP',
      'relationship-type': { connects: { source: { node: source }, destination: { node: destination } } },
    });
    summary = `adds a direct connection ${source} → ${destination}`;
  } else if (flag === '--no-pattern') {
    doc = { ...structuredClone(current), $schema: META_SCHEMA };
    summary = `names no pattern ($schema ${META_SCHEMA})`;
  } else {
    usage();
  }

  // Title, metadata (calm-backstage's ownership marker) and the $id of the new version.
  doc = { ...doc, title: current.title, ...(current.metadata ? { metadata: current.metadata } : {}) };
  delete doc.$id;
  doc.$id = `${hubUrl}/calm/namespaces/${namespace}/architectures/${name}/versions/${next}`;
  const text = JSON.stringify(doc, null, 2);
  if (PLACEHOLDER.test(text)) throw new Error(`The new version still has placeholders: ${text.match(PLACEHOLDER)![0]}`);

  const architecturePath = path.join(tmp, 'architecture.json');
  await fs.writeFile(architecturePath, text);
  // With no pattern there is nothing to validate against: that is what the controls gate refuses.
  const check = flag === '--no-pattern' ? undefined : await validateArchitecture({
    patternUrl: doc.$schema,
    architecturePath,
    hubUrl,
    dir: tmp,
    outputPath: path.join(tmp, 'validation.json'),
    logger,
  });
  if (dryRun) {
    console.log(`Would store ${namespace}/${name} ${next} (${summary}); --dry-run, nothing stored`);
  } else {
    const url = await hub.createArchitectureVersion(namespace, name, next, doc);
    console.log(`Stored ${namespace}/${name} ${next} (${summary})`);
    console.log(`  ${url}`);
  }
  console.log(
    !check
      ? '  calm validate: no pattern to validate against. Deploying it will stop at the controls gate.'
      : check.hasErrors
      ? `  calm validate: ${check.errors.length} error(s), e.g. ${check.errors[0].message}. Deploying it will stop at the controls gate.`
      : '  calm validate: no errors',
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

main().catch(e => {
  console.error(e.message ?? e);
  process.exit(1);
});
