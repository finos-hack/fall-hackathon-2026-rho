// Records the Platform Connector demo, narrated: a terminal (left) on the local cluster and CALM Hub (right), side by
// side, live, in one take. It walks through CALM Hub as it ships (namespaces, a pattern and its decisions, a control,
// an architecture and the built-in deployment records, which are write-only), plugs the Platform Connector in, and
// shows it woven into CALM Hub's screens: the home page card, the Extensions tab and the node sidebar's Platform
// panel. Then drift (a workload scaled behind Git's back), a pattern decision deployed from CALM Hub (the standard
// record, the firm's approval of the pull request, Flux, and CALM Hub validating the record), a version refused at
// the controls gate (a control evaluation), and an agent calling the same connector over MCP.
//
// The voiceover is narration.cjs, spoken by voice.cjs (macOS `say`, or ElevenLabs with DEMO_TTS=elevenlabs); each beat
// is also the caption. Every step is held until its beat has been spoken, and the pacing is 3x the first take's
// (typing, holds and waits).
//
// Patterned on calm-backstage's docs/demo/record-cluster-demo.cjs (ttyd + two Playwright pages + ffmpeg).
//
// Needs: calm-backstage's stack (yarn hub:up && yarn hub:seed, yarn k8s:up) with the service events-stream deployed
// through Flux and in sync, this extension's Hub (npm run hub:up) and backend (npm start), the GitOps sub-standard in
// CALM Hub (npx tsx scripts/publish-standard.ts), ttyd, ffmpeg and jq on the PATH, macOS `say`, and calm-backstage's
// node_modules (for Playwright). Writes <out>/calm-hub-deploy-demo.mp4 (with the voiceover),
// <out>/calm-hub-deploy-demo.srt, <out>/chapters.json and stills.
//
//   node docs/demo/record-hub-demo.cjs [out-dir]               # the take
//   node docs/demo/record-hub-demo.cjs [out-dir] --audio-only  # only speak the beats (cached) and time them
//
// Each take stores two new architecture versions (CALM Hub versions cannot be deleted): one that flips the broker's
// storage between PostgreSQL and SQLite, and one with a connection the pattern forbids. It restarts CALM Hub twice
// (without, then with, the extension) and the backend (manual approval during the take, auto afterwards). It scales
// stream-app to 0 and asks Flux to put it back. It posts one deliberately broken decorator, which CALM Hub refuses.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { createRequire } = require('module');
const narration = require('./narration.cjs');
const { speak } = require('./voice.cjs');

const DIR = path.resolve(__dirname, '../..');
const BACKSTAGE = process.env.CALM_BACKSTAGE_DIR || path.resolve(DIR, '../calm-backstage');
const { chromium } = createRequire(path.join(BACKSTAGE, 'package.json'))('playwright');
const args = process.argv.slice(2);
const AUDIO_ONLY = args.includes('--audio-only');
const OUT = args.find(a => !a.startsWith('--')) || fs.mkdtempSync(path.join(os.tmpdir(), 'calm-hub-demo-'));
const KUBECONFIG = process.env.CALM_KUBECONFIG || path.join(BACKSTAGE, '.kube/config');
const HUB = 'http://localhost:8090';
const EXT = `${HUB}/api/calm/extensions/platform-connector/api`;
const GITEA = 'http://localhost:3300/api/v1/repos/calm-services';
const NAME = 'events-stream';
const DRIFT_WORKLOAD = 'stream-app';
const TTYD_PORT = 7682;
const AUDIO_DIR = path.join(DIR, '.work/demo-audio');
// Terminal on the left, CALM Hub on the right: 1920×1080 together. CALM Hub renders at 1.15× the size it is
// recorded at, with its sidebar collapsed, so the diagram and the tab have room.
const TW = 860,
  BW = 1060,
  H = 1080,
  ZOOM = 1.15;
// Pacing: 3× the first take (see ~/.claude CLAUDE.md "Demo videos"): typing, holds and waits.
const SLOW = 3;
const TYPE_DELAY = 18 * SLOW;
const GAP = 700; // silence after each beat
// Flux reconciles the service every minute (with up to 5% jitter) and puts a scaled workload back. Showing the drift
// takes this long from the start of the scale beat; the take waits for Flux's next run when it is closer than that.
const DRIFT_WINDOW_MS = 35000;
const FLUX_SHORTEST_INTERVAL_MS = 57000;

const CHAPTERS = [
  'CALM Hub today',
  'Deployment records are write-only',
  'A Platform Connector',
  'Woven in',
  'Drift: what a record can’t know',
  'A decision changes, and the connector deploys it',
  'The controls gate, as a control evaluation',
  'The same connector, for an agent',
  'The pattern',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
};
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', cwd: DIR, ...opts });
/** Runs a command without blocking the event loop (the narration and Playwright keep going); resolves with stdout. */
const capture = (cmd, argv) =>
  new Promise((resolve, reject) =>
    execFile(cmd, argv, { cwd: DIR, maxBuffer: 32 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout))),
  );
