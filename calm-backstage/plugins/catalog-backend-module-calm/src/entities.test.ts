import {
  IMPORT_FORMAT_LABELS,
  IMPORT_FORMATS,
  type PatternDecision,
} from '@internal/backstage-plugin-calm-common';
import {
  BundleInfo,
  HubDocument,
  buildEntities,
  decisionParameter,
  referencedRequirements,
  templateEntity,
} from './entities';

const hub = 'http://localhost:8090';
const requirementUrl = (control: string, version: string) =>
  `${hub}/calm/domains/sec/controls/${control}/requirement/versions/${version}`;

const decision = (relationshipId: string): PatternDecision => ({
  relationshipId,
  kind: 'oneOf',
  choices: [],
});

describe('decisionParameter', () => {
  it.each(['datastore-choice', 'name', 'bundle', 'placeholders'])(
    'prefixes %s, so it cannot clash with a fixed field',
    id => {
      expect(decisionParameter(decision(id))).toBe(`choice-${id}`);
    },
  );

  it('keeps distinct decisions distinct, even when one id is another prefixed', () => {
    expect(decisionParameter(decision('name'))).not.toBe(
      decisionParameter(decision('choice-name')),
    );
  });
});

/** A pattern with one oneOf decision per relationship id, shaped as readPatternDecisions reads it. */
function patternWithDecisions(...ids: string[]): HubDocument {
  return {
    namespace: 'hackathon',
    id: 'web-service',
    version: '1.0.0',
    doc: {
      properties: {
        relationships: {
          prefixItems: ids.map(id => ({
            properties: {
              'unique-id': { const: id },
              'relationship-type': {
                properties: {
                  options: {
                    prefixItems: [
                      {
                        oneOf: ['a', 'b'].map(c => ({
                          properties: { description: { const: `${id} ${c}` } },
                        })),
                      },
                    ],
                  },
                },
              },
            },
          })),
        },
      },
    },
  };
}

describe('templateEntity', () => {
  it('gives every decision its own form field, with no clash with the fixed ones', () => {
    const t = templateEntity(
      patternWithDecisions('name', 'choice-name', 'bundle'),
      [],
      hub,
    );
    const [service, choices, details] = (t.spec as any).parameters;

    expect(Object.keys(service.properties)).toEqual(['name']);
    expect(Object.keys(details.properties)).toEqual(['placeholders']);
    expect(Object.keys(choices.properties).sort()).toEqual([
      'choice-bundle',
      'choice-choice-name',
      'choice-name',
    ]);
    expect(choices.required.sort()).toEqual(
      Object.keys(choices.properties).sort(),
    );

    const map = JSON.parse(
      t.metadata.annotations!['calm.finos.org/decisions'] ?? '[]',
    );
    expect(new Set(map.map((m: any) => m.parameter)).size).toBe(3);
  });
});

