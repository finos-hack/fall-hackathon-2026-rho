const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { transform } = require('./flux-install.cjs');

const deployment = (name, args) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name, namespace: 'flux-system' },
  spec: {
    template: { spec: { containers: [{ name: 'manager', args }] } },
  },
});

const fixture = (extraKustomizeArgs = []) =>
  [
    deployment('source-controller', [
      '--events-addr=http://notification-controller.flux-system.svc.cluster.local./',
      '--watch-all-namespaces=true',
    ]),
    deployment('kustomize-controller', [
      '--events-addr=http://notification-controller.flux-system.svc.cluster.local./',
      '--watch-all-namespaces=true',
      ...extraKustomizeArgs,
    ]),
    deployment('helm-controller', ['--watch-all-namespaces=true']),
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'webhook-receiver' },
    },
    {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'kustomizations.kustomize.toolkit.fluxcd.io' },
    },
  ]
    .map(d => `---\n${YAML.stringify(d)}`)
    .join('');
const FIXTURE = fixture();

const run = text => YAML.parseAllDocuments(transform(text)).map(d => d.toJS());
const argsOf = (docs, name) =>
  docs.find(d => d.kind === 'Deployment' && d.metadata.name === name).spec
    .template.spec.containers[0].args;

test('kustomize-controller gets exactly one --default-service-account=default', () => {
  const args = argsOf(run(FIXTURE), 'kustomize-controller');
  assert.deepEqual(
    args.filter(a => a.startsWith('--default-service-account')),
    ['--default-service-account=default'],
  );
});

test('an existing different value is replaced, not duplicated', () => {
  const text = fixture(['--default-service-account=other']);
  const args = argsOf(run(text), 'kustomize-controller');
  assert.deepEqual(
    args.filter(a => a.startsWith('--default-service-account')),
    ['--default-service-account=default'],
  );
});

test('source-controller does not get the flag', () => {
  const args = argsOf(run(FIXTURE), 'source-controller');
  assert.ok(!args.some(a => a.startsWith('--default-service-account')));
});

test('--events-addr is still removed', () => {
  const docs = run(FIXTURE);
  for (const name of ['source-controller', 'kustomize-controller']) {
    assert.ok(!argsOf(docs, name).some(a => a.startsWith('--events-addr')));
  }
});

test('other controllers and webhook-receiver are dropped, CRDs kept', () => {
  const docs = run(FIXTURE);
  assert.ok(!docs.some(d => d.metadata.name === 'helm-controller'));
  assert.ok(!docs.some(d => d.metadata.name === 'webhook-receiver'));
  assert.ok(docs.some(d => d.kind === 'CustomResourceDefinition'));
});
