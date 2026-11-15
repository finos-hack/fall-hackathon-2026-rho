// Records the cluster demo: a terminal (left) and Backstage (right), side by side, live. The terminal starts on an
// empty cluster and watches a Nisshi event-streaming service arrive while Backstage creates it from its CALM pattern;
// then it proves the service from outside Backstage: its workloads and network policies, the app answering curl, the
// policies enforced on a probe pod, and Nisshi's topics stored in PostgreSQL.
//
// Needs the stack running (yarn hub:up && yarn hub:seed, yarn k8s:up, Backstage), ttyd and ffmpeg on the PATH, and no
// other calm-* service in the cluster if the opening shot should be empty (docs/demo/cleanup.sh). Writes
// <out>/calm-backstage-cluster-demo.mp4 and <out>/chapters.json (each chapter's start, in seconds).
//
//   node docs/demo/record-cluster-demo.cjs [suffix] [out-dir] [base-url]
//
// The service is events-<suffix>; pick a suffix not used yet (default demo). Defaults: out-dir = a new temp folder,
// base-url http://localhost:3100.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createRequire } = require('module');
const { chromium } = createRequire(
  path.resolve(__dirname, '../../package.json'),
)('playwright');

const REPO = path.resolve(__dirname, '../..');
const SUFFIX = process.argv[2] || 'demo';
const OUT =
  process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'calm-demo-'));
const BASE = process.argv[4] || 'http://localhost:3100';
const EVENTS = `events-${SUFFIX}`;
const HUB = 'http://localhost:8090';
const GITEA = 'http://localhost:3300';
const TTYD_PORT = 7681;
const APP_PORT = 18080;
// Terminal on the left, Backstage on the right: 1920×1080 together. Backstage renders at 1.25× the size it is
// recorded at, so its sidebar leaves room for the page.
const TW = 860,
  BW = 1060,
  H = 1080,
  ZOOM = 1.25;