describe('referencedRequirements', () => {
  it('keeps every referenced version of a control', () => {
    const refs = referencedRequirements([
      {
        controls: {
          tls: { 'requirement-url': requirementUrl('tls', '1.0.0') },
        },
      },
      {
        controls: {
          tls: { 'requirement-url': requirementUrl('tls', '1.1.0') },
        },
      },
    ]);
    expect(refs.map(r => r.version).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});

describe('buildEntities', () => {
  it('leaves a skipped control out of the pattern dependsOn', () => {
    const pattern: HubDocument = {
      namespace: 'hackathon',
      id: 'web-service',
      version: '1.0.0',
      doc: {
        controls: {
          kept: { 'requirement-url': requirementUrl('kept', '1.0.0') },
          gone: { 'requirement-url': requirementUrl('gone', '1.0.0') },
        },
      },
    };
    const { entities } = buildEntities({
      hubUrl: hub,
      patterns: [pattern],
      architectures: [],
      controls: [
        {
          url: requirementUrl('kept', '1.0.0'),
          domain: 'sec',
          control: 'kept',
          version: '1.0.0',
          doc: {},
        },
      ],
      bundles: [],
    });

    const resource = entities.find(
      e => e.kind === 'Resource' && e.spec?.type === 'calm-pattern',
    );
    const deps = resource?.spec?.dependsOn as string[];
    expect(deps).toHaveLength(1);
    expect(deps[0]).toContain('kept');
  });
});

const pattern = {
  namespace: 'hackathon',
  id: 'web-service',
  version: '1.0.0',
  doc: { title: 'Web Service' },
};
const fits = { namespace: 'hackathon', patternId: 'web-service' };
const bundle = (version: string, deploy?: string): BundleInfo => ({
  name: 'web-service',
  version,
  deploy,
  pattern: fits,
});
const hubUrl = 'http://localhost:8090';

function template(bundles: BundleInfo[], opts: { gitops?: boolean } = {}) {
  const spec = templateEntity(pattern, bundles, hubUrl, opts).spec as any;
  const steps: any[] = spec.steps;
  return {
    spec,
    stepIds: steps.map(s => s.id),
    step: (id: string) => steps.find(s => s.id === id),
    choices: spec.parameters[1].properties,
  };
}

describe('templateEntity: build and deploy', () => {
  it('adds the deploy box and the build and deploy steps when a fitting bundle is deployable', () => {
    const t = template([
      bundle('2.0.0'),
      bundle('3.0.0', 'kubernetes'),
      bundle('3.1.0', 'kubernetes'),
    ]);
    expect(t.choices.deploy).toMatchObject({ type: 'boolean', default: true });
    expect(t.stepIds).toEqual([
      'check-cluster',
      'generate',
      'fill',
      'validate',
      'register-hub',
      'template',
      'publish',
      'store-hub',
      'build',
      'deploy',
      'decorate',
      'register',
    ]);
    // True only with the box ticked and one of the deployable bundles chosen.
    const condition =
      '${{ parameters.deploy and (parameters.bundle in ["web-service@3.0.0","web-service@3.1.0"]) }}';
    expect(t.step('build').if).toBe(condition);
    expect(t.step('deploy').if).toBe(condition);
    expect(t.step('decorate').if).toBe(condition);
    expect(t.step('check-cluster')).toMatchObject({
      if: condition,
      input: { name: '${{ parameters.name }}' },
    });
    expect(t.step('publish').input.deployable).toBe(
      '${{ (parameters.bundle in ["web-service@3.0.0","web-service@3.1.0"]) }}',
    );
    expect(t.step('build').input).toEqual({
      dir: '${{ steps.publish.output.path }}',
      name: '${{ parameters.name }}',
      tag: '${{ context.task.id }}',
    });
    expect(t.step('deploy').input.image).toBe(
      '${{ steps.build.output.image }}',
    );
    expect(t.spec.output.text.map((x: any) => x.title)).toEqual([
      'Published locally',
      'Local Kubernetes cluster',
      'CALM Hub',
    ]);
  });

  it('leaves them out when no fitting bundle is deployable', () => {
    const t = template([bundle('1.0.0'), bundle('2.0.0', 'compose')]);
    expect(t.choices.deploy).toBeUndefined();
    expect(t.stepIds).toEqual([
      'generate',
      'fill',
      'validate',
      'register-hub',
      'template',
      'publish',
      'store-hub',
      'register',
    ]);
    expect(t.step('publish').input.deployable).toBeUndefined();
    expect(t.spec.output.text.map((x: any) => x.title)).toEqual([
      'Published locally',
      'CALM Hub',
    ]);
    expect(t.spec.output.text[1].content).not.toContain('decorate');
  });
});

describe('templateEntity: the default bundle is the newest, whatever its name', () => {
  const full = (name: string, version: string): BundleInfo => ({
    name,
    version,
    patterns: [fits],
  });
  const starterOf = (name: string, version: string): BundleInfo => ({
    name,
    version,
    kind: 'starter',
    patterns: [fits],
  });

  it('full bundles only: the highest version across names, not the last name', () => {
    const t = template([
      full('web-service', '2.0.0'),
      full('alpha-service', '3.0.0'),
    ]);
    expect(t.choices.bundle.default).toBe('alpha-service@3.0.0');
  });

  it('starters: the highest version across names, not the last name', () => {
    const t = template([
      starterOf('node-service', '2.0.0'),
      starterOf('spring-boot-service', '1.0.0'),
    ]);
    expect(t.choices.bundle.default).toBe('node-service@2.0.0');
  });

  it('equal versions: the later name; versions compare as versions, not text', () => {
    expect(
      template([full('a-service', '1.0.0'), full('b-service', '1.0.0')]).choices
        .bundle.default,
    ).toBe('b-service@1.0.0');
    expect(
      template([full('web-service', '1.9.0'), full('web-service', '1.10.0')])
        .choices.bundle.default,
    ).toBe('web-service@1.10.0');
  });
});

describe('templateEntity: starters and deployment rules', () => {
  const starter = (
    name: string,
    version: string,
    runtime?: string,
  ): BundleInfo => ({
    name,
    version,
    kind: 'starter',
    runtime,
    patterns: [fits],
  });
  const rules = (version: string): BundleInfo => ({
    name: 'k8s-deploy',
    version,
    kind: 'deployment',
    deploy: 'kubernetes',
    patterns: [fits, { namespace: 'hackathon', patternId: 'event-streaming' }],
  });
  const all = [
    bundle('3.0.0', 'kubernetes'),
    starter('spring-boot-service', '1.0.0', 'Spring Boot 4.0.9 on Java 21'),
    starter('node-service', '1.0.0'),
    rules('1.0.0'),
    rules('1.1.0'),
  ];

  it('offers starters and full bundles as bundle and deployment bundles as deployBundle', () => {
    const t = template(all, { gitops: true });
    expect(t.choices.bundle.enum).toEqual([
      'node-service@1.0.0',
      'spring-boot-service@1.0.0',
      'web-service@3.0.0',
    ]);
    expect(t.choices.bundle.enumNames[1]).toBe(
      'spring-boot-service 1.0.0 (Spring Boot 4.0.9 on Java 21)',
    );
    expect(t.choices.bundle.enumNames[2]).toBe(
      'web-service 3.0.0 (full bundle)',
    );
    expect(t.choices.deployBundle).toMatchObject({
      enum: ['k8s-deploy@1.0.0', 'k8s-deploy@1.1.0'],
      default: 'k8s-deploy@1.1.0',
    });
  });

  it('renders the deployment rules into rendered-deploy only when the starter is not full', () => {
    const t = template(all, { gitops: true });
    const isStarter =
      '(parameters.bundle in ["node-service@1.0.0","spring-boot-service@1.0.0"])';
    expect(t.stepIds.slice(5, 8)).toEqual([
      'template',
      'template-deploy',
      'publish',
    ]);
    expect(t.step('template-deploy')).toMatchObject({
      action: 'calm:template',
      if: `\${{ ${isStarter} }}`,
      input: {
        bundle: '${{ parameters.deployBundle }}',
        outputDir: 'rendered-deploy',
      },
    });
    expect(t.step('publish').input).toMatchObject({
      deployBundle: `\${{ parameters.deployBundle if ${isStarter} else "" }}`,
      deploySourceDir: `\${{ "rendered-deploy" if ${isStarter} else "" }}`,
    });
    // Every starter can be deployed (there are deployment rules), and so can the deployable full bundle.
    expect(t.step('deploy').if).toContain(
      '"web-service@3.0.0","node-service@1.0.0","spring-boot-service@1.0.0"',
    );
  });

  it('has no deployment-rules choice without starters', () => {
    const t = template([bundle('3.0.0', 'kubernetes'), rules('1.0.0')]);
    expect(t.choices.deployBundle).toBeUndefined();
    expect(t.stepIds).not.toContain('template-deploy');
  });

  it('does not offer a bundle that fits another pattern', () => {
    const t = template([
      ...all,
      {
        name: 'nisshi-stream-app',
        version: '1.0.0',
        kind: 'starter',
        patterns: [{ patternId: 'event-streaming' }],
      },
    ]);
    expect(t.choices.bundle.enum).not.toContain('nisshi-stream-app@1.0.0');
  });
});

describe('upgrade Template', () => {
  const snapshot = (gitops: boolean) =>
    buildEntities({
      hubUrl,
      patterns: [],
      architectures: [],
      controls: [],
      bundles: [],
      gitops,
    });

  it('is emitted only when services live in Git, with render, build, merge, deploy, decorate and refresh steps', () => {
    expect(
      snapshot(false).entities.find(e => e.metadata.name === 'calm-upgrade'),
    ).toBeUndefined();
    const t = snapshot(true).entities.find(
      e => e.metadata.name === 'calm-upgrade',
    ) as any;
    expect(t.kind).toBe('Template');
    expect(t.spec.steps.map((s: any) => s.action)).toEqual([
      'calm:upgrade:render',
      'calm:image:build',
      'calm:upgrade:merge',
      'calm:deploy:gitops',
      'calm:decorate:deployment',
      'calm:catalog:refresh',
    ]);
    expect(t.spec.steps[1].if).toBe('${{ steps.render.output.codeChanged }}');
    expect(
      t.spec.parameters[0].properties.service['ui:options'].catalogFilter,
    ).toEqual([{ kind: 'Component', 'metadata.tags': 'calm-gitops' }]);
  });

  it('passes record to the deploy step, from the render step', () => {
    const t = snapshot(true).entities.find(
      e => e.metadata.name === 'calm-upgrade',
    ) as any;
    const deploy = t.spec.steps.find((s: any) => s.id === 'deploy');
    expect(deploy.input.record).toEqual({
      hubNamespace: '${{ steps.render.output.hubNamespace }}',
      architecture: '${{ steps.render.output.architecture }}',
      version: '${{ steps.render.output.architectureVersion }}',
      architecturePath: '${{ steps.render.output.architecturePath }}',
    });
  });
});

describe('templateEntity: Git and Flux', () => {
  it('pushes the service to Git after publishing and storing in the Hub, tags the image with the commit and deploys with Flux', () => {
    const t = template([bundle('3.0.0', 'kubernetes')], { gitops: true });
    expect(t.stepIds).toEqual([
      'check-cluster',
      'generate',
      'fill',
      'validate',
      'register-hub',
      'template',
      'publish',
      'store-hub',
      'git-publish',
      'build',
      'deploy',
      'decorate',
      'register',
    ]);
    expect(t.step('git-publish')).toMatchObject({
      action: 'calm:git:publish',
      input: { dir: '${{ steps.publish.output.path }}' },
    });
    expect(t.step('build').input.tag).toBe(
      '${{ steps["git-publish"].output.shortCommit }}',
    );
    expect(t.step('deploy').action).toBe('calm:deploy:gitops');
    expect(t.step('decorate').input).toMatchObject({
      gitRepo: '${{ steps.deploy.output.repoUrl }}',
      gitCommit: '${{ steps.deploy.output.commit }}',
    });
  });

  it('passes record to the deploy step, so a failed deployment is recorded in the Hub', () => {
    const expected = {
      hubNamespace: '${{ steps["register-hub"].output.namespace }}',
      architecture: '${{ steps["register-hub"].output.architecture }}',
      version: '${{ steps["register-hub"].output.version }}',
      architecturePath: '${{ steps.fill.output.architecturePath }}',
    };
    for (const gitops of [false, true]) {
      const t = template([bundle('3.0.0', 'kubernetes')], { gitops });
      expect(t.step('deploy').input.record).toEqual(expected);
      expect(t.step('decorate').input.status).toBe('completed');
    }
  });

  it('keeps kubectl apply without calm.gitops', () => {
    const t = template([bundle('3.0.0', 'kubernetes')]);
    expect(t.stepIds).not.toContain('git-publish');
    expect(t.step('deploy').action).toBe('calm:deploy:k8s');
    expect(t.step('build').input.tag).toBe('${{ context.task.id }}');
  });
});

describe('templateEntity: CALM Hub', () => {
  it('prepares the architecture before the render, stores it after the publish and before the git publish, and publishes with the Hub annotations', () => {
    const t = template([bundle('2.0.0')]);
    expect(t.step('register-hub')).toMatchObject({
      action: 'calm:register:hub',
      input: {
        architecturePath: '${{ steps.fill.output.architecturePath }}',
        name: '${{ parameters.name }}',
        mode: 'prepare',
      },
    });
    expect(t.step('register-hub').if).toBeUndefined();
    expect(t.step('store-hub')).toMatchObject({
      action: 'calm:register:hub',
      input: {
        architecturePath: '${{ steps.fill.output.architecturePath }}',
        name: '${{ parameters.name }}',
        mode: 'store',
        // Removed when the store fails, so the Template can be run again.
        publishedDir: '${{ steps.publish.output.path }}',
      },
    });
    expect(t.step('store-hub').if).toBeUndefined();
    // The output text reports what store-hub stored.
    const hubContent = t.spec.output.text.find(
      (x: any) => x.title === 'CALM Hub',
    ).content;
    expect(hubContent).toContain('steps["store-hub"].output.version');
    expect(hubContent).not.toContain('register-hub');
    // A dry run gives no url (nothing is stored, nothing is recorded): the text must not print "undefined".
    expect(hubContent).toContain(
      '(", at " + steps["store-hub"].output.url) if steps["store-hub"].output.url else ""',
    );
    expect(t.step('publish').input).toMatchObject({
      hubNamespace: '${{ steps["register-hub"].output.namespace }}',
      hubArchitecture: '${{ steps["register-hub"].output.architecture }}',
      hubArchitectureVersion: '${{ steps["register-hub"].output.version }}',
    });
  });

  it('records the deployment on the registered version, with what the deploy step gives', () => {
    const t = template([bundle('3.0.0', 'kubernetes')]);
    expect(t.step('decorate')).toMatchObject({
      action: 'calm:decorate:deployment',
      input: {
        hubNamespace: '${{ steps["store-hub"].output.namespace }}',
        architecture: '${{ steps["store-hub"].output.architecture }}',
        version: '${{ steps["store-hub"].output.version }}',
        name: '${{ parameters.name }}',
        cluster: '${{ steps.deploy.output.cluster }}',
        namespace: '${{ steps.deploy.output.namespace }}',
        workloads: '${{ steps.deploy.output.nodes }}',
        startTime: '${{ steps.deploy.output.startTime }}',
        endTime: '${{ steps.deploy.output.endTime }}',
        status: 'completed',
      },
    });
  });

  it('leaves the link out of the output text when a dry run gives no url', () => {
    const t = template([bundle('3.0.0', 'kubernetes')]);
    const content = t.spec.output.text.find(
      (x: any) => x.title === 'CALM Hub',
    ).content;
    expect(content).toContain(
      '(": " + steps.decorate.output.url if steps.decorate.output.url else "")',
    );
  });

  it('asks for a name CALM Hub accepts: a letter first', () => {
    const name = template([bundle('2.0.0')]).spec.parameters[0].properties.name;
    const allowed = new RegExp(name.pattern);
    expect(['billing-api', 'a', 'api2-v3'].every(n => allowed.test(n))).toBe(
      true,
    );
    expect(
      ['2fast', '-api', 'api-', 'a--b', 'Billing', 'a_b'].some(n =>
        allowed.test(n),
      ),
    ).toBe(false);
    expect(name.description).toMatch(/must start with a lower-case letter/);
  });

  it('has no Hub steps without a bundle', () => {
    expect(template([]).stepIds).toEqual(['generate', 'fill', 'validate']);
  });
});

describe('buildEntities: architectures of published services', () => {
  const architecture = (id: string, doc: object) => ({
    namespace: 'hackathon',
    id,
    version: '1.0.0',
    doc,
  });

  it('emits no Component for a Hub architecture that calm:register:hub stored for a service', () => {
    const { entities, warnings, serviceArchitectures } = buildEntities({
      hubUrl,
      patterns: [],
      controls: [],
      bundles: [],
      architectures: [
        architecture('orders-service', { title: 'Orders Service' }),
        architecture('billing-api', {
          metadata: {
            'calm-backstage': { entity: 'component:default/billing-api' },
          },
        }),
      ],
    });
    expect(entities.map(e => `${e.kind}:${e.metadata.name}`)).toEqual([
      'Template:calm-import-diagram',
      'Component:orders-service',
    ]);
    expect(serviceArchitectures).toEqual(['hackathon/billing-api']);
    expect(warnings).toEqual([]);
  });
});

describe('import Template', () => {
  const find = (gitops: boolean) =>
    buildEntities({
      hubUrl,
      patterns: [],
      architectures: [],
      controls: [],
      bundles: [],
      gitops,
    }).entities.find(e => e.metadata.name === 'calm-import-diagram') as any;

  // The output of whichever step ran, then the field: `0 or undefined` would render a count of 0 as blank.
  const pick = (field: string) =>
    `(steps.drawio.output or steps.c4.output or steps.mermaid.output).${field}`;

  it('is always emitted, with three convert steps, then validate and store', () => {
    for (const gitops of [false, true]) {
      const t = find(gitops);
      expect(t.kind).toBe('Template');
      expect(t.metadata.title).toBe('Import a diagram');
      expect(t.metadata.tags).toEqual(['calm', 'calm-import']);
      expect(t.spec.steps.map((s: any) => s.id)).toEqual([
        'drawio',
        'c4',
        'mermaid',
        'validate',
        'store',
      ]);
      expect(t.spec.steps.map((s: any) => s.action)).toEqual([
        'calm:import:drawio',
        'calm:import:c4',
        'calm:import:mermaid',
        'calm:validate',
        'calm:import:store',
      ]);
    }
  });

  it('runs exactly the convert step that matches the format', () => {
    const steps = find(false).spec.steps;
    for (const id of ['drawio', 'c4', 'mermaid']) {
      const step = steps.find((s: any) => s.id === id);
      expect(step.if).toBe(`\${{ parameters.format === '${id}' }}`);
      expect(step.input).toEqual({
        name: '${{ parameters.name }}',
        diagram: '${{ parameters.diagram }}',
      });
    }
  });

  it('validates against the CALM schema only (no patternUrl) and stores last', () => {
    const t = find(false);
    const validate = t.spec.steps[3];
    expect(validate.input).toEqual({ architecturePath: 'architecture.json' });
    expect(t.spec.steps[4].action).toBe('calm:import:store');
    expect(t.spec.steps[4].input.architecturePath).toBe('architecture.json');
  });

  it('asks for the format, defaulting to draw.io', () => {
    const form = find(false).spec.parameters[0];
    expect(form.required).toEqual(['name', 'format', 'diagram']);
    expect(form.properties.format).toMatchObject({
      type: 'string',
      enum: ['drawio', 'c4', 'mermaid'],
      enumNames: ['draw.io', 'C4 (Mermaid or PlantUML)', 'Mermaid flowchart'],
      default: 'drawio',
    });
    // The action's wrong-format hint names the formats with the same labels.
    expect(form.properties.format.enumNames).toEqual(
      IMPORT_FORMATS.map(f => IMPORT_FORMAT_LABELS[f]),
    );
  });

  it('takes the diagram as a data-url and a valid name', () => {
    const props = find(false).spec.parameters[0].properties;
    expect(props.diagram).toMatchObject({
      type: 'string',
      format: 'data-url',
      title: 'Diagram',
      'ui:options': {
        accept: '.drawio,.xml,.svg,.md,.mmd,.puml,.plantuml,.txt',
      },
      // The review step would otherwise print the whole data-url.
      'ui:backstage': { review: { mask: '(the uploaded file)' } },
    });
    expect(props.name.pattern).toBe('^[a-z][a-z0-9]*(-[a-z0-9]+)*$');
    expect(props.name.maxLength).toBe(63);
    expect(props.description).toBeDefined();
  });

  it('links to the Hub url only when present and to the catalog entity', () => {
    const out = find(false).spec.output;
    const urls = out.links.filter((l: any) => l.url);
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe('${{ steps.store.output.url }}');
    expect(urls[0].if).toBe('${{ steps.store.output.url }}');
    expect(
      out.links.some(
        (l: any) => l.entityRef === '${{ steps.store.output.entityRef }}',
      ),
    ).toBe(true);
  });

  it('reads the counts and guesses from whichever convert step ran', () => {
    const content: string = find(false).spec.output.text[0].content;
    expect(content).toContain(
      `**\${{ ${pick('nodes')} }} nodes** and **\${{ ${pick(
        'relationships',
      )} }} relationships**`,
    );
    // The join separator is a real newline inside the Nunjucks string literal, which renders as is.
    const g = pick('guesses');
    expect(content).toContain(
      `\nGuesses made while converting (check them):\n\${{ ("- " + (${g} | join("\n- "))) if (${g} | length) else "None." }}`,
    );
    // What was left out or changed shows on the result page too, not only in the log (#71).
    const l = pick('leftOut');
    expect(
      content.endsWith(
        `\nLeft out of the architecture, or changed:\n\${{ ("- " + (${l} | join("\n- "))) if (${l} | length) else "Nothing." }}`,
      ),
    ).toBe(true);
  });
});
