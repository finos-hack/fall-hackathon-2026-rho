// Records docs/demo/calm-backstage-demo.webm: catalog, architecture page, catalog graph, pattern page, then creates
// a service from the pattern and opens its page.
//
// Needs the Hub (yarn hub:up && yarn hub:seed) and Backstage (yarn start) running. Creates output/<service-name>,
// so pick a name that is not there yet.
//
//   node docs/demo/record-demo.cjs [service-name] [base-url]
//
// Defaults: inventory-api, http://localhost:3100. Prints the path of the recorded .webm (in a temp folder).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { chromium } = createRequire(path.resolve(__dirname, '../../package.json'))('playwright');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-demo-'));
const NAME = process.argv[2] || 'inventory-api';
const BASE = process.argv[3] || 'http://localhost:3100';
const W = 1440, H = 900;

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: S, size: { width: W, height: H } } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const pause = ms => page.waitForTimeout(ms);

  async function caption(text) {
    await page.evaluate(t => {
      let el = document.getElementById('__demo_caption');
      if (!el) {
        el = document.createElement('div');
        el.id = '__demo_caption';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: 99999,
          background: 'rgba(20,24,33,0.88)', color: '#fff', font: '600 20px/1.35 system-ui, sans-serif',
          padding: '12px 22px', borderRadius: '10px', maxWidth: '80%', textAlign: 'center',
          boxShadow: '0 6px 24px rgba(0,0,0,0.3)', pointerEvents: 'none',
        });
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
  }
  async function scrollBy(total, steps = 12) {
    await page.mouse.move(W / 2, H / 2);
    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, total / steps); await pause(70); }
  }
  async function go(path, waitFor) {
    await page.goto(BASE + path);
    if (waitFor) await waitFor();
    await pause(600);
  }
  const svgIn = () => page.locator('[data-testid="calm-mermaid"] svg').first().waitFor({ timeout: 30000 });
  async function scrollToDiagram() {
    await page.locator('[data-testid="calm-mermaid"]').first().scrollIntoViewIfNeeded();
    await pause(400);
  }

  // 1. Sign in
  await page.goto(BASE + '/');
  const enter = page.getByRole('button', { name: /enter/i });
  await enter.first().waitFor({ timeout: 60000 });
  await caption('CALM Backstage: sign in as a guest');
  await pause(1800);
  await enter.first().click();
  await page.waitForLoadState('networkidle');

  // 2. Catalog
  await go('/?filters%5Bkind%5D=component&filters%5Btags%5D=calm&filters%5Buser%5D=all',
    () => page.getByText('Orders Service').first().waitFor({ timeout: 30000 }));
  await caption('Catalog: CALM architectures from CALM Hub, plus services created from a pattern');
  await pause(3500);
  await go('/?filters%5Bkind%5D=resource&filters%5Buser%5D=all',
    () => page.getByText(/pattern-web-service|Web Service/).first().waitFor({ timeout: 30000 }));
  await caption('Resources: the pattern, its controls and the template bundles');
  await pause(3500);

  // 3. Architecture page
  await go('/catalog/default/component/orders-service', svgIn);
  await caption('Architecture page: orders-service, read live from CALM Hub');
  await pause(2500);
  await scrollToDiagram();
  await caption('The CALM architecture card: pattern, controls and a Mermaid diagram');
  await pause(4000);

  // 4. Catalog graph
  await go('/catalog-graph?rootEntityRefs%5B%5D=component%3Adefault%2Forders-service&maxDepth=3&selectedRelations%5B%5D=dependsOn&selectedKinds%5B%5D=component&selectedKinds%5B%5D=resource&unidirectional=true&mergeRelations=true&direction=LR&showFilters=false',
    async () => { await page.locator('svg').first().waitFor({ timeout: 30000 }); await pause(2000); });
  await caption('Catalog graph: architecture → pattern → controls');
  await pause(3500);

  // 5. Pattern page
  await go('/catalog/default/resource/pattern-web-service', () => page.getByText('Template bundles that fit').waitFor({ timeout: 30000 }));
  await caption('Pattern page: the decisions (oneOf, anyOf) and the bundles that fit');
  await pause(2000);
  await page.getByText('Template bundles that fit').scrollIntoViewIfNeeded();
  await pause(3500);

  // 6. Create from the pattern
  await go('/create', () => page.getByText(/Web Service/).first().waitFor({ timeout: 30000 }));
  await caption('Create: one software template per CALM pattern');
  await pause(3000);
  await go('/create/templates/default/create-from-web-service', () => page.getByLabel(/^Name/).first().waitFor());
  await caption('Step 1: name the new service');
  await pause(1200);
  await page.getByLabel(/^Name/).first().pressSequentially(NAME, { delay: 70 });
  await pause(1000);
  await page.getByRole('button', { name: /^next$/i }).click();

  await page.getByLabel('MongoDB').waitFor();
  await caption("Step 2: the pattern's decisions become form choices");
  await pause(2000);
  await page.getByLabel('MongoDB').check(); await pause(900);
  await page.getByLabel('Message queue (RabbitMQ)').check(); await pause(900);
  await page.getByLabel('Observability (OpenTelemetry)').check(); await pause(900);
  await page.getByLabel('web-service@2.0.0').check(); await pause(1500);
  await page.getByRole('button', { name: /^next$/i }).click();

  const summary = page.getByTestId('calm-placeholders-summary');
  await caption('Step 3: calm generate runs, and the values it leaves open are asked for here');
  await summary.waitFor();
  await pause(2000);
  const inputs = page.locator('input[id^="calm-placeholder-"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const id = await inputs.nth(i).getAttribute('id');
    const v = id.endsWith('/host') ? 'inventory.example.com'
      : id.includes('/nodes/1/interfaces/0/port') ? '443'
      : id.endsWith('/port') ? '8080'
      : id.endsWith('/owner') ? 'team-inventory'
      : id.endsWith('/service-name') ? NAME : 'x';
    await inputs.nth(i).scrollIntoViewIfNeeded();
    await inputs.nth(i).pressSequentially(v, { delay: 40 });
    await pause(300);
  }
  await pause(1200);
  await page.getByRole('button', { name: /^review$/i }).click();
  await caption('Review, then create');
  await pause(3000);
  await page.getByRole('button', { name: /^create$/i }).click();

  // 7. Task run
  await page.waitForURL(/\/tasks\//);
  await caption('The run: generate → fill → validate → template → publish → register');
  await page.getByText('Open the new service in the catalog').waitFor({ timeout: 180000 });
  await pause(3500);

  // 8. New service page
  await page.getByText('Open the new service in the catalog').click();
  await svgIn();
  await caption(`The new service ${NAME} in the catalog, with its own architecture diagram`);
  await pause(2500);
  await scrollToDiagram();
  await pause(4500);
  await caption('CALM pattern → Backstage service, end to end');
  await pause(2500);

  const video = page.video();
  await context.close();
  console.log('video:', await video.path());
  await browser.close();
})().catch(async e => { console.error('FAILED', e); process.exit(1); });
