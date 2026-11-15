// Records the deployment extension demo: a terminal (left) on the local cluster and CALM Hub (right), side by side,
// live, in one take. An architect changes a pattern decision in CALM Hub, deploys the new version from CALM Hub, and
// the terminal watches Git, Flux and the cluster follow; then a version the pattern forbids stops at the controls
// gate; then an agent asks the same extension over MCP.
//
// Patterned on calm-backstage's docs/demo/record-cluster-demo.cjs (ttyd + two Playwright pages + ffmpeg).
//
// Needs: calm-backstage's stack (yarn hub:up && yarn hub:seed, yarn k8s:up) with the service events-stream deployed
// through Flux, this extension's Hub (npm run hub:up) and backend (npm start), ttyd, ffmpeg and jq on the PATH, and
// calm-backstage's node_modules (for Playwright). Writes <out>/calm-hub-deploy-demo.mp4, <out>/chapters.json and two
// stills (deployment-tab.png, diagram-overlay.png).
//
//   node docs/demo/record-hub-demo.cjs [out-dir]
//
// Each take stores two new architecture versions (CALM Hub versions cannot be deleted): one that flips the broker's
// storage between PostgreSQL and SQLite, and one with a connection the pattern forbids.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createRequire } = require('module');

const DIR = path.resolve(__dirname, '../..');
const BACKSTAGE = process.env.CALM_BACKSTAGE_DIR || path.resolve(DIR, '../calm-backstage');
const { chromium } = createRequire(path.join(BACKSTAGE, 'package.json'))('playwright');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'calm-hub-demo-'));
const KUBECONFIG = process.env.CALM_KUBECONFIG || path.join(BACKSTAGE, '.kube/config');
const HUB = 'http://localhost:8090';
const EXT = `${HUB}/api/calm/extensions/gitops-deploy/api`;
const NAME = 'events-stream';
const TTYD_PORT = 7682;
// Terminal on the left, CALM Hub on the right: 1920×1080 together. CALM Hub renders at 1.15× the size it is
// recorded at, with its sidebar collapsed, so the diagram and the tab have room.
const TW = 860,
  BW = 1060,
  H = 1080,
  ZOOM = 1.15;