const kubectl = argv => capture('kubectl', ['--kubeconfig', KUBECONFIG, '--context', 'calm-backstage', ...argv]);
let onFailure = async () => {};

/** What this take deploys: the other storage choice than the one running, as the next version. */
async function plan() {
  const status = await getJson(`${EXT}/namespaces/hackathon/architectures/${NAME}/status`);
  if (!status.managed || !status.ready) throw new Error(`${NAME} is not deployed and ready: ${JSON.stringify(status)}`);
  if (!status.inSync) throw new Error(`${NAME} is not in sync (the drift chapter needs a clean start): ${JSON.stringify(status.drift ?? status.problems)}`);
  const workload = (status.workloads ?? []).find(w => w.name === DRIFT_WORKLOAD);
  if (!workload || workload.desired !== 1) throw new Error(`Git should ask for 1 replica of ${DRIFT_WORKLOAD}: ${JSON.stringify(workload)}`);
  const standards = await getJson(`${HUB}/api/calm/namespaces/hackathon/standards`);
  if (!standards.values.some(s => s.name === 'gitops-deployment')) {
    throw new Error('The GitOps sub-standard is not in CALM Hub: run npx tsx scripts/publish-standard.ts first');
  }
  const running = await getJson(`${HUB}/calm/namespaces/hackathon/architectures/${NAME}/versions/${status.deployedVersion}`);
  const storage = running.relationships.find(r => r['unique-id'] === 'broker-storage')['relationship-type'].options[0].description;
  const choice = storage === 'PostgreSQL' ? 'SQLite on the broker’s volume' : 'PostgreSQL';
  const bump = v => v.replace(/(\d+)$/, n => String(Number(n) + 1));
  const valid = bump(status.latestVersion);
  return { name: NAME, running: status.deployedVersion, storage: storage === 'PostgreSQL' ? 'PostgreSQL' : 'SQLite', choice, valid, invalid: bump(valid) };
}

/**
 * Every beat this recorder speaks is in narration.cjs and every beat there is spoken: fails fast, before anything is
 * touched. Reads the beat ids from this file's own beat(), narrate() and termBeat() calls, so ids stay literals.
 * Also builds the narration for the other storage choice, so both branches of its text are exercised.
 */
