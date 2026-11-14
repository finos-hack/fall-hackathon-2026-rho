// Records the full demo (parts 1, 2 and 3) as one video that opens with a table of contents: CALM in the catalog,
// the Template Explorer, a Spring Boot, a Red Hat Quarkus and a Nisshi service created from CALM patterns and deployed
// through Git and Flux, each opened as a running app, then an upgrade of the code and the deployment rules through a
// pull request.
//
// Needs the stack running: yarn hub:up && yarn hub:seed, yarn k8s:up, and Backstage (yarn start). Writes
// <out>/calm-backstage-full-demo.webm and <out>/chapters.json (each chapter's start, in seconds).
//
//   node docs/demo/record-full-demo.cjs [suffix] [out-dir] [base-url]
//
// The services are orders-<suffix> (Spring Boot), billing-<suffix> (Red Hat Quarkus) and events-<suffix> (Nisshi);
// pick a suffix not used yet (default demo). Defaults: out-dir = a new temp folder, base-url http://localhost:3100.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { chromium } = createRequire(path.resolve(__dirname, '../../package.json'))('playwright');

const SUFFIX = process.argv[2] || 'demo';
const OUT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'calm-demo-'));
const BASE = process.argv[4] || 'http://localhost:3100';
const BACKEND = BASE.replace(/:3100$/, ':7107').replace(/:3200$/, ':7207');
const HUB = 'http://localhost:8090';
const GITEA = 'http://localhost:3300';
const SPRING = `orders-${SUFFIX}`;
const QUARKUS = `billing-${SUFFIX}`;
const EVENTS = `events-${SUFFIX}`;
const W = 1440, H = 900;