const CHAPTERS = [
  'CALM Hub with a deployment extension',
  'Where the service runs',
  'An architect changes a pattern decision',
  'Deploy this version, from CALM Hub',
  'Deployed: Git, Flux and the record in CALM Hub',
  'The controls gate',
  'The same extension, for an agent (MCP)',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
};
let onFailure = async () => {};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ---- What this take deploys: the other storage choice than the one running, as the next version.
  const status = await getJson(`${EXT}/namespaces/hackathon/architectures/${NAME}/status`);
  if (!status.managed || !status.ready) throw new Error(`${NAME} is not deployed and ready: ${JSON.stringify(status)}`);
  const running = await getJson(`${HUB}/calm/namespaces/hackathon/architectures/${NAME}/versions/${status.deployedVersion}`);
  const storage = running.relationships.find(r => r['unique-id'] === 'broker-storage')['relationship-type'].options[0].description;
  const choice = storage === 'PostgreSQL' ? 'SQLite on the broker’s volume' : 'PostgreSQL';
  const bump = v => v.replace(/(\d+)$/, n => String(Number(n) + 1));
  const valid = bump(status.latestVersion);
  const invalid = bump(valid);
  console.log(`running ${status.deployedVersion} (${storage}); will store ${valid} (${choice}) and ${invalid} (forbidden)`);

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
      `theme=${JSON.stringify({ background: '#121826', foreground: '#e6ebf2', cursor: '#7aa2ff', blue: '#7aa2ff', brightBlue: '#9ab8ff' })}`,
      'bash',
      '--noprofile',
      '--rcfile',
      path.join(__dirname, 'demo.rc'),
    ],
    {
      env: { ...process.env, CALM_DEMO_DIR: DIR, CALM_DEMO_PROMPTS: prompts, CALM_DEMO_KUBECONFIG: KUBECONFIG },
      stdio: 'ignore',
    },
  );
  process.on('exit', () => ttyd.kill());
  await sleep(1000);

  const browser = await chromium.launch();
  const recorded = async (width, dir, zoom = 1) => {
    const context = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: Math.round(width * zoom), height: Math.round(H * zoom) },
      recordVideo: { dir: path.join(OUT, dir), size: { width, height: H } },
    });
    const p = await context.newPage();
    return { context, page: p, created: Date.now() };
  };
  const T = await recorded(TW, 'terminal');
  const B = await recorded(BW, 'hub', ZOOM);
  const term = T.page;
  const page = B.page;
  onFailure = async () => {
    await term.screenshot({ path: path.join(OUT, 'failed-terminal.png') }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'failed-hub.png') }).catch(() => {});
    await T.context.close();
    await B.context.close();
    await browser.close();
  };
  page.setDefaultTimeout(60000);
  const pause = ms => page.waitForTimeout(ms);
  let t0 = Date.now();
  const marks = [];
  const log = m => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${m}`);
  const chapter = i => {
    marks.push({ chapter: i + 1, title: CHAPTERS[i], start: Math.round((Date.now() - t0) / 1000) });
    log(`chapter ${i + 1}: ${CHAPTERS[i]}`);
  };

  // ---- Terminal: type a command, wait for the prompt to come back (the rc counts prompts in a file).
  async function until(check, timeout, what) {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  }
  async function sh(cmd, { wait = true, timeout = 180000, after = 1200 } = {}) {
    const before = promptCount();
    await term.keyboard.type(cmd, { delay: 18 });
    await sleep(250);
    await term.keyboard.press('Enter');
    const done = () => until(() => promptCount() > before, timeout, cmd);
    if (!wait) return done;
    await done();
    await sleep(after);
    return undefined;
  }
  const say = (text, after = 1200) => sh(`# ${text}`, { after });

  // ---- CALM Hub helpers.
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
          background: 'rgba(20,24,33,0.92)',
          color: '#fff',
          font: '600 19px/1.35 system-ui, sans-serif',
          padding: '12px 22px',
          borderRadius: '10px',
          maxWidth: '86%',
          textAlign: 'center',
          boxShadow: '0 6px 24px rgba(0,0,0,0.3)',
          border: '1px solid rgba(122,162,255,0.4)',
          pointerEvents: 'none',
        });
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
  }
  /** Shows an architecture version (hash route: no reload, so no blank frame). */
  const show = async (version, tab) => {
    await page.evaluate(h => (window.location.hash = h), `#/hackathon/architectures/${NAME}/${version}${tab ? `?tab=${tab}` : ''}`);
    await pause(1200);
  };
  /** Fits the diagram to its pane (it opens at the zoom it had, which can cut nodes off). */
  const fit = async () => {
    const button = page.getByRole('button', { name: 'Fit View' });
    if (await button.isVisible().catch(() => false)) await button.click();
    await pause(600);
  };
  const tab = async name => {
    await page.getByRole('tab', { name }).click();
    await pause(1000);
    if (name === 'Diagram') await fit();
  };
  /** Re-reads the Extensions tab (it loads once when shown). */
  const refreshExtensions = async () => {
    await tab('JSON');
    await tab('Extensions');
    await page.getByText('Deployment', { exact: true }).first().waitFor();
    await pause(800);
  };
  const extensionText = text => page.locator('main, body').getByText(text).first();
  const scrollDown = async px => {
    await page.mouse.move(BW * ZOOM * 0.6, H * ZOOM * 0.5);
    await page.mouse.wheel(0, px);
    await pause(700);
  };

  // ---- Off camera (trimmed): the terminal prompt, CALM Hub on the running version.
  await term.goto(`http://127.0.0.1:${TTYD_PORT}/`);
  await until(() => promptCount() > 0, 30000, 'the terminal prompt');
  await page.goto(`${HUB}/#/hackathon/architectures/${NAME}/${status.deployedVersion}`);
  await page.getByRole('tab', { name: 'Extensions' }).waitFor();
  const dark = page.getByRole('button', { name: 'Switch to dark theme' });
  if (await dark.isVisible().catch(() => false)) await dark.click();
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await pause(1000);
  await fit();
  await pause(1500);
  t0 = Date.now();
  const both = (...parts) => Promise.all(parts.map(f => f()));

  // ---- 1. CALM Hub with a deployment extension
  chapter(0);
  await both(
    async () => {
      await say('CALM Hub has loaded the gitops-deploy extension: its routes and commands');
      await sh(
        `curl -s $HUB/api/calm/extensions | jq '.values[] | select(.id=="gitops-deploy") | {id, routes: [.routes[] | "\\(.method) \\(.path) [\\(.scope)]"], commands: (.commands | keys)}'`,
        { after: 2500 },
      );
    },
    async () => {
      await caption('CALM Hub (right) and a terminal on the local Kubernetes cluster (left)');
      await pause(4500);
      await caption('events-stream: a Nisshi event-streaming service, made from a CALM pattern and deployed by Flux');
      await pause(4500);
      await caption('The Deployments overlay: each deployed node shows the deployment recorded on this version');
      await pause(4000);
    },
  );
  await page.screenshot({ path: path.join(OUT, 'diagram-overlay.png') });

  // ---- 2. Where the service runs
  chapter(1);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say(`The cluster runs version ${status.deployedVersion}: broker storage ${storage}`);
      await sh('k -n $NS get deploy', { after: 1500 });
      await say('The extension reads Git and Flux; the status command, through the CALM Hub proxy');
      await sh(
        `curl -s $EXT/namespaces/hackathon/architectures/${NAME}/status | jq '{deployedVersion, latestVersion, deploymentRules, ready, commit}'`,
        { after: 2500 },
      );
    },
    async () => {
      await tab('Extensions');
      await page.getByText('Deployment', { exact: true }).first().waitFor();
      await caption('The extension adds a Deployment tab and a "Deploy this version" action to every architecture');
      await pause(5000);
      await caption('Where this version runs: the environment, the deployment rules, Flux and the commit it applied');
      await pause(5000);
    },
  );
  await page.screenshot({ path: path.join(OUT, 'deployment-tab.png') });

  // ---- 3. An architect changes a pattern decision
  chapter(2);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say(`An architect changes the pattern's storage decision to ${choice}`);
      await sh(`npx tsx scripts/new-version.ts hackathon ${NAME} --choose "broker-storage=${choice}"`, { after: 2500 });
    },
    async () => {
      await caption('A pattern allows only its decisions to change: here, where the broker keeps its topics');
      await pause(3000);
    },
  );
  await show(valid);
  await fit();
  await caption(`Version ${valid} in CALM Hub: the broker now keeps its topics in ${choice.startsWith('SQLite') ? 'SQLite' : 'PostgreSQL'}`);
  await pause(4500);
  await tab('Extensions');
  await extensionText(`this page shows ${valid}`).waitFor();
  await caption(`The tab warns: the cluster still runs ${status.deployedVersion}`);
  await pause(4500);

  // ---- 4. Deploy this version
  chapter(3);
  await page.getByRole('button', { name: 'Deploy this version' }).click();
  await page.getByRole('button', { name: 'Run' }).waitFor();
  await caption('CALM Hub asks first, checks the caller can write to the namespace, and audits the call');
  await pause(4500);
  await page.getByRole('button', { name: 'Run' }).click();
  const watching = await sh(`watch-deploy.sh ${NAME} ${valid}`, { wait: false });
  await caption('The extension validates the version, re-renders the deployment rules and opens a pull request');
  await pause(3000);
  await tab('Diagram');
  await caption('Every step updates the deployment decorator: the overlay follows it live');
  await watching();
  log('deployment finished');
  await pause(3500);

  // ---- 5. Deployed
  chapter(4);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('A pull request in Gitea, merged; Flux applied the merge commit');
      await sh(
        `curl -s "http://localhost:3300/api/v1/repos/calm-services/${NAME}/pulls?state=closed&limit=3" | jq -r '.[] | "#\\(.number)  \\(.title)  merged: \\(.merged)"'`,
        { after: 1500 },
      );
      await sh('k -n $NS get deploy,networkpolicy', { after: 3000 });
    },
    async () => {
      await tab('Decorators');
      await caption('The record: status, pull request, commit, who asked, and the call\'s id in CALM Hub\'s audit log');
      await pause(6500);
      await refreshExtensions();
      await caption(`The tab now says ${valid} is the version deployed`);
      await pause(3500);
      await scrollDown(500);
      await caption('And lists every deployment of this architecture, from Backstage or from CALM Hub');
      await pause(4000);
    },
  );

  // ---- 6. The controls gate
  chapter(5);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('Now a version the pattern does not allow: the browser talks to the service directly');
      await sh(`npx tsx scripts/new-version.ts hackathon ${NAME} --connect web-client:stream-app`, { after: 2500 });
    },
    async () => {
      await caption('CALM Hub stores any valid CALM document; the pattern is checked when it is deployed');
      await pause(3000);
    },
  );
  await show(invalid, 'extensions');
  await extensionText(`this page shows ${invalid}`).waitFor();
  await caption(`Deploy ${invalid}…`);
  await pause(2500);
  await page.getByRole('button', { name: 'Deploy this version' }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  await sh(`watch-deploy.sh ${NAME} ${invalid}`, { after: 2500 });
  await refreshExtensions();
  await scrollDown(500);
  await caption('Stopped at the controls gate: calm validate failed, so nothing reached Git or the cluster');
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('No new pull request, and the cluster still runs the last good version');
      await sh(
        `curl -s "http://localhost:3300/api/v1/repos/calm-services/${NAME}/pulls?state=all&limit=1" | jq -r '.[] | "latest: #\\(.number)  \\(.title)"'`,
        { after: 1200 },
      );
      await sh(`curl -s $EXT/namespaces/hackathon/architectures/${NAME}/status | jq '{deployedVersion, latestVersion}'`, {
        after: 2500,
      });
    },
    async () => pause(6000),
  );

  // ---- 7. MCP
  chapter(6);
  await both(
    async () => {
      await sh('clear', { after: 300 });
      await say('Each command is also an MCP tool on CALM Hub: what an agent would call');
      await sh(
        `mcp.sh ext_gitops-deploy_history '{"namespace":"hackathon","architecture":"${NAME}"}' | jq -c '.deployments[:3][] | {version, status, requestedBy, notes}'`,
        { after: 4000 },
      );
    },
    async () => {
      await caption('ext_gitops-deploy_status, _history and _deploy: the same scopes, checks and audit as the UI');
      await pause(6000);
      await caption('A firm plugs its own deployment platform into CALM Hub the same way (PROFILE.md)');
      await pause(5000);
    },
  );
  const duration = (Date.now() - t0) / 1000;

  // ---- Save the two videos and join them side by side.
  const tPath = await term.video().path();
  const bPath = await page.video().path();
  await T.context.close();
  await B.context.close();
  await browser.close();
  ttyd.kill();
  const out = path.join(OUT, 'calm-hub-deploy-demo.mp4');
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
  fs.writeFileSync(path.join(OUT, 'chapters.json'), `${JSON.stringify(marks, null, 2)}\n`);
  console.log('video:', out);
  console.log('chapters:', JSON.stringify(marks));
})().catch(async e => {
  console.error(e);
  await onFailure().catch(() => {});
  process.exit(1);
});