function checkBeats(ctx) {
  const other = ctx.choice.startsWith('SQLite')
    ? { ...ctx, storage: 'SQLite', choice: 'PostgreSQL' }
    : { ...ctx, storage: 'PostgreSQL', choice: 'SQLite on the broker’s volume' };
  narration(other);
  const ids = new Set(narration(ctx).map(b => b.id));
  const source = fs.readFileSync(__filename, 'utf-8');
  const used = new Set([...source.matchAll(/\b(?:beat|narrate|termBeat)\(\s*'([a-z0-9-]+)'/g)].map(m => m[1]));
  const missing = [...used].filter(id => !ids.has(id));
  const unused = [...ids].filter(id => !used.has(id));
  if (missing.length || unused.length) {
    throw new Error(`narration.cjs and the recorder disagree: no beat for ${missing.join(', ') || '-'}; never spoken: ${unused.join(', ') || '-'}`);
  }
}

/** When Flux last reconciled calm-<name> (kustomize-controller's log, last 3 minutes), in ms since the epoch. */
async function lastFluxRun() {
  const out = await kubectl(['-n', 'flux-system', 'logs', 'deploy/kustomize-controller', '--since=3m']);
  const times = out
    .split('\n')
    .filter(l => l.includes(`"name":"calm-${NAME}"`) && l.includes('Reconciliation finished'))
    .map(l => {
      try {
        return Date.parse(JSON.parse(l).ts);
      } catch {
        return NaN;
      }
    })
    .filter(t => !Number.isNaN(t));
  return times.length ? Math.max(...times) : undefined;
}

const srtTime = s => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await plan();
  checkBeats(ctx);
  const beats = await speak(narration(ctx), AUDIO_DIR);
  const byId = new Map(beats.map(b => [b.id, b]));
  const spoken = beats.reduce((s, b) => s + b.seconds + GAP / 1000, 0);
  console.log(`running ${ctx.running} (${ctx.storage}); will store ${ctx.valid} (${ctx.choice}) and ${ctx.invalid} (forbidden)`);
  console.log(`${beats.length} beats, ${Math.round(spoken)} s of narration (${(spoken / 60).toFixed(1)} min), ${beats.describe}`);
  if (AUDIO_ONLY) {
    for (const b of beats) console.log(`${b.seconds.toFixed(1).padStart(5)} s  ${b.id}`);
    return;
  }

  // ---- Off camera: CALM Hub as it ships. Stop the backend, restart CALM Hub without the extension.
  try {
    run('pkill', ['-f', `${DIR}/node_modules/.bin/tsx src/main.ts`], { stdio: 'ignore' });
  } catch {
    // not running
  }
  run('scripts/hub-up.sh', ['--without-extensions'], { stdio: 'ignore' });

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
  const restoreBackend = () => {
    try {
      run(path.join(__dirname, 'start-extension.sh'), ['auto'], { stdio: 'ignore' });
    } catch (e) {
      console.error('could not restart the backend with auto approval:', e.message);
    }
  };
  onFailure = async () => {
    await term.screenshot({ path: path.join(OUT, 'failed-terminal.png') }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'failed-hub.png') }).catch(() => {});
    await T.context.close();
    await B.context.close();
    await browser.close();
    // Leave the stack as it was: CALM Hub with the extension, the backend on auto approval.
    try {
      run('scripts/hub-up.sh', [], { stdio: 'ignore' });
    } catch {}
    restoreBackend();
  };
  page.setDefaultTimeout(60000);
  const pause = ms => page.waitForTimeout(ms);
  const hold = ms => pause(ms * SLOW);
  let t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const marks = [];
  const said = [];
  const log = m => console.log(`${now().toFixed(0).padStart(4)}s ${m}`);

  // ---- Terminal: type a command, wait for the prompt to come back (the rc counts prompts in a file).
  async function until(check, timeout, what) {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  }
  async function sh(cmd, { wait = true, timeout = 300000, after = 1200 * SLOW } = {}) {
    const before = promptCount();
    await term.keyboard.type(cmd, { delay: TYPE_DELAY });
    await sleep(250 * SLOW);
    await term.keyboard.press('Enter');
    const done = () => until(() => promptCount() > before, timeout, cmd);
    if (!wait) return done;
    await done();
    await sleep(after);
    return undefined;
  }
  const comment = text => sh(`# ${text}`, { after: 400 * SLOW });
  const clear = () => sh('clear', { after: 300 });

  // ---- CALM Hub helpers.
  async function overlay(id, text, style) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await drawOverlay(id, text, style);
      } catch (e) {
        // The page navigated under us: wait for it and draw again.
        if (attempt >= 3) throw e;
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(500);
      }
    }
  }
  async function drawOverlay(id, text, style) {
    await page.evaluate(
      ({ id, text, style }) => {
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          Object.assign(el.style, style);
          document.body.appendChild(el);
        }
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
      },
      { id, text, style },
    );
  }
  const caption = text =>
    overlay('__demo_caption', text, {
      position: 'fixed',
      left: '50%',
      bottom: '26px',
      transform: 'translateX(-50%)',
      zIndex: 99999,
      background: 'rgba(14,18,28,0.94)',
      color: '#fff',
      font: '500 20px/1.4 system-ui, sans-serif',
      padding: '14px 24px',
      borderRadius: '10px',
      width: '88%',
      textAlign: 'left',
      boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      border: '1px solid rgba(122,162,255,0.45)',
      pointerEvents: 'none',
    });
  const badge = text =>
    overlay('__demo_badge', text, {
      position: 'fixed',
      right: '18px',
      top: '14px',
      zIndex: 99999,
      background: 'rgba(122,162,255,0.95)',
      color: '#0b1020',
      font: '700 17px/1.2 system-ui, sans-serif',
      padding: '8px 14px',
      borderRadius: '8px',
      pointerEvents: 'none',
    });
  /** The overlays are lost when the page reloads: put them back. */
  let lastCaption = '';
  let lastBadge = '';
  const restoreOverlays = async () => {
    await badge(lastBadge);
    await caption(lastCaption);
  };

  // ---- Narration: one beat at a time, in order; the caption shows the words being spoken.
  let voice = Promise.resolve();
  const narrate = id =>
    (voice = voice.then(async () => {
      const b = byId.get(id);
      if (!b) throw new Error(`no beat ${id}`);
      lastCaption = b.text;
      await caption(b.text);
      said.push({ id, start: now(), seconds: b.seconds, text: b.text, file: b.file });
      log(`  "${id}" (${b.seconds.toFixed(1)} s)`);
      await sleep(b.seconds * 1000 + GAP);
    }));
  /** A beat, and its actions one after another while it is spoken; resolves when both are done (no beat is cut off). */
  const beat = (id, ...actions) =>
    Promise.all([
      narrate(id),
      (async () => {
        for (const a of actions) await a();
      })(),
    ]);
  /** A beat whose terminal part starts with its short comment. */
  const termBeat = (id, ...cmds) => async () => {
    const b = byId.get(id);
    if (b.term) await comment(b.term);
    for (const c of cmds) await (typeof c === 'string' ? sh(c) : c());
  };
  const chapter = async i => {
    marks.push({ chapter: i + 1, title: CHAPTERS[i], start: Math.round(now()) });
    log(`chapter ${i + 1}: ${CHAPTERS[i]}`);
    lastBadge = `${i + 1} · ${CHAPTERS[i]}`;
    await badge(lastBadge);
  };

  /** Goes to a CALM Hub route (hash change: no reload, so no blank frame and the overlays stay). */
  const route = async hash => {
    await page.evaluate(h => (window.location.hash = h), hash);
    await hold(600);
  };
  /** Shows an architecture version, optionally on a tab. */
  const show = async (version, tabName) => {
    await route(`#/hackathon/architectures/${NAME}/${version}${tabName ? `?tab=${tabName}` : ''}`);
    await hold(600);
  };
  /** An architecture's own tabs (the node sidebar has a JSON tab of its own, outside the tablist). */
  const mainTab = name => page.getByRole('tablist').getByRole('tab', { name, exact: true });
  /** Fits the diagram to its pane (it opens at the zoom it had, which can cut nodes off). */
  const fit = async () => {
    const button = page.getByRole('button', { name: 'Fit View' });
    if (await button.isVisible().catch(() => false)) await button.click();
    await pause(600);
  };
  const tab = async name => {
    await mainTab(name).click();
    await hold(800);
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
  const scrollAt = async (x, px) => {
    await page.mouse.move(x, H * ZOOM * 0.45);
    await page.mouse.wheel(0, px);
    await hold(600);
  };
  const scroll = px => scrollAt(BW * ZOOM * 0.6, px);
  const latestPr = async state => (await getJson(`${GITEA}/${NAME}/pulls?state=${state}&limit=1`))[0];
  const collapseSidebar = async () => {
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible().catch(() => false)) await collapse.click();
  };
  const hubUrl = (version, tabName) => `${HUB}/#/hackathon/architectures/${NAME}/${version}${tabName ? `?tab=${tabName}` : ''}`;
  /** Leaves CALM Hub for another page (Gitea), keeping the chapter badge and caption on it. */
  const visit = async url => {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await restoreOverlays();
    await hold(400);
  };
  /** Back to CALM Hub on a version and tab, as it was left (dark, sidebar collapsed). */
  const backToHub = async (version, tabName) => {
    await page.goto(hubUrl(version));
    await mainTab(tabName).waitFor();
    await collapseSidebar();
    await restoreOverlays();
    await tab(tabName);
  };
  /** Picks out rows of the Decorators tab by their field names. */
  const highlight = async keys => {
    await page.evaluate(keys => {
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length === 0 && keys.includes(el.textContent.trim())) {
          const row = el.parentElement;
          row.style.background = 'rgba(122,162,255,0.18)';
          row.style.outline = '1px solid rgba(122,162,255,0.6)';
          row.style.borderRadius = '6px';
        }
      }
    }, keys);
  };
  /** The deployment record on the Decorators tab, read again, with its status and notes picked out. */
  const record = async () => {
    await tab('JSON');
    await tab('Decorators');
    await page.getByText('notes', { exact: true }).first().waitFor();
    await highlight(['status', 'notes']);
    await hold(300);
  };
  /** The diagram, close enough to read each node's badge. */
  const closeDiagram = async () => {
    await tab('Diagram');
    await page.getByRole('button', { name: 'Zoom In' }).click();
    await hold(300);
  };
  const closeDetails = async () => {
    const close = page.getByRole('button', { name: 'Close details' });
    if (await close.isVisible().catch(() => false)) {
      await close.click();
      await pause(500);
    }
  };
  const node = id => page.locator(`.react-flow__node[data-id="${id}"]`);
  /**
   * Selects a node so the sidebar opens (and the connector's Platform panel is fetched again: re-clicking a selected
   * node does not fetch it), and waits for `expect` in it.
   */
  const selectNode = async (id, expect, timeout = 30000) => {
    await closeDetails();
    await node(id).click();
    await page.getByText(expect).first().waitFor({ timeout });
    await hold(300);
  };
  /** A built-in view's badge on a node (its aria-label is "<view> · Built-in: <label>"). */
  const viewBadge = (view, id) =>
    (id ? node(id) : page).getByRole('button', { name: new RegExp(`^${view} · Built-in:`) }).first();
  const newest = async version =>
    (await getJson(`${EXT}/history/namespaces/hackathon/architectures/${NAME}/deployments`)).deployments.find(d => d.version === version);
  /** Polls `check` (async) until it gives something truthy. */
  const poll = async (check, timeout, what) => {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await check().catch(() => undefined);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(1000);
    }
  };
  /** Waits, when Flux's next run is too close to show the drift before Flux puts the workload back. */
  const waitForFluxWindow = async () => {
    const last = await lastFluxRun().catch(() => undefined);
    if (last === undefined) {
      log('could not read when Flux last ran: scaling without waiting');
      return;
    }
    if (last + FLUX_SHORTEST_INTERVAL_MS - Date.now() >= DRIFT_WINDOW_MS) return;
    log('Flux runs again soon: waiting for that run before scaling');
    await poll(async () => (await lastFluxRun()) > last, 75000, 'Flux to run');
    await sleep(1500);
  };
  const drifted = `${DRIFT_WORKLOAD} runs 0 replicas; Git asks for 1`;

  // ---- Off camera (trimmed): the terminal prompt, CALM Hub's home page, without extensions.
  await term.goto(`http://127.0.0.1:${TTYD_PORT}/`);
  await until(() => promptCount() > 0, 30000, 'the terminal prompt');
  await page.goto(`${HUB}/#/`);
  await page.locator('a[href="#/namespace/hackathon"]').waitFor();
  const dark = page.getByRole('button', { name: 'Switch to dark theme' });
  if (await dark.isVisible().catch(() => false)) await dark.click();
  await pause(1500);
  if (await page.getByText('Platform Connector').count()) throw new Error('CALM Hub still shows the Platform Connector');
  const prBefore = await latestPr('all');
  t0 = Date.now();

  // ---- 1. CALM Hub today
  await chapter(0);
  await beat('hub-home', () => page.locator('a[href="#/namespace/hackathon"]').hover());
  await beat('namespace', async () => {
    await page.locator('a[href="#/namespace/hackathon"]').click();
    await page.getByRole('tab', { name: /^Patterns/ }).waitFor();
    await hold(800);
  });
  await beat('pattern', async () => {
    await page.getByRole('tab', { name: /^Patterns/ }).click();
    await hold(600);
    await page.getByRole('button', { name: 'Event Streaming (Nisshi)' }).click();
    await page.getByRole('button', { name: 'Show decisions' }).waitFor();
    await fit();
  });
  await beat('decisions', () => page.getByRole('button', { name: 'Show decisions' }).click());
  await beat('control', async () => {
    await page.locator('a[href="#/domain/hackathon-security"]').click();
    await page.getByRole('link', { name: 'Permitted Connection' }).click();
    await page.getByText('Every connection between components must name its protocol').first().waitFor();
  });
  await beat('architecture', async () => {
    await show(ctx.running);
    await mainTab('Diagram').waitFor();
    await collapseSidebar();
    await fit();
    if (await mainTab('Extensions').isVisible()) throw new Error('CALM Hub still shows an Extensions tab');
    await page.screenshot({ path: path.join(OUT, 'hub-before.png') });
  });
  await beat('connection-control', async () => {
    await page.locator('.react-flow__edge[aria-label="Edge from api-gateway to stream-app"]').click({ force: true });
    await page.getByText('Connections must be permitted and encrypted in transit').first().waitFor();
  });
  await beat(
    'registry-before',
    termBeat('registry-before', `curl -s $HUB/api/calm/extensions | jq -c '.values[] | {id, routes: (.routes | length), contributes: (.contributes | keys)}'`),
  );

  // ---- 2. Deployment records are write-only
  await chapter(1);
  await beat('overlay', closeDetails, closeDiagram);
  await beat('badge', () => viewBadge('Deployments', 'stream-app').click());
  await beat('view-all', async () => {
    await page.getByText('View all Deployments', { exact: true }).click();
    await page.waitForURL(/tab=decorators/);
    await page.getByText('notes', { exact: true }).first().waitFor();
    await highlight(['status', 'start-time', 'end-time', 'notes']);
  });
  await narrate('any-tool');
  await beat('write-only', () => scroll(300));

  // ---- 3. A Platform Connector
  await chapter(2);
  await beat('connector', clear);
  await beat('manifest', termBeat('manifest', `jq '{id, name, provider, hubApi}' extension/platform-connector/extension.json`));
  await beat('routes', termBeat('routes', `jq -r '.routes[] | "\\(.method)\\t\\(.scope)\\t\\(.path)"' extension/platform-connector/extension.json | column -t`));
  await beat('contributes', clear, termBeat('contributes', `jq -c '.contributes | to_entries[] | {(.key): [.value[].title]}' extension/platform-connector/extension.json`));
  await beat('commands', termBeat('commands', `jq -r '.commands | to_entries[] | "\\(.key)  → route \\(.value.route), input: \\(.value.input.required | join(", "))"' extension/platform-connector/extension.json`));
  await beat('start-backend', clear, termBeat('start-backend', 'start-extension.sh manual'));
  await beat('restart', termBeat('restart', `scripts/hub-up.sh 2>&1 | grep -E 'Recreated|Started|Waiting'`));
  await narrate('signed');
  await beat('registry-after', clear, termBeat('registry-after', `curl -s $HUB/api/calm/extensions | jq -r '.values[].id'`));
  await beat('mcp-tools', termBeat('mcp-tools', 'mcp.sh --list ext_'));

  // ---- 4. Woven in
  await chapter(3);
  await voice;
  // A reload, so CALM Hub's UI reads its extension registry again (a hash-only goto would not reload).
  await page.goto(`${HUB}/#/`);
  await page.reload();
  await page.getByText('Platform Connector').first().waitFor();
  await restoreOverlays();
  await beat('home-card', () => page.getByText('Platform Connector').first().hover());
  await narrate('blocks');
  await beat('ext-tab', async () => {
    await show(ctx.running, 'extensions');
    await mainTab('Extensions').waitFor();
    await collapseSidebar();
    await page.getByRole('button', { name: 'Deploy this version' }).waitFor();
    await page.getByRole('button', { name: 'Deploy this version' }).hover();
  });
  await beat('tab-facts', async () => {
    await extensionText(`This version (${ctx.running}) is the one running`).waitFor();
    await page.screenshot({ path: path.join(OUT, 'deployment-tab.png') });
  });
  await beat('node-panel', async () => {
    await tab('Diagram');
    await selectNode(DRIFT_WORKLOAD, `In sync: ${DRIFT_WORKLOAD} runs as Git asks.`);
  });
  await beat('node-facts', () => scrollAt(BW * ZOOM * 0.85, 300));
  await beat('log-calls', clear, termBeat('log-calls', 'ext-log.sh 4'));

  // ---- 5. Drift: what a record can't know (quickly: Flux puts the replicas back at its next run)
  await voice;
  await waitForFluxWindow();
  await chapter(4);
  await beat('scale', clear, termBeat('scale', () => sh(`k -n $NS scale deploy ${DRIFT_WORKLOAD} --replicas=0`, { after: 500 })));
  await beat('drift-panel', async () => {
    try {
      await selectNode(DRIFT_WORKLOAD, drifted, 15000);
    } catch (e) {
      throw new Error(`Flux healed ${DRIFT_WORKLOAD} before the drift was shown (retake; nothing else changed): ${e.message}`);
    }
  });
  await beat('drift-tab', async () => {
    await refreshExtensions();
    try {
      await extensionText(drifted).waitFor({ timeout: 15000 });
    } catch (e) {
      throw new Error(`Flux healed ${DRIFT_WORKLOAD} before the drift was shown (retake; nothing else changed): ${e.message}`);
    }
  });
  await beat('badge-stale', async () => {
    await tab('Diagram');
    await page.getByRole('button', { name: 'Zoom In' }).click();
    await viewBadge('Deployments', DRIFT_WORKLOAD).click();
  });
  await beat(
    'reconcile',
    clear,
    termBeat('reconcile', `reconcile.sh ${NAME} && k -n $NS rollout status deploy/${DRIFT_WORKLOAD} --timeout=120s`, `k -n $NS get deploy ${DRIFT_WORKLOAD}`),
  );
  await poll(
    async () => {
      const s = await getJson(`${EXT}/namespaces/hackathon/architectures/${NAME}/status`);
      const w = (s.workloads ?? []).find(x => x.name === DRIFT_WORKLOAD);
      return s.inSync && w && w.ready === 1 && w.replicas === 1;
    },
    120000,
    `${DRIFT_WORKLOAD} to be back to 1/1 and in sync`,
  );
  await beat('in-sync', () => selectNode(DRIFT_WORKLOAD, `In sync: ${DRIFT_WORKLOAD} runs as Git asks.`));

  // ---- 6. A decision changes, and the connector deploys it
  await chapter(5);
  await beat('new-version', clear, termBeat('new-version', `npx tsx scripts/new-version.ts hackathon ${NAME} --choose "broker-storage=${ctx.choice}"`));
  await beat('diagram-new', async () => {
    await closeDetails();
    await show(ctx.valid);
    await fit();
  });
  await beat('warning', async () => {
    await tab('Extensions');
    await extensionText(`this page shows ${ctx.valid}`).waitFor();
  });
  await beat('click', async () => {
    await page.getByRole('button', { name: 'Deploy this version' }).click();
    await page.getByRole('button', { name: 'Run' }).waitFor();
  });
  await page.getByRole('button', { name: 'Run' }).click();
  let watching;
  await beat('run', clear, termBeat('run', async () => {
    watching = await sh(`UNTIL=approval watch-deploy.sh ${NAME} ${ctx.valid}`, { wait: false });
  }), refreshExtensions);
  // No record until the version has passed the controls gate.
  await poll(async () => typeof (await newest(ctx.valid))?.id === 'number', 180000, `the deployment record on ${ctx.valid}`);
  await beat('record-pending', record);
  await beat('steps', record);
  await watching();
  await beat('waiting', record);
  await beat('overlay-progress', closeDiagram, () => viewBadge('Deployments').click());

  const pr = await latestPr('open');
  if (!pr || (prBefore && pr.number <= prBefore.number)) throw new Error('no new pull request is open');
  const prPage = `http://localhost:3300/calm-services/${NAME}/pulls/${pr.number}`;
  const [prCommit] = await getJson(`${GITEA}/${NAME}/pulls/${pr.number}/commits`);
  await beat('pr', clear, () => visit(prPage), termBeat('pr', `curl -s "$GITEA/${NAME}/pulls?state=open" | jq -r '.[] | "#\\(.number)  \\(.title)\\n    \\(.head.ref) → \\(.base.ref)"'`));
  await beat('files', () => visit(`${prPage}/files`), termBeat('files', `curl -s $GITEA/${NAME}/pulls/${pr.number}/files | jq -r '.[] | "\\(.filename)  +\\(.additions) -\\(.deletions)"' | column -t`), () => scroll(700));
  await beat('commit', clear, () => visit(`http://localhost:3300/calm-services/${NAME}/commit/${prCommit.sha}`), termBeat('commit', `curl -s $GITEA/${NAME}/pulls/${pr.number}/commits | jq -r '.[0].commit.message'`));
  await beat('approve', () => visit(prPage), termBeat('approve', `approve-pr.sh ${NAME} ${pr.number}`), () => visit(prPage));

  watching = undefined;
  await beat('flux', clear, async () => {
    watching = await sh(`watch-deploy.sh ${NAME} ${ctx.valid}`, { wait: false });
  }, () => backToHub(ctx.valid, 'Decorators'), record);
  await watching();
  log('deployment finished');
  await beat('completed', record);
  await beat('overlay-after', closeDiagram);
  await page.screenshot({ path: path.join(OUT, 'diagram-overlay.png') });

  const deployed = await newest(ctx.valid);
  if (deployed?.status !== 'completed') throw new Error(`the deployment of ${ctx.valid} did not complete: ${JSON.stringify(deployed)}`);
  const decorator = await getJson(`${HUB}/api/calm/namespaces/hackathon/decorators/${deployed.id}`);
  const jti = decorator.data?.gitops?.['hub-audit-id'] ?? decorator.data?.['hub-audit-id'];
  if (!jti) throw new Error(`decorator ${deployed.id} has no hub-audit-id`);
  await beat(
    'standard-record',
    clear,
    termBeat(
      'standard-record',
      `curl -s $HUB/api/calm/namespaces/hackathon/decorators/${deployed.id} | jq '{"$schema": (.["$schema"] // .schema), data: {status: .data.status, kubernetes: .data.kubernetes, gitops: .data.gitops}}'`,
    ),
  );
  await beat(
    'audit',
    clear,
    termBeat(
      'audit',
      `curl -s $HUB/api/calm/namespaces/hackathon/decorators/${deployed.id} | jq -r '.data.gitops["hub-audit-id"] // .data["hub-audit-id"]'`,
      `hub-audit.sh ${jti}`,
    ),
  );
  const deploymentRecords = async () => (await getJson(`${HUB}/api/calm/namespaces/hackathon/decorators?type=deployment`)).values.length;
  const recordsBefore = await deploymentRecords();
  await beat('validated', clear, termBeat('validated', `broken-copy.sh ${deployed.id}`));
  // broken-copy.sh's exit status does not reach the recorder: count the records instead.
  if ((await deploymentRecords()) !== recordsBefore) {
    log(`WARNING: CALM Hub stored the broken copy of decorator ${deployed.id}: the take shows it accepted; check and retake`);
  }
  await beat(
    'sub-standard',
    clear,
    termBeat('sub-standard', `curl -s $HUB/api/calm/namespaces/hackathon/standards | jq '.values[] | {id, name, description}'`),
    () => route('#/namespace/hackathon?type=standards'),
  );

  // ---- 7. The controls gate, as a control evaluation
  await chapter(6);
  await beat('forbidden', clear, termBeat('forbidden', `npx tsx scripts/new-version.ts hackathon ${NAME} --connect web-client:stream-app`));
  await show(ctx.invalid, 'extensions');
  await collapseSidebar();
  await extensionText(`this page shows ${ctx.invalid}`).waitFor();
  await beat('deploy-invalid', async () => {
    await page.getByRole('button', { name: 'Deploy this version' }).click();
    await page.getByRole('button', { name: 'Run' }).click();
  });
  await beat('refused', clear, termBeat('refused', () => sh(`watch-deploy.sh ${NAME} ${ctx.invalid}`)));
  const refusal = await newest(ctx.invalid);
  if (refusal?.status !== 'refused') throw new Error(`${ctx.invalid} was not refused at the controls gate: ${JSON.stringify(refusal)}`);
  // Not seen live before this take (no control evaluation existed): each step falls back and warns rather than
  // throwing, since the take has already stored its two versions.
  await beat('evaluation', async () => {
    await tab('Diagram');
    // The overlay re-reads decorators every 5 s.
    const evaluated = viewBadge('Control evaluations');
    const seen = () => evaluated.waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (!(await seen())) {
      // Its legend entry may start switched off.
      await page.getByText(/^Control evaluations · Built-in/).first().click({ timeout: 5000 }).catch(() => {});
      if (!(await seen())) log('WARNING: no Control evaluations badge on the diagram');
    }
  });
  await beat('finding', async () => {
    if (await viewBadge('Control evaluations', 'stream-app').click({ timeout: 5000 }).then(() => true, () => false)) {
      await hold(1200);
      const all = page.getByText('View all Control evaluations', { exact: true });
      if (await all.isVisible().catch(() => false)) await all.click().catch(() => {});
    }
    if (!/type=control-evaluation/.test(page.url())) await show(ctx.invalid, 'decorators&type=control-evaluation');
    if (!(await page.getByText('not-met').first().waitFor({ timeout: 15000 }).then(() => true, () => false))) {
      log('WARNING: the control evaluation (not-met) is not on the Decorators tab');
    }
    await highlight(['status', 'findings']);
  });
  await beat(
    'unchanged',
    clear,
    termBeat(
      'unchanged',
      `curl -s "$GITEA/${NAME}/pulls?state=all&limit=1" | jq -r '.[] | "newest pull request: #\\(.number)  \\(.title)"'`,
      `curl -s $EXT/namespaces/hackathon/architectures/${NAME}/status | jq '{deployedVersion, latestVersion, inSync, drift}'`,
    ),
  );

  // ---- 8. The same connector, for an agent
  await chapter(7);
  const mcpArgs = `'{"namespace":"hackathon","architecture":"${NAME}"}'`;
  await beat(
    'mcp-status',
    clear,
    termBeat(
      'mcp-status',
      `mcp.sh ext_platform-connector_status ${mcpArgs} | jq '{deployedVersion, inSync, drift, hubRecord: (.hubRecord | {version, status}), workloads: [.workloads[] | "\\(.name) \\(.ready)/\\(.desired)"]}'`,
    ),
    async () => {
      await show(ctx.valid);
      await tab('Diagram');
      await selectNode(DRIFT_WORKLOAD, `In sync: ${DRIFT_WORKLOAD} runs as Git asks.`);
    },
  );
  await beat(
    'mcp-history',
    termBeat('mcp-history', `mcp.sh ext_platform-connector_history ${mcpArgs} | jq -r '.deployments[:4][] | "\\(.version)  \\(.status)"'`),
  );
  await narrate('mcp-same');

  // ---- 9. The pattern
  await chapter(8);
  await beat('recap-1', closeDetails, () => route('#/'));
  await beat('recap-2', () => page.getByText('Platform Connector').first().hover());
  await narrate('recap-3');
  await caption('');
  await hold(1000);
  const duration = now();

  // ---- Save the two videos, join them side by side, and lay the voiceover under them.
  const tPath = await term.video().path();
  const bPath = await page.video().path();
  await T.context.close();
  await B.context.close();
  await browser.close();
  ttyd.kill();
  restoreBackend();

  const out = path.join(OUT, 'calm-hub-deploy-demo.mp4');
  const at = created => ((t0 - created) / 1000).toFixed(2);
  const inputs = said.flatMap(s => ['-i', s.file]);
  const delays = said.map((s, i) => `[${i + 2}:a]aresample=48000,adelay=delays=${Math.round(s.start * 1000)}:all=1[a${i}]`);
  const mix = `${said.map((_, i) => `[a${i}]`).join('')}amix=inputs=${said.length}:normalize=0:duration=longest,apad[aout]`;
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
      ...inputs,
      '-filter_complex',
      [
        '[0:v]setpts=PTS-STARTPTS,fps=25[t]',
        '[1:v]setpts=PTS-STARTPTS,fps=25[b]',
        '[t][b]hstack=inputs=2,format=yuv420p[v]',
        ...delays,
        mix,
      ].join(';'),
      '-map',
      '[v]',
      '-map',
      '[aout]',
      '-t',
      duration.toFixed(2),
      '-c:v',
      'libx264',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: 'inherit' },
  );
  const srt = said
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.start + s.seconds + 0.3)}\n${s.text}\n`)
    .join('\n');
  fs.writeFileSync(path.join(OUT, 'calm-hub-deploy-demo.srt'), srt);
  fs.writeFileSync(path.join(OUT, 'chapters.json'), `${JSON.stringify(marks, null, 2)}\n`);
  console.log('video:', out);
  console.log('chapters:', marks.map(m => `${Math.floor(m.start / 60)}:${String(m.start % 60).padStart(2, '0')} ${m.title}`).join('\n'));
})().catch(async e => {
  console.error(e);
  await onFailure().catch(() => {});
  process.exit(1);
});