const CHAPTERS = [
  ['CALM in the catalog', 'Architectures, patterns and controls from CALM Hub; an architecture and its pattern'],
  ['The Template Explorer', 'Starters and deployment rules: what is inside each OCI bundle, its source in Git, what changed'],
  ['Create a Spring Boot service', 'From the web-service pattern, deployed through Git and Flux, opened as a running app'],
  ['Red Hat build of Quarkus', 'The same pattern with another starter: built and run on Red Hat UBI images'],
  ['Event streaming with Nisshi', 'A second CALM pattern: a Kafka-compatible broker with a storage choice, events round-trip'],
  ['Git, Flux and CALM Hub', 'The service repositories, the template sources, and the deployments CALM Hub records'],
  ['Upgrade code and deployment rules', 'Spring Boot 4.0.9 → 4.1.2 and k8s-deploy 1.0.0 → 1.2.1 through a pull request'],
  ['Who uses what', 'Back in the Template Explorer: every service and the bundle versions it runs'],
];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
  const page = await context.newPage();
  const t0 = Date.now();
  const marks = [];
  page.setDefaultTimeout(60000);
  const pause = ms => page.waitForTimeout(ms);
  const log = m => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${m}`);

  async function caption(text) {
    await page.evaluate(t => {
      let el = document.getElementById('__demo_caption');
      if (!el) {
        el = document.createElement('div');
        el.id = '__demo_caption';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: 99999,
          background: 'rgba(20,24,33,0.9)', color: '#fff', font: '600 20px/1.35 system-ui, sans-serif',
          padding: '12px 22px', borderRadius: '10px', maxWidth: '82%', textAlign: 'center',
          boxShadow: '0 6px 24px rgba(0,0,0,0.3)', pointerEvents: 'none',
        });
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
  }
  const card = (inner) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#121826;color:#eef2f8;
      font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    main{width:1060px} h1{font-size:46px;margin:0 0 6px;letter-spacing:-.01em} .sub{color:#9fb0c8;font-size:21px;margin:0 0 30px}
    ol{margin:0;padding:0;list-style:none;display:grid;gap:12px} li{display:grid;grid-template-columns:54px 1fr;align-items:baseline}
    .n{font:700 22px ui-monospace,Menlo,monospace;color:#7aa2ff} .t{font-size:23px;font-weight:650} .d{color:#9fb0c8;font-size:17px;grid-column:2}
    .big{font:800 120px/1 ui-monospace,Menlo,monospace;color:#7aa2ff;margin-bottom:14px}
  </style></head><body><main>${inner}</main></body></html>`;
  async function contents() {
    await page.setContent(card(`<h1>CALM + Backstage + template bundles</h1>
      <p class="sub">From a CALM pattern to a running, upgradable service. Contents:</p>
      <ol>${CHAPTERS.map(([t, d], i) => `<li><span class="n">${i + 1}</span><span class="t">${t}</span><span class="d">${d}</span></li>`).join('')}</ol>`));
    await pause(9000);
  }
  async function chapter(i) {
    marks.push({ chapter: i + 1, title: CHAPTERS[i][0], start: Math.round((Date.now() - t0) / 1000) });
    log(`chapter ${i + 1}: ${CHAPTERS[i][0]}`);
    await page.setContent(card(`<div class="big">${i + 1}</div><h1>${CHAPTERS[i][0]}</h1><p class="sub">${CHAPTERS[i][1]}</p>`));
    await pause(3200);
  }
  async function go(p, waitFor) {
    await page.goto(p.startsWith('http') ? p : BASE + p);
    if (waitFor) await waitFor();
    await pause(700);
  }
  async function scrollBy(total, steps = 12) {
    await page.mouse.move(W / 2, H / 2);
    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, total / steps); await pause(70); }
  }
  /** Scrolls a locator into view; tries again while the page re-renders it. */
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
  const svgIn = () => page.locator('[data-testid="calm-mermaid"] svg').first().waitFor({ timeout: 60000 });

  /** Starts a Template run through the scaffolder API as the guest (for a service made while another one builds). */
  async function startTask(template, values) {
    const token = (await (await fetch(`${BACKEND}/api/auth/guest/refresh`)).json()).backstageIdentity.token;
    const res = await fetch(`${BACKEND}/api/scaffolder/v2/tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateRef: `template:default/${template}`, values }),
    });
    const { id } = await res.json();
    if (!id) throw new Error(`could not start ${template}: ${res.status}`);
    return id;
  }
  /** Fills the CalmPlaceholders field. */
  async function fillPlaceholders(name, topic) {
    await page.getByTestId('calm-placeholders-summary').waitFor({ timeout: 60000 });
    await pause(1500);
    const inputs = page.locator('input[id^="calm-placeholder-"]');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const id = await inputs.nth(i).getAttribute('id');
      const v = id.endsWith('/host') ? `${name}.example.com`
        : id.includes('/nodes/1/interfaces/0/port') ? '443'
        : id.endsWith('/port') ? '8080'
        : id.endsWith('/owner') ? 'team-payments'
        : id.endsWith('/topic') ? topic
        : id.endsWith('/service-name') ? name : 'x';
      await inputs.nth(i).scrollIntoViewIfNeeded();
      await inputs.nth(i).pressSequentially(v, { delay: 30 });
    }
    await pause(800);
  }
  /** On a service page: the app URL behind "Open the running app" (opened in this tab, so it stays in the video). */
  async function openApp() {
    const btn = page.getByTestId('calm-open-app');
    await scrollTo(btn);
    await pause(1800);
    const href = await btn.getAttribute('href');
    await page.goto(href);
    await page.locator('#status-text', { hasText: /^Running$/ }).waitFor({ timeout: 60000 });
    await pause(1200);
  }

  // ---- Sign in, contents
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /enter/i }).first().waitFor({ timeout: 60000 });
  await contents();
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /enter/i }).first().click();
  await page.waitForLoadState('networkidle');

  // ---- 1. CALM in the catalog
  await chapter(0);
  await go('/?filters%5Bkind%5D=component&filters%5Btags%5D=calm-architecture&filters%5Buser%5D=all',
    () => page.getByText('Orders Service').first().waitFor({ timeout: 60000 }));
  await caption('Backstage reads CALM architectures from CALM Hub into its catalog');
  await pause(3500);
  await go('/?filters%5Bkind%5D=resource&filters%5Btags%5D=calm-pattern&filters%5Buser%5D=all',
    () => page.getByText(/Event Streaming/).first().waitFor({ timeout: 60000 }));
  await caption('Two CALM patterns: a web service, and event streaming with Nisshi');
  await pause(3500);
  await go('/catalog/default/component/orders-service', svgIn);
  await scrollTo(page.locator('[data-testid="calm-mermaid"]').first());
  await caption('An architecture page: its pattern, its controls and its diagram, live from CALM Hub');
  await pause(4500);
  await go('/catalog/default/resource/pattern-web-service', () => page.getByText('Template bundles that fit').waitFor({ timeout: 60000 }));
  await caption("A pattern's decisions become choices when a developer creates a service");
  await pause(4000);

  // ---- 2. The Template Explorer
  await chapter(1);
  await go('/calm-templates', () => page.getByTestId('calm-explorer-bundles').waitFor());
  await caption('The Template Explorer: every template bundle in the OCI registry');
  await pause(3500);
  await page.getByText('spring-boot-service 1.1.0').first().click();
  await page.getByTestId('calm-explorer-files').waitFor();
  await caption('A starter is the code a service begins with: here Spring Boot, as an OCI artifact');
  await pause(2500);
  await page.getByTestId('calm-explorer-files').getByText('pom.xml.hbs').click();
  await page.getByTestId('calm-explorer-file').waitFor();
  await caption('What is inside: the files it renders from the CALM architecture');
  await pause(4000);
  await page.getByText('k8s-deploy 1.2.1').first().click();
  await pause(1200);
  await caption('Deployment rules are separate: written once by the platform team, used by every starter');
  await pause(3500);
  await page.getByRole('tab', { name: 'Changes' }).click();
  await page.getByTestId('calm-explorer-diff').getByRole('button').first().click();
  await page.getByRole('option', { name: '1.0.0' }).click();
  await page.getByTestId('calm-explorer-diff').getByText('k8s-deploy-transformer.js').first().waitFor({ timeout: 60000 });
  await caption('From 1.0.0 to 1.2.1: limits, liveness probes, no service-account tokens, Nisshi 0.8.2, one pod at a time for data');
  await scrollTo(page.getByTestId('calm-explorer-diff').getByText('k8s-deploy-transformer.js').first());
  await pause(5000);
  const source = await page.getByText(/calm-templates\/bundles at/).first().getAttribute('href');
  await page.goto(source);
  await pause(1500);
  await caption('Each version links to its source in Git (a local Gitea standing in for GitHub): change it here');
  await pause(4500);

  // ---- 3. Spring Boot service
  await chapter(2);
  await go('/create/templates/default/create-from-web-service', () => page.getByLabel(/^Name/).first().waitFor());
  await caption('Create a service from the web-service pattern');
  await page.getByLabel(/^Name/).first().pressSequentially(SPRING, { delay: 60 });
  await pause(800);
  await page.getByRole('button', { name: /^next$/i }).click();
  await page.getByLabel('PostgreSQL').waitFor();
  await page.getByLabel('PostgreSQL').check(); await pause(700);
  await page.getByLabel(/^spring-boot-service 1\.0\.0/).check(); await pause(700);
  await page.getByLabel('k8s-deploy@1.0.0').check(); await pause(500);
  await scrollTo(page.getByLabel('k8s-deploy@1.0.0'));
  await caption('Choices: the data store, the starter (Spring Boot 4.0.9) and the deployment rules (1.0.0)');
  await pause(3500);
  await page.getByRole('button', { name: /^next$/i }).click();
  await caption('calm generate runs; the values it leaves open are asked for here');
  await fillPlaceholders(SPRING);
  await page.getByRole('button', { name: /^review$/i }).click();
  await pause(1500);
  await page.getByRole('button', { name: /^create$/i }).click();
  await page.waitForURL(/\/tasks\//);
  // The Quarkus service is made with the same Template while this one runs (chapter 4 opens it).
  startTask('create-from-web-service', {
    name: QUARKUS, 'datastore-choice': 'PostgreSQL', 'add-ons': [], bundle: 'quarkus-service@1.0.0',
    deployBundle: 'k8s-deploy@1.1.0', deploy: true,
    placeholders: {
      '/nodes/1/interfaces/0/host': `${QUARKUS}.example.com`, '/nodes/1/interfaces/0/port': 443,
      '/nodes/2/metadata/owner': 'team-billing', '/nodes/2/metadata/service-name': QUARKUS,
      '/nodes/2/interfaces/0/port': 8080,
    },
  }).then(id => log(`started ${QUARKUS}: task ${id}`)).catch(e => log(`FAILED to start ${QUARKUS}: ${e.message}`));
  await caption('Generate, validate, store in CALM Hub, render starter and rules, push to Git, build, Flux deploys');
  await page.getByText('Open the new service in the catalog').waitFor({ timeout: 600000 });
  await caption('Done: in Git, deployed by Flux, recorded in CALM Hub');
  await scrollBy(600);
  await pause(4000);
  await page.getByText('Open the new service in the catalog').click();
  await svgIn();
  await scrollTo(page.getByTestId('calm-versions'));
  await caption('The service page: the bundles it was made with, its Git repository and the commit Flux applied');
  await pause(5000);
  await caption('Open the running app: Backstage reaches it through the cluster, no port-forward');
  await openApp();
  await caption(`${SPRING}: Spring Boot 4.0.9 on Java 21, deployment rules k8s-deploy 1.0.0, its database answers`);
  await pause(6000);

  // ---- 4. Red Hat Quarkus
  await chapter(3);
  await go(`/catalog/default/component/${QUARKUS}`, svgIn);
  await scrollTo(page.getByTestId('calm-versions'));
  await caption(`${QUARKUS} was made with the same Template, with the Red Hat build of Quarkus starter`);
  await pause(4500);
  await openApp();
  await caption('Red Hat build of Quarkus 3.33.4, built and run on Red Hat UBI 9 OpenJDK 21 images');
  await pause(6000);

  // ---- 5. Nisshi
  await chapter(4);
  await go('/create/templates/default/create-from-event-streaming', () => page.getByLabel(/^Name/).first().waitFor());
  await caption('A second pattern: event streaming through Nisshi, a Kafka-compatible broker (nisshi.io)');
  await page.getByLabel(/^Name/).first().pressSequentially(EVENTS, { delay: 60 });
  await page.getByRole('button', { name: /^next$/i }).click();
  await page.getByLabel('PostgreSQL').waitFor();
  await caption('The pattern lets the team choose where the broker keeps its topics');
  await pause(2500);
  await page.getByLabel('PostgreSQL').check(); await pause(600);
  await page.getByLabel('k8s-deploy@1.0.0').check(); await pause(1200);
  await page.getByRole('button', { name: /^next$/i }).click();
  await fillPlaceholders(EVENTS, 'orders');
  await page.getByRole('button', { name: /^review$/i }).click();
  await pause(1200);
  await page.getByRole('button', { name: /^create$/i }).click();
  await page.waitForURL(/\/tasks\//);
  await caption('The same steps: Git, build, Flux; the deployment rules add the broker and its PostgreSQL');
  await page.getByText('Open the new service in the catalog').waitFor({ timeout: 600000 });
  await pause(2000);
  await page.getByText('Open the new service in the catalog').click();
  await svgIn();
  await scrollTo(page.locator('[data-testid="calm-mermaid"]').first());
  await caption('Its architecture: stream app → Nisshi broker → PostgreSQL, each with its network policies');
  await pause(4500);
  await openApp();
  await page.locator('#broker', { hasText: 'connected' }).waitFor({ timeout: 120000 });
  await caption('The app is connected to the broker: produce events and watch them come back');
  await scrollTo(page.locator('#extra'));
  await pause(2000);
  for (const text of ['Order 1001 placed', 'Order 1002 paid', 'Order 1001 shipped']) {
    await page.locator('#text').fill(text);
    await page.getByRole('button', { name: 'Produce event' }).click();
    await pause(2200);
  }
  await page.getByText('Order 1001 shipped').nth(1).waitFor({ timeout: 30000 }).catch(() => {});
  await caption('Produced to the topic and consumed back through Nisshi, with PostgreSQL storage');
  await pause(5000);

  // ---- 6. Git, Flux, CALM Hub
  await chapter(5);
  await page.goto(`${GITEA}/calm-services/${SPRING}/commits/branch/main`);
  await pause(1500);
  await caption("The service's Git repository: the code and deploy/ rendered from CALM, then the commit Flux deployed");
  await pause(5500);
  await page.goto(`${GITEA}/calm-services`);
  await pause(1200);
  await caption('One repository per service; Flux in the cluster deploys each from its deploy/k8s-overlay');
  await pause(4500);
  await page.goto(`${HUB}/#/hackathon/architectures/${SPRING}/1.0.0`);
  await page.getByText('Deployments').first().waitFor({ timeout: 60000 });
  await pause(1500);
  await caption('CALM Hub holds the architecture Backstage generated for the service');
  await pause(4000);
  await page.getByText('Deployments').first().click();
  await pause(1500);
  await caption('and the deployment, recorded as a CALM decorator that names the Git commit Flux applied');
  await pause(5500);

  // ---- 7. Upgrade
  await chapter(6);
  await go(`/catalog/default/component/${SPRING}`, svgIn);
  await scrollTo(page.getByTestId('calm-versions'));
  await caption('New versions fit the pattern: Spring Boot 4.1.2 and deployment rules 1.2.1');
  await pause(5000);
  await page.getByTestId('calm-versions').getByText('Upgrade').click();
  await page.getByText('Upgrade the code (starter)').waitFor();
  await caption('One form upgrades the code, the deployment rules, or both');
  await pause(3500);
  await page.getByRole('button', { name: /^review$/i }).click();
  await pause(1500);
  await page.getByRole('button', { name: /^create$/i }).click();
  await page.waitForURL(/\/tasks\//);
  await caption('Re-render on a branch, build the new image, open and merge a pull request, Flux redeploys');
  await page.getByText('Pull request').first().waitFor({ timeout: 600000 });
  await pause(1500);
  await scrollBy(500);
  await caption('Done: the merge commit is what Flux applied, and CALM Hub recorded the new deployment');
  await pause(4000);
  const pr = await page.getByRole('link', { name: 'Pull request' }).first().getAttribute('href');
  await page.goto(pr);
  await pause(1500);
  await caption('The pull request in Git: what changed in the code and in deploy/k8s');
  await pause(4500);
  await page.goto(`${pr}/files`);
  await pause(1500);
  await scrollBy(700);
  await pause(4000);
  await go(`/catalog/default/component/${SPRING}`, svgIn);
  await scrollTo(page.getByTestId('calm-versions'));
  await caption('The service is up to date, at the new commit');
  await pause(4000);
  await openApp();
  await caption('Now running Spring Boot 4.1.2 under the deployment rules k8s-deploy 1.2.1');
  await pause(6000);

  // ---- 8. Who uses what
  await chapter(7);
  await go('/calm-templates', () => page.getByTestId('calm-explorer-bundles').waitFor());
  await page.getByText('k8s-deploy 1.2.1').first().click();
  await page.getByRole('tab', { name: 'Used by' }).click();
  await page.getByTestId('calm-explorer-used-by').waitFor();
  await caption('Which services run which deployment rules, and which can be upgraded');
  await pause(5500);
  await page.getByText('spring-boot-service 1.1.0').first().click();
  await page.getByRole('tab', { name: 'Used by' }).click();
  await pause(1500);
  await caption('CALM says what the system is; Backstage is where the developer works; bundles carry the rules');
  await pause(6000);

  const video = page.video();
  await context.close();
  const target = path.join(OUT, 'calm-backstage-full-demo.webm');
  fs.renameSync(await video.path(), target);
  fs.writeFileSync(path.join(OUT, 'chapters.json'), JSON.stringify(marks, null, 2));
  console.log('video:', target);
  console.log('chapters:', JSON.stringify(marks));
  await browser.close();
})().catch(async e => { console.error('FAILED', e); process.exit(1); });