const CHAPTERS = [
  'An empty cluster',
  'The pattern, in Backstage and CALM Hub',
  'Starters and deployment rules',
  'Create the service, step by step',
  'The Template runs; the service arrives',
  'The service in Backstage and in the cluster',
  'In Git',
  'In CALM Hub',
  'The app answers',
  'Network policies, enforced',
  'Nisshi keeps its topics in PostgreSQL',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** On a failure: screenshots of both sides and the videos so far, kept in out-dir. */
let onFailure = async () => {};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prompts = path.join(OUT, 'prompts');
  fs.writeFileSync(prompts, '');
  const promptCount = () => fs.readFileSync(prompts, 'utf-8').length;
  const ttyd = spawn(
    'ttyd',
    [
      '-W',
      '-i',
      '127.0.0.1',
      '-p',
      String(TTYD_PORT),
      '-t',
      'fontSize=16',
      '-t',
      'cursorBlink=true',
      '-t',
      'disableLeaveAlert=true',
      '-t',
      `theme=${JSON.stringify({
        background: '#121826',
        foreground: '#e6ebf2',
        cursor: '#7aa2ff',
        blue: '#7aa2ff',
        brightBlue: '#9ab8ff',
      })}`,
      'bash',
      '--noprofile',
      '--rcfile',
      path.join(__dirname, 'cluster-demo.rc'),
    ],
    {
      env: {
        ...process.env,
        CALM_DEMO_REPO: REPO,
        CALM_DEMO_PROMPTS: prompts,
      },
      stdio: 'ignore',
    },
  );
  process.on('exit', () => ttyd.kill());
  await sleep(1000);

  const browser = await chromium.launch();
  const recorded = async (width, dir, zoom = 1) => {
    const context = await browser.newContext({
      viewport: {
        width: Math.round(width * zoom),
        height: Math.round(H * zoom),
      },
      recordVideo: { dir: path.join(OUT, dir), size: { width, height: H } },
    });
    const p = await context.newPage();
    return { context, page: p, created: Date.now() };
  };
  const T = await recorded(TW, 'terminal');
  const B = await recorded(BW, 'backstage', ZOOM);
  const term = T.page;
  const page = B.page;
  onFailure = async () => {
    await term.screenshot({ path: path.join(OUT, 'failed-terminal.png') });
    await page.screenshot({ path: path.join(OUT, 'failed-backstage.png') });
    await T.context.close();
    await B.context.close();
    await browser.close();
  };
  page.setDefaultTimeout(60000);
  const pause = ms => page.waitForTimeout(ms);
  let t0 = Date.now();
  const marks = [];
  const log = m =>
    console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${m}`);
  const chapter = i => {
    marks.push({
      chapter: i + 1,
      title: CHAPTERS[i],
      start: Math.round((Date.now() - t0) / 1000),
    });
    log(`chapter ${i + 1}: ${CHAPTERS[i]}`);
  };

  // ---- Terminal helpers: type a command, and wait for the prompt to come back (the rc counts prompts in a file).
  async function until(check, timeout, what) {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  }
  /** Types a command; resolves when its prompt returns (or at once with wait: false, returning a waiter). */
  async function sh(cmd, { wait = true, timeout = 120000, after = 1200 } = {}) {
    const before = promptCount();
    await term.keyboard.type(cmd, { delay: 22 });
    await sleep(250);
    await term.keyboard.press('Enter');
    const done = () => until(() => promptCount() > before, timeout, cmd);
    if (!wait) return done;
    await done();
    await sleep(after);
    return undefined;
  }
  const say = (text, after = 1500) => sh(`# ${text}`, { after });

  // ---- Backstage helpers (as in record-full-demo.cjs).
  async function caption(text) {
    await page.evaluate(t => {
      let el = document.getElementById('__demo_caption');
      if (!el) {
        el = document.createElement('div');
        el.id = '__demo_caption';
        Object.assign(el.style, {
          position: 'fixed',
          left: '50%',
          bottom: '28px',
          transform: 'translateX(-50%)',
          zIndex: 99999,
          background: 'rgba(20,24,33,0.9)',
          color: '#fff',
          font: '600 19px/1.35 system-ui, sans-serif',
          padding: '12px 22px',
          borderRadius: '10px',
          maxWidth: '86%',
          textAlign: 'center',
          boxShadow: '0 6px 24px rgba(0,0,0,0.3)',
          pointerEvents: 'none',
        });
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
  }
  async function scrollTo(locator) {
    for (let i = 0; i < 5; i++) {
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 10000 });
        return;
      } catch {
        await pause(700);
      }
    }
  }
  /** Navigates inside the Backstage app (no full reload, so no blank page in the video). */
  const nav = async to => {
    await page.evaluate(u => {
      window.history.pushState({}, '', u);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, to);
  };
  /** Shows the home folder as ~ in the page from now on (the run page prints local paths). */
  const maskHome = () =>
    page.evaluate(home => {
      if (window.__demoMask) return;
      const mask = () => {
        const walk = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeValue.includes(home))
            n.nodeValue = n.nodeValue.split(home).join('~');
        }
      };
      mask();
      window.__demoMask = setInterval(mask, 100);
    }, os.homedir());
  /** Outlines the step of a scaffolder run whose label starts with `label` (null clears it). */
  const highlight = label =>
    page.evaluate(l => {
      for (const e of document.querySelectorAll('[data-demo-step]')) {
        e.style.outline = '';
        e.removeAttribute('data-demo-step');
      }
      if (!l) return;
      const leaf = [...document.querySelectorAll('span, p, div')].find(
        e => e.childElementCount === 0 && e.textContent.trim().startsWith(l),
      );
      const step = leaf?.closest('.MuiStep-root') ?? leaf?.parentElement;
      if (step) {
        step.setAttribute('data-demo-step', '1');
        Object.assign(step.style, {
          outline: '3px solid #3f6fe8',
          outlineOffset: '4px',
          borderRadius: '8px',
        });
      }
    }, label);
  const svgIn = () =>
    page
      .locator('[data-testid="calm-mermaid"] svg')
      .first()
      .waitFor({ timeout: 60000 });
  async function fillPlaceholders(name, topic) {
    await page
      .getByTestId('calm-placeholders-summary')
      .waitFor({ timeout: 60000 });
    await pause(1200);
    const inputs = page.locator('input[id^="calm-placeholder-"]');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const id = await inputs.nth(i).getAttribute('id');
      const v = id.endsWith('/host')
        ? `${name}.example.com`
        : id.includes('/nodes/1/interfaces/0/port')
        ? '443'
        : id.endsWith('/port')
        ? '8080'
        : id.endsWith('/owner')
        ? 'team-payments'
        : id.endsWith('/topic')
        ? topic
        : id.endsWith('/service-name')
        ? name
        : 'x';
      await inputs.nth(i).scrollIntoViewIfNeeded();
      await inputs.nth(i).pressSequentially(v, { delay: 25 });
    }
    await pause(600);
  }

  // ---- Set up off camera (trimmed from the video): the terminal prompt, and Backstage signed in on the catalog.
  await term.goto(`http://127.0.0.1:${TTYD_PORT}/`);
  await until(() => promptCount() > 0, 30000, 'the terminal prompt');
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: /enter/i }).first().click();
  await page.waitForLoadState('networkidle');
  await page.goto(`${BASE}/?filters%5Bkind%5D=component&filters%5Buser%5D=all`);
  await page.waitForLoadState('networkidle');
  await sleep(1500);
  t0 = Date.now();
  const both = (...parts) => Promise.all(parts.map(f => f()));

  // ---- 1. An empty cluster
  chapter(0);
  await both(
    async () => {
      await say(
        'A local Kubernetes cluster with Flux installed, and no services',
      );
      await sh('k get namespaces');
      await sh('k get kustomizations -n flux-system', { after: 2000 });
    },
    async () => {
      await caption(
        'Backstage (right) and the local Kubernetes cluster (left)',
      );
      await pause(4000);
      await caption(
        'The catalog: CALM architectures from CALM Hub, and no services yet',
      );
    },
  );

  // ---- 2. The pattern, in Backstage and CALM Hub
  chapter(1);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('CALM patterns are stored in CALM Hub');
      await sh(
        "curl -s $HUB/calm/namespaces/hackathon/patterns | jq -c '.values[] | {pattern: .customId}'",
        { after: 1500 },
      );
    },
    async () => {
      await nav('/catalog/default/resource/pattern-event-streaming');
      await page.getByText('Template bundles that fit').waitFor();
      await caption(
        'A CALM pattern in Backstage: event streaming through Nisshi, a Kafka-compatible broker',
      );
      await pause(3500);
      await scrollTo(page.getByText('Template bundles that fit'));
      await caption(
        'Its decision (where the broker keeps its topics) and the template bundles that fit it',
      );
      await pause(4500);
      await page.goto(`${HUB}/#/hackathon/patterns/event-streaming/1.0.0`);
      await page.getByText('Decisions').first().waitFor();
      await pause(1500);
      await caption(
        'The same pattern in CALM Hub, where Backstage reads it from',
      );
      await pause(4500);
    },
  );

  // ---- 3. Starters and deployment rules
  chapter(2);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('Template bundles are OCI artifacts in a registry');
      await sh("curl -s $REGISTRY/v2/_catalog | jq -r '.repositories[]'", {
        after: 1500,
      });
      await sh(
        'curl -s $REGISTRY/v2/calm-bundles/nisshi-stream-app/tags/list | jq -c',
        { after: 1500 },
      );
    },
    async () => {
      await page.goto(`${BASE}/calm-templates`);
      await page.getByTestId('calm-explorer-bundles').waitFor();
      await caption(
        'The Template Explorer: starters are the code a service begins with',
      );
      await pause(2500);
      for (const [bundle, text] of [
        ['spring-boot-service 1.1.0', 'Spring Boot 4.1.2 on Java 21'],
        [
          'quarkus-service 1.1.0',
          'Red Hat build of Quarkus on Red Hat UBI images',
        ],
        ['node-service 1.0.0', 'Node.js, no dependencies'],
        ['nisshi-stream-app 1.0.1', 'and a Nisshi stream app: today’s pick'],
      ]) {
        await page.getByText(bundle).first().click();
        await caption(`Several starters to choose from: ${text}`);
        await pause(2200);
      }
      await page
        .getByTestId('calm-explorer-files')
        .getByText('server.js.hbs')
        .click();
      await page.getByTestId('calm-explorer-file').waitFor();
      await caption(
        'Each starter file is a template filled in from the CALM architecture',
      );
      await pause(4000);
      await page.getByText('k8s-deploy 1.2.1').first().click();
      await page
        .getByTestId('calm-explorer-files')
        .getByText('network-policy.yaml.hbs')
        .click();
      await caption(
        'Deployment rules are separate, shared by every starter: here, a network policy per relationship',
      );
      await pause(4500);
    },
  );

  // ---- 4. Create the service, step by step
  chapter(3);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('Backstage is about to create calm-' + EVENTS);
    },
    async () => {
      await nav('/create');
      await page.getByText('Event Streaming (Nisshi)').first().waitFor();
      await caption('Each CALM pattern is a Template in Backstage');
      await pause(2500);
      await nav('/create/templates/default/create-from-web-service');
      await page.getByLabel(/^Name/).first().waitFor();
      await page
        .getByLabel(/^Name/)
        .first()
        .pressSequentially('orders', { delay: 50 });
      await page.getByRole('button', { name: /^next$/i }).click();
      const springBoot = page.getByLabel(/^spring-boot-service 1\.1\.0/);
      await springBoot.waitFor();
      await scrollTo(springBoot);
      await caption(
        'In the web-service Template a team picks its starter: Node.js, Red Hat Quarkus or Spring Boot',
      );
      await pause(4500);
      await nav('/create');
      await page.getByText('Event Streaming (Nisshi)').first().waitFor();
      await nav('/create/templates/default/create-from-event-streaming');
      await page.getByLabel(/^Name/).first().waitFor();
      await caption('Today: the event-streaming Template. Step 1, a name');
      await page
        .getByLabel(/^Name/)
        .first()
        .pressSequentially(EVENTS, { delay: 55 });
      await pause(800);
      await page.getByRole('button', { name: /^next$/i }).click();
      await page.getByLabel('PostgreSQL').waitFor();
      await caption(
        'Step 2, the choices: the pattern’s decision first, where the broker keeps its topics',
      );
      await pause(2500);
      await page.getByLabel('PostgreSQL').check();
      await pause(1200);
      const rules = page.getByLabel('k8s-deploy@1.2.1');
      await scrollTo(rules);
      await caption(
        'then the starter and the deployment rules, from the registry',
      );
      await rules.check();
      await pause(3000);
      await page.getByRole('button', { name: /^next$/i }).click();
      await caption(
        'Step 3: calm generate has made the architecture; fill in the values it leaves open',
      );
      await fillPlaceholders(EVENTS, 'orders');
      await page.getByRole('button', { name: /^review$/i }).click();
      await caption('Step 4: review, then create');
      await pause(2500);
    },
  );

  // ---- 5. Watch it arrive
  chapter(4);
  const watched = await sh(`watch-cluster.sh ${EVENTS}`, {
    wait: false,
    timeout: 900000,
  });
  await pause(1200);
  await page.getByRole('button', { name: /^create$/i }).click();
  await page.waitForURL(/\/tasks\//);
  await maskHome();
  await caption('The Template runs; the cluster on the left fills as it goes');
  await page
    .getByText('Open the new service in the catalog')
    .waitFor({ timeout: 900000 });
  log('task finished');
  for (const [step, text] of [
    [
      'Generate the architecture',
      'calm generate: the pattern and the choices become a CALM architecture',
    ],
    [
      'Validate against the pattern',
      'calm validate: the architecture is checked against the pattern',
    ],
    [
      'Render with the template bundle',
      'calm template: the starter renders the code from the architecture',
    ],
    [
      'Render the deployment rules',
      'The deployment rules render the Kubernetes manifests and network policies',
    ],
    [
      'Store the architecture in CALM Hub',
      'The architecture is stored in CALM Hub',
    ],
    [
      'Push the service to its Git repository',
      'The service gets its own Git repository',
    ],
    ['Build the image', 'Its image is built in the cluster'],
    ['Deploy through Git and Flux', 'Flux applies the commit to the cluster'],
    [
      'Record the deployment in CALM Hub',
      'The deployment is recorded back in CALM Hub',
    ],
  ]) {
    await highlight(step);
    await caption(text);
    await pause(2600);
  }
  await highlight(null);
  await watched();
  log('all pods ready');

  // ---- 6. The service in Backstage, and what landed in the cluster
  chapter(5);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await sh(`NS=calm-${EVENTS}`, { after: 400 });
      await sh('k get deployments,services -n $NS', { after: 2000 });
      await sh(
        'k get networkpolicies -n $NS -o custom-columns=POLICY:.metadata.name,APPLIES-TO:.spec.podSelector.matchLabels',
        { after: 2000 },
      );
      await say('One policy pair per relationship in the architecture');
    },
    async () => {
      await page.getByText('Open the new service in the catalog').click();
      await svgIn();
      await scrollTo(page.getByTestId('calm-versions'));
      await caption(
        'The new service: its CALM architecture, the bundles it was made with, Git and Flux',
      );
      await pause(4500);
      await scrollTo(page.getByTestId('calm-deployment'));
      await caption(
        'and what runs: four workloads, and the network policies its relationships became',
      );
      await pause(4500);
    },
  );

  // ---- 7. In Git
  chapter(6);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('Flux deploys from the service repository');
      await sh(
        'k get gitrepositories -n flux-system -o custom-columns=SOURCE:.metadata.name,URL:.spec.url',
        { after: 1200 },
      );
      await sh(
        'k get kustomizations -n flux-system -o custom-columns=NAME:.metadata.name,APPLIED:.status.lastAppliedRevision',
        { after: 1500 },
      );
    },
    async () => {
      await page.goto(`${GITEA}/calm-services/${EVENTS}`);
      await pause(1500);
      await caption(
        'The rendered service in Git: src/ from the starter, deploy/ from the deployment rules',
      );
      await pause(4000);
      await page.goto(
        `${GITEA}/calm-services/${EVENTS}/src/branch/main/deploy/k8s/network-policy.yaml`,
      );
      await pause(1500);
      await caption(
        'deploy/k8s/network-policy.yaml: the policies rendered from the architecture’s relationships',
      );
      await pause(4000);
    },
  );

  // ---- 8. In CALM Hub
  chapter(7);
  const target = `/calm/namespaces/hackathon/architectures/${EVENTS}/versions/1.0.0`;
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('The architecture Backstage stored in CALM Hub');
      await sh(
        `curl -s $HUB${target} | jq -c '.nodes[] | {node: ."unique-id", type: ."node-type"}'`,
        { after: 1500 },
      );
      await say('and the deployment, as a CALM deployment decorator');
      await sh(
        `D=$(curl -s "$HUB/api/calm/namespaces/hackathon/decorators?target=${target}" | jq '.values[-1]')`,
        { after: 300 },
      );
      await sh(
        "curl -s $HUB/api/calm/namespaces/hackathon/decorators/$D | jq '{type, appliesTo, status: .data.status, notes: .data.notes}'",
        { after: 2500 },
      );
    },
    async () => {
      await page.goto(`${HUB}/#/hackathon/architectures/${EVENTS}/1.0.0`);
      await page.getByText('Deployments').first().waitFor({ timeout: 60000 });
      await pause(1500);
      await caption('CALM Hub holds the architecture Backstage generated');
      await pause(4500);
      await page.getByText('Deployments').first().click();
      await pause(1500);
      await caption(
        'and its deployment: the nodes it applies to and the Git commit Flux applied',
      );
      await pause(5500);
    },
  );

  // ---- 9. The app answers
  chapter(8);
  await sh('clear', { after: 300 });
  await sh(
    `k port-forward -n $NS svc/stream-app ${APP_PORT}:8080 >/dev/null 2>&1 &`,
    { after: 2500 },
  );
  await both(
    async () => {
      await sh(
        `curl -s localhost:${APP_PORT}/api/info | jq '{service, pattern, starter, deployRules, topic, broker: .broker.state}'`,
        { after: 2000 },
      );
      for (const text of ['Order 1001 placed', 'Order 1001 paid']) {
        await sh(
          `curl -s -XPOST localhost:${APP_PORT}/api/messages -d '{"text":"${text}"}' | jq -c '{topic, offset, text: .event.text}'`,
          { after: 1200 },
        );
      }
      await sh(
        `curl -s localhost:${APP_PORT}/api/messages | jq -c '.messages[] | {text, offset}'`,
        { after: 1500 },
      );
      await say('Produced to Nisshi and consumed back');
    },
    async () => {
      await page.goto(`${BASE}/catalog/default/component/${EVENTS}`);
      await svgIn();
      const open = page.getByTestId('calm-open-app');
      await scrollTo(open);
      await caption(
        'Open the running app: Backstage reaches it in the cluster',
      );
      await pause(3000);
      await page.goto(await open.getAttribute('href'));
      await page
        .locator('#broker', { hasText: 'connected' })
        .waitFor({ timeout: 120000 });
    },
  );
  await page.reload();
  await page
    .locator('#broker', { hasText: 'connected' })
    .waitFor({ timeout: 120000 });
  await scrollTo(page.locator('#extra'));
  await caption('The events produced from the terminal, in the running app');
  await pause(4000);

  // ---- 10. Network policies, enforced
  chapter(9);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('A pod the architecture does not connect: refused');
      await sh(
        "k run probe -q -n $NS --rm -i --restart=Never --image=busybox:1.36 -- sh -c 'sleep 2; nc -zv -w 3 nisshi-broker 9092'",
        { after: 1500 },
      );
      await say('The same pod, labelled as the stream-app node: allowed');
      await sh(
        "k run probe -q -n $NS --rm -i --restart=Never --image=busybox:1.36 -l calm.finos.org/node=stream-app -- sh -c 'sleep 2; nc -zv -w 3 nisshi-broker 9092'",
        { after: 2500 },
      );
    },
    async () => {
      await page.goBack();
      await svgIn();
      await scrollTo(page.getByTestId('calm-deployment'));
      await caption(
        'Only the relationships in the architecture are allowed; everything else is denied',
      );
    },
  );

  // ---- 11. Nisshi keeps its topics in PostgreSQL
  chapter(10);
  await sh('clear', { after: 300 });
  await caption(
    'PostgreSQL was the storage chosen in the form; the deployment rules pointed Nisshi at it',
  );
  await say('Nisshi keeps the topic and its events in PostgreSQL');
  await sh(
    `k exec -n $NS deploy/broker-postgres -- psql -U postgres -c "select t.name as topic, t.partitions, count(r.*) as events from topic t join topition p on p.topic = t.id left join record r on r.topition = p.id group by 1, 2"`,
    { after: 2500 },
  );
  await sh(
    `k exec -n $NS deploy/broker-postgres -- psql -U postgres -c "select offset_id as offset, convert_from(v, 'UTF8')::json->>'text' as event from record order by 1"`,
    { after: 4000 },
  );
  await sh('kill %1', { after: 3000 });
  const duration = (Date.now() - t0) / 1000;

  // ---- Save the two videos and join them side by side.
  const tPath = await term.video().path();
  const bPath = await page.video().path();
  await T.context.close();
  await B.context.close();
  await browser.close();
  ttyd.kill();
  const out = path.join(OUT, 'calm-backstage-cluster-demo.mp4');
  const at = created => ((t0 - created) / 1000).toFixed(2);
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      at(T.created),
      '-i',
      tPath,
      '-ss',
      at(B.created),
      '-i',
      bPath,
      '-filter_complex',
      '[0:v]setpts=PTS-STARTPTS,fps=25[t];[1:v]setpts=PTS-STARTPTS,fps=25[b];[t][b]hstack=inputs=2,format=yuv420p[v]',
      '-map',
      '[v]',
      '-t',
      duration.toFixed(2),
      '-c:v',
      'libx264',
      '-crf',
      '20',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: 'inherit' },
  );
  fs.writeFileSync(
    path.join(OUT, 'chapters.json'),
    `${JSON.stringify(marks, null, 2)}\n`,
  );
  console.log('video:', out);
  console.log('chapters:', JSON.stringify(marks));
})().catch(async e => {
  console.error(e);
  await onFailure().catch(() => {});
  process.exit(1);
});
