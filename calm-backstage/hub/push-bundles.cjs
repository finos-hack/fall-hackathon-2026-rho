#!/usr/bin/env node
/*
 * Publishes template bundles to the OCI registry (hub/docker-compose.yml, http://localhost:5050) as
 * <registry>/<prefix>/<name>:<version>, from the Gitea repository that holds their sources.
 *
 *   node hub/push-bundles.cjs              mirror bundles/ into calm-templates/bundles (one commit when anything
 *                                           changed), then publish every <name>/<version> from that commit
 *   node hub/push-bundles.cjs --from-git   publish what is on Gitea's main (after editing a bundle there)
 *
 * Each published bundle carries org.opencontainers.image.source (its folder in Gitea at the commit),
 * org.opencontainers.image.revision (the commit), org.opencontainers.image.created and calm.finos.org/bundle-kind.
 *
 * A published version never changes: a version whose content is already in the registry is skipped (its manifest,
 * and so its digest, stay as they are), and a version whose content differs is refused: give it a new version.
 * The mirror commits use a fixed author and date, so the same bundles/ tree on an empty Gitea gives the same commit.
 *
 * When Gitea does not answer, the bundles are published from bundles/ without source annotations, with a warning.
 *
 * Environment: CALM_BUNDLE_REGISTRY (default http://localhost:5050), CALM_BUNDLE_PREFIX (calm-bundles),
 * CALM_GITEA_URL (http://localhost:3300), CALM_GITEA_USER / CALM_GITEA_PASSWORD (calm / calm-local-dev),
 * CALM_TEMPLATES_REPO (calm-templates/bundles). They match calm.bundleRegistry and calm.gitops in app-config.yaml.
 *
 * The OCI client is the calm-node package's TypeScript source: Node strips its types on load (Node 22.18 or later).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundleRef, pushBundle } = require('../plugins/calm-node/src/oci.ts');

const REGISTRY = process.env.CALM_BUNDLE_REGISTRY || 'http://localhost:5050';
const PREFIX = process.env.CALM_BUNDLE_PREFIX || 'calm-bundles';
const GITEA = (process.env.CALM_GITEA_URL || 'http://localhost:3300').replace(/\/+$/, '');
const GITEA_USER = process.env.CALM_GITEA_USER || 'calm';
const GITEA_PASSWORD = process.env.CALM_GITEA_PASSWORD || 'calm-local-dev';
const TEMPLATES_REPO = process.env.CALM_TEMPLATES_REPO || 'calm-templates/bundles';
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = 'calm-backstage.json';
const FIXED_DATE = '2026-11-14T00:00:00Z';
const AUTHOR = { name: 'CALM Backstage', email: 'calm-backstage@localhost' };

function git(cwd, args, { auth = false, date } = {}) {
  const config = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'commit.gpgsign=false'];
  if (auth) {
    const basic = Buffer.from(`${GITEA_USER}:${GITEA_PASSWORD}`).toString('base64');
    config.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
  }
  return execFileSync('git', [...config, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  }).trim();
}

async function waitFor(url, what, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return false;
}

/** Every <name>/<version> folder under root that has a calm-backstage.json, sorted. */
function bundleDirs(root) {
  const out = [];
  const folders = dir =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => path.join(dir, e.name))
      .sort();
  for (const nameDir of folders(root)) {
    for (const versionDir of folders(nameDir)) {
      if (fs.existsSync(path.join(versionDir, CONFIG_FILE))) {
        out.push(versionDir);
      }
    }
  }
  return out;
}

/** Clones the templates repository (or starts an empty one) into a temp folder; returns its path. */
function checkout(tmp) {
  const dir = path.join(tmp, 'bundles');
  const url = `${GITEA}/${TEMPLATES_REPO}.git`;
  try {
    git(tmp, ['clone', '-q', '-b', 'main', url, 'bundles']);
  } catch {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
  }
  return dir;
}

