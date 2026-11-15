#!/usr/bin/env node
/*
 * Prints the Flux install manifest for the local cluster, with only the two controllers calm-backstage uses:
 * source-controller (clones the service repositories from the local Gitea) and kustomize-controller (applies their
 * deploy/k8s-overlay). The helm, notification, image and source-watcher controllers and their Services are left out;
 * every CRD is kept, so the manifest applies cleanly. The kept controllers get no --events-addr (nothing to send to).
 * kustomize-controller gets --default-service-account=default: a Kustomization without a serviceAccountName is applied
 * as flux-system/default (no permissions), not as the controller's own cluster-admin account.
 *
 *   node k8s/flux-install.cjs [install.yaml]   (default: download the pinned release, cached in .kube/)
 *
 * No flux CLI needed. Used by k8s/up.sh.
 */
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const FLUX_VERSION = 'v2.10.0';
const URL = `https://github.com/fluxcd/flux2/releases/download/${FLUX_VERSION}/install.yaml`;
const KEEP = new Set(['source-controller', 'kustomize-controller']);
const DEFAULT_SERVICE_ACCOUNT_ARG = '--default-service-account=default';
const CONTROLLER_KINDS = new Set(['Deployment', 'Service']);

async function load(file) {
  if (file) {
    return fs.readFileSync(file, 'utf8');
  }
  const cache = path.resolve(
    __dirname,
    '..',
    '.kube',
    `flux-install-${FLUX_VERSION}.yaml`,
  );
  if (fs.existsSync(cache)) {
    return fs.readFileSync(cache, 'utf8');
  }
  const res = await fetch(URL);
  if (!res.ok) {
    throw new Error(`GET ${URL} returned ${res.status}`);
  }
  const text = await res.text();
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, text);
  return text;
}

/** True for a controller Deployment or Service that is not one of the two kept. */
function dropped(doc) {
  const kind = doc?.kind;
  const name = doc?.metadata?.name;
  if (!CONTROLLER_KINDS.has(kind)) {
    return false;
  }
  if (kind === 'Service' && name === 'webhook-receiver') {
    return true;
  }
  return !KEEP.has(name);
}

/** Keeps the two controllers and every CRD; returns the manifest YAML. */
function transform(text) {
  const docs = YAML.parseAllDocuments(text)
    .map(d => d.toJS())
    .filter(d => d && !dropped(d));
  // Without the notification controller, each event would be retried five times before giving up, which delays
  // every reconcile by about 15 s. No events address: the controllers then only log.
  for (const d of docs) {
    for (const c of d.kind === 'Deployment'
      ? d.spec?.template?.spec?.containers ?? []
      : []) {
      c.args = (c.args ?? []).filter(
        a => !String(a).startsWith('--events-addr'),
      );
      // A Kustomization without spec.serviceAccountName (one created before each got its own account) is then
      // applied as flux-system/default, which has no permissions, and not as the controller's own cluster-admin
      // account. It fails with "forbidden" until the service is redeployed.
      if (d.metadata?.name === 'kustomize-controller' && c.name === 'manager') {
        c.args = c.args.filter(
          a => !String(a).startsWith('--default-service-account'),
        );
        c.args.push(DEFAULT_SERVICE_ACCOUNT_ARG);
      }
    }
  }
  return docs.map(d => `---\n${YAML.stringify(d)}`).join('');
}

module.exports = { transform };

if (require.main === module) {
  load(process.argv[2])
    .then(text => process.stdout.write(transform(text)))
    .catch(e => {
      console.error(`flux-install: ${e.message}`);
      process.exit(1);
    });
}
