#!/usr/bin/env node
/*
 * Pushes template bundles to the OCI registry (hub/docker-compose.yml, http://localhost:5050) as
 * <registry>/<prefix>/<name>:<version>.
 *
 *   node hub/push-bundles.cjs            every bundles/<name>/<version> that has a calm-backstage.json
 *   node hub/push-bundles.cjs <folder>   that one bundle
 *
 * Name and version come from the bundle's calm-backstage.json. Idempotent: the same folder content gives the same
 * digest, and blobs the registry already has are not uploaded again. Prints each reference and manifest digest.
 *
 * CALM_BUNDLE_REGISTRY (default http://localhost:5050) and CALM_BUNDLE_PREFIX (default calm-bundles) match
 * calm.bundleRegistry in app-config.yaml.
 *
 * The client is the calm-node package's TypeScript source: Node strips its types on load (Node 22.18 or later).
 */
const fs = require('node:fs');
const path = require('node:path');
const { bundleRef, pushBundle } = require('../plugins/calm-node/src/oci.ts');

const REGISTRY = process.env.CALM_BUNDLE_REGISTRY || 'http://localhost:5050';
const PREFIX = process.env.CALM_BUNDLE_PREFIX || 'calm-bundles';
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = 'calm-backstage.json';

async function waitForRegistry() {
  const url = `${REGISTRY.replace(/\/+$/, '')}/v2/`;
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(
    `bundle registry not reachable at ${url} (start it with: yarn hub:up)`,
  );
}

/** Every bundles/<name>/<version> folder that has a calm-backstage.json, sorted. */
function allBundles() {
  const out = [];
  const root = path.join(ROOT, 'bundles');
  const folders = dir =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0] === '-h' || args[0] === '--help') {
    console.error('usage: node hub/push-bundles.cjs [<bundle folder>]');
    process.exit(2);
  }
  const dirs = args.length ? [path.resolve(args[0])] : allBundles();
  if (!dirs.length) {
    throw new Error(`no bundles with a ${CONFIG_FILE} under ${ROOT}/bundles`);
  }
  await waitForRegistry();
  for (const dir of dirs) {
    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'),
    );
    if (typeof meta.name !== 'string' || typeof meta.version !== 'string') {
      throw new Error(
        `${path.join(dir, CONFIG_FILE)} needs a name and a version`,
      );
    }
    const ref = bundleRef(REGISTRY, PREFIX, meta.name, meta.version);
    const pushed = await pushBundle({ dir, ref });
    console.log(`pushed   ${pushed.ref}  ${pushed.digest}`);
  }
  console.log(`bundles: ${dirs.length} pushed to ${REGISTRY}`);
}

main().catch(e => {
  console.error(`bundles: ${e.message ?? e}`);
  process.exit(1);
});