/** Replaces the checkout's tree with bundles/ and commits when anything changed. Returns the commit to publish. */
function mirror(dir) {
  for (const e of fs.readdirSync(dir)) {
    if (e !== '.git') {
      fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    }
  }
  fs.cpSync(path.join(ROOT, 'bundles'), dir, {
    recursive: true,
    filter: src => path.basename(src) !== '.DS_Store',
  });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    [
      '# CALM template bundles',
      '',
      'The sources of the template bundles Backstage offers: starters (the code a service begins with),',
      'deployment rules (how any service runs) and the older full bundles. One folder per `<name>/<version>`;',
      "each has a `calm-backstage.json` that says its kind and the CALM patterns it fits.",
      '',
      'Change a bundle by adding a new version folder (a published version never changes), then publish it:',
      '`node hub/push-bundles.cjs --from-git` in calm-backstage.',
      '',
    ].join('\n'),
  );
  git(dir, ['add', '-A']);
  if (git(dir, ['status', '--porcelain'])) {
    git(dir, ['commit', '-q', '-m', 'Sync bundles from calm-backstage'], { date: FIXED_DATE });
    git(dir, ['push', '-q', `${GITEA}/${TEMPLATES_REPO}.git`, 'main:main'], { auth: true });
    console.log(`commit   ${TEMPLATES_REPO} ${git(dir, ['rev-parse', 'HEAD'])}`);
  } else {
    console.log(`same     ${TEMPLATES_REPO} ${git(dir, ['rev-parse', 'HEAD'])}`);
  }
  return git(dir, ['rev-parse', 'HEAD']);
}

async function publish(dirs, root, revision) {
  let pushed = 0;
  let skipped = 0;
  for (const dir of dirs) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));
    if (typeof meta.name !== 'string' || typeof meta.version !== 'string') {
      throw new Error(`${path.join(dir, CONFIG_FILE)} needs a name and a version`);
    }
    const rel = path.relative(root, dir).split(path.sep).join('/');
    const annotations = {
      'org.opencontainers.image.created': new Date().toISOString(),
      'calm.finos.org/bundle-kind': typeof meta.kind === 'string' ? meta.kind : 'full',
      ...(revision
        ? {
            'org.opencontainers.image.source': `${GITEA}/${TEMPLATES_REPO}/src/commit/${revision}/${rel}`,
            'org.opencontainers.image.revision': revision,
          }
        : {}),
    };
    const ref = bundleRef(REGISTRY, PREFIX, meta.name, meta.version);
    const r = await pushBundle({ dir, ref, annotations, immutable: true });
    if (r.skipped) {
      skipped++;
      console.log(`same     ${r.ref}  ${r.digest}`);
    } else {
      pushed++;
      console.log(`pushed   ${r.ref}  ${r.digest}`);
    }
  }
  console.log(`bundles: ${pushed} published, ${skipped} already there (${REGISTRY})`);
}

async function main() {
  const args = process.argv.slice(2);
  const fromGit = args.includes('--from-git');
  if (args.some(a => a !== '--from-git')) {
    console.error('usage: node hub/push-bundles.cjs [--from-git]');
    process.exit(2);
  }
  if (!(await waitFor(`${REGISTRY.replace(/\/+$/, '')}/v2/`, 'registry'))) {
    throw new Error(`bundle registry not reachable at ${REGISTRY} (start it with: yarn hub:up)`);
  }
  if (!(await waitFor(`${GITEA}/api/healthz`, 'gitea', fromGit ? 30 : 5))) {
    if (fromGit) {
      throw new Error(`Gitea not reachable at ${GITEA} (start it with: yarn hub:up)`);
    }
    console.warn(`bundles: Gitea not reachable at ${GITEA}; publishing from bundles/ without source annotations`);
    await publish(bundleDirs(path.join(ROOT, 'bundles')), path.join(ROOT, 'bundles'), undefined);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-bundles-'));
  try {
    const dir = checkout(tmp);
    const revision = fromGit ? git(dir, ['rev-parse', 'HEAD']) : mirror(dir);
    await publish(bundleDirs(dir), dir, revision);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(`bundles: ${e.message ?? e}`);
  process.exit(1);
});
