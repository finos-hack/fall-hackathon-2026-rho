// Records the deployment extension demo, narrated: a terminal (left) on the local cluster and CALM Hub (right), side
// by side, live, in one take. It starts with CALM Hub as it ships (no extensions), walks through the extension's
// manifest, plugs the extension in, and then deploys a pattern decision from CALM Hub: the request, the firm's
// approval of the pull request, Flux, and the results written back to CALM Hub. Then a version the pattern forbids
// stops at the controls gate, and an agent calls the same extension over MCP.
//
// The voiceover is narration.cjs, spoken by voice.cjs (macOS `say`, or ElevenLabs with DEMO_TTS=elevenlabs); each beat
// is also the caption. Every step is held until
// its beat has been spoken, and the pacing is 3x the first take's (typing, holds and waits).
//
// Patterned on calm-backstage's docs/demo/record-cluster-demo.cjs (ttyd + two Playwright pages + ffmpeg).
//
// Needs: calm-backstage's stack (yarn hub:up && yarn hub:seed, yarn k8s:up) with the service events-stream deployed
// through Flux, this extension's Hub (npm run hub:up) and backend (npm start), ttyd, ffmpeg and jq on the PATH, macOS
// `say`, and calm-backstage's node_modules (for Playwright). Writes <out>/calm-hub-deploy-demo.mp4 (with the
// voiceover), <out>/calm-hub-deploy-demo.srt, <out>/chapters.json and stills.
//
//   node docs/demo/record-hub-demo.cjs [out-dir]               # the take
//   node docs/demo/record-hub-demo.cjs [out-dir] --audio-only  # only speak the beats (cached) and time them
//
// Each take stores two new architecture versions (CALM Hub versions cannot be deleted): one that flips the broker's
// storage between PostgreSQL and SQLite, and one with a connection the pattern forbids. It restarts CALM Hub twice
// (without, then with, the extension) and the backend (manual approval during the take, auto afterwards).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
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
const EXT = `${HUB}/api/calm/extensions/gitops-deploy/api`;
const GITEA = 'http://localhost:3300/api/v1/repos/calm-services';
const NAME = 'events-stream';
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

const CHAPTERS = [
  'CALM Hub on its own',
  'An extension is a manifest and a backend',
  'Plugging it in',
  'CALM Hub hooks in',
  'Where the service runs',
  'An architect changes a pattern decision',
  'Asking CALM Hub to deploy',
  'The firm’s change gate',
  'Flux applies it',
  'The results, back in CALM Hub',
  'The controls gate',
  'The same extension, for an agent',
  'The integration pattern',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
};
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', cwd: DIR, ...opts });
let onFailure = async () => {};

/** What this take deploys: the other storage choice than the one running, as the next version. */
async function plan() {
  const status = await getJson(`${EXT}/namespaces/hackathon/architectures/${NAME}/status`);
  if (!status.managed || !status.ready) throw new Error(`${NAME} is not deployed and ready: ${JSON.stringify(status)}`);
  const running = await getJson(`${HUB}/calm/namespaces/hackathon/architectures/${NAME}/versions/${status.deployedVersion}`);
  const storage = running.relationships.find(r => r['unique-id'] === 'broker-storage')['relationship-type'].options[0].description;
  const choice = storage === 'PostgreSQL' ? 'SQLite on the broker’s volume' : 'PostgreSQL';
  const bump = v => v.replace(/(\d+)$/, n => String(Number(n) + 1));
  const valid = bump(status.latestVersion);
  return { name: NAME, running: status.deployedVersion, storage: storage === 'PostgreSQL' ? 'PostgreSQL' : 'SQLite', choice, valid, invalid: bump(valid) };
}

const srtTime = s => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await plan();
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

  /** Shows an architecture version (hash route: no reload, so no blank frame). */
  const show = async (version, tab) => {
    await page.evaluate(h => (window.location.hash = h), `#/hackathon/architectures/${NAME}/${version}${tab ? `?tab=${tab}` : ''}`);
    await hold(1200);
  };
  /** Fits the diagram to its pane (it opens at the zoom it had, which can cut nodes off). */
  const fit = async () => {
    const button = page.getByRole('button', { name: 'Fit View' });
    if (await button.isVisible().catch(() => false)) await button.click();
    await pause(600);
  };
  const tab = async name => {
    await page.getByRole('tab', { name }).click();
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
  const scroll = async px => {
    await page.mouse.move(BW * ZOOM * 0.6, H * ZOOM * 0.45);
    await page.mouse.wheel(0, px);
    await hold(600);
  };
  const latestPr = async state => (await getJson(`${GITEA}/${NAME}/pulls?state=${state}&limit=1`))[0];
  const collapseSidebar = async () => {
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible().catch(() => false)) await collapse.click();
  };
  const hubUrl = (version, tab) => `${HUB}/#/hackathon/architectures/${NAME}/${version}${tab ? `?tab=${tab}` : ''}`;
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
    await page.getByRole('tab', { name: tabName }).waitFor();
    await collapseSidebar();
    await restoreOverlays();
    await tab(tabName);
  };
  /** The deployment record on the Decorators tab, read again, with its status and notes picked out. */
  const record = async () => {
    await tab('JSON');
    await tab('Decorators');
    await page.getByText('notes', { exact: true }).first().waitFor();
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length === 0 && ['status', 'notes'].includes(el.textContent.trim())) {
          const row = el.parentElement;
          row.style.background = 'rgba(122,162,255,0.18)';
          row.style.outline = '1px solid rgba(122,162,255,0.6)';
          row.style.borderRadius = '6px';
        }
      }
    });
    await hold(300);
  };
  /** The diagram, close enough to read each node's deployment badge. */
  const closeDiagram = async () => {
    await tab('Diagram');
    await page.getByRole('button', { name: 'Zoom In' }).click();
    await hold(300);
  };
  const newest = async version =>
    (await getJson(`${EXT}/history/namespaces/hackathon/architectures/${NAME}/deployments`)).deployments.find(d => d.version === version);

  // ---- Off camera (trimmed): the terminal prompt, CALM Hub on the running version, without extensions.
  await term.goto(`http://127.0.0.1:${TTYD_PORT}/`);
  await until(() => promptCount() > 0, 30000, 'the terminal prompt');
  await page.goto(`${HUB}/#/hackathon/architectures/${NAME}/${ctx.running}`);
  await page.getByRole('tab', { name: 'Decorators' }).waitFor();
  const dark = page.getByRole('button', { name: 'Switch to dark theme' });
  if (await dark.isVisible().catch(() => false)) await dark.click();
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await pause(1500);
  if (await page.getByRole('tab', { name: 'Extensions' }).isVisible()) throw new Error('CALM Hub still shows an Extensions tab');
  await fit();
  await pause(1500);
  const prBefore = await latestPr('all');
  t0 = Date.now();

  // ---- 1. CALM Hub on its own
  await chapter(0);
  await beat('intro');
  await page.screenshot({ path: path.join(OUT, 'hub-before.png') });
  await beat('tabs', async () => {
    await page.getByRole('tab', { name: 'Diagram' }).hover();
    await hold(1500);
    await page.getByRole('tab', { name: 'Decorators' }).hover();
  });
  await beat('registry-before', termBeat('registry-before', `curl -s $HUB/api/calm/extensions | jq -c '.values[] | {id, routes: (.routes | length), contributes: (.contributes | keys)}'`));
  await beat('decorators', () => tab('Decorators'));
  await beat('overlay-before', () => tab('Diagram'));

  // ---- 2. An extension is a manifest and a backend
  await chapter(1);
  await beat('ext-intro', clear);
  await beat('manifest-id', termBeat('manifest-id', `jq '{id, name, version, hubApi}' extension/gitops-deploy/extension.json`));
  await beat('routes-a', termBeat('routes-a', `jq -r '.routes[] | "\\(.method)\\t\\(.scope)\\t\\(.path)"' extension/gitops-deploy/extension.json | column -t`));
  await narrate('routes-b');
  await beat('contributes', clear, termBeat('contributes', `jq -c '.contributes[][]' extension/gitops-deploy/extension.json`));
  await beat('commands', termBeat('commands', `jq -r '.commands | to_entries[] | "\\(.key)  → route \\(.value.route), input: \\(.value.input.required | join(", "))"' extension/gitops-deploy/extension.json`));

  // ---- 3. Plugging it in
  await chapter(2);
  await beat('config', clear, termBeat('config', `grep -E 'calm-extensions|calm-keys|mcp.enabled|backend-url|private-key' hub/compose.override.yml | sed -E 's/^ +(- )?//'`));
  await beat('start-backend', termBeat('start-backend', 'start-extension.sh manual'));
  await beat('restart', termBeat('restart', `scripts/hub-up.sh 2>&1 | grep -E 'Recreated|Started|Waiting'`));
  await narrate('identity');
  await beat('registry-after', clear, termBeat('registry-after', `curl -s $HUB/api/calm/extensions | jq -r '.values[].id'`));
  await beat('jwks', termBeat('jwks', `curl -s $HUB/api/calm/auth/jwks | jq -c '.keys[] | {kty, crv, alg, kid}'`));
  await beat('mcp-tools', termBeat('mcp-tools', 'mcp.sh --list ext_'));

  // ---- 4. CALM Hub hooks in
  await chapter(3);
  await voice;
  await page.reload();
  await page.getByRole('tab', { name: 'Extensions' }).waitFor();
  await collapseSidebar();
  await restoreOverlays();
  await fit();
  await beat('reload', () => page.getByRole('tab', { name: 'Extensions' }).hover());
  await beat('ext-tab', async () => {
    await tab('Extensions');
    await page.getByText('Deployment', { exact: true }).first().waitFor();
  });
  await page.screenshot({ path: path.join(OUT, 'deployment-tab.png') });
  await beat('log-tab', clear, termBeat('log-tab', 'ext-log.sh 2'));
  await narrate('blocks');
  await narrate('fields');

  // ---- 5. Where the service runs
  await chapter(4);
  await beat('deploys', clear, termBeat('deploys', 'k -n $NS get deploy'));
  await beat(
    'status',
    termBeat('status', `curl -s $EXT/namespaces/hackathon/architectures/${NAME}/status | jq '{deployedVersion, latestVersion, deploymentRules, ready}'`),
  );

  // ---- 6. An architect changes a pattern decision
  await chapter(5);
  await beat('pattern', clear);
  await beat('new-version', termBeat('new-version', `npx tsx scripts/new-version.ts hackathon ${NAME} --choose "broker-storage=${ctx.choice}"`));
  await beat('diagram-new', async () => {
    await show(ctx.valid);
    await fit();
  });
  await beat('warning', async () => {
    await tab('Extensions');
    await extensionText(`this page shows ${ctx.valid}`).waitFor();
  });

  // ---- 7. Asking CALM Hub to deploy
  await chapter(6);
  await beat('click', async () => {
    await page.getByRole('button', { name: 'Deploy this version' }).click();
    await page.getByRole('button', { name: 'Run' }).waitFor();
  });
  await narrate('dialog');
  await page.getByRole('button', { name: 'Run' }).click();
  let watching;
  await beat('run', clear, async () => {
    await comment(byId.get('run').term);
    watching = await sh(`UNTIL=approval watch-deploy.sh ${NAME} ${ctx.valid}`, { wait: false });
  }, record);
  await beat('step-validate', record);
  await beat('step-render', record);
  await beat('step-pr', record);
  await watching();
  await beat('waiting', record);
  await beat('log-steps', clear, closeDiagram, termBeat('log-steps', 'ext-log.sh 7'));

  // ---- 8. The firm's change gate (the pull request in Gitea, on the right)
  await chapter(7);
  const pr = await latestPr('open');
  if (!pr || (prBefore && pr.number <= prBefore.number)) throw new Error('no new pull request is open');
  const prPage = `http://localhost:3300/calm-services/${NAME}/pulls/${pr.number}`;
  const [prCommit] = await getJson(`${GITEA}/${NAME}/pulls/${pr.number}/commits`);
  await beat('pr', clear, () => visit(prPage), termBeat('pr', `curl -s "$GITEA/${NAME}/pulls?state=open" | jq -r '.[] | "#\\(.number)  \\(.title)\\n    \\(.head.ref) → \\(.base.ref)"'`));
  await beat('files', () => visit(`${prPage}/files`), termBeat('files', `curl -s $GITEA/${NAME}/pulls/${pr.number}/files | jq -r '.[] | "\\(.filename)  +\\(.additions) -\\(.deletions)"' | column -t`), () => scroll(700));
  await beat('commit', clear, () => visit(`http://localhost:3300/calm-services/${NAME}/commit/${prCommit.sha}`), termBeat('commit', `curl -s $GITEA/${NAME}/pulls/${pr.number}/commits | jq -r '.[0].commit.message'`));
  await beat('gate', () => visit(prPage));
  await beat('approve', termBeat('approve', `approve-pr.sh ${NAME} ${pr.number}`), () => visit(prPage));

  // ---- 9. Flux applies it (back in CALM Hub: the record, then the diagram)
  await chapter(8);
  watching = undefined;
  await beat('flux', clear, async () => {
    watching = await sh(`watch-deploy.sh ${NAME} ${ctx.valid}`, { wait: false });
  }, () => backToHub(ctx.valid, 'Decorators'), record);
  await beat('policies', record);
  await watching();
  log('deployment finished');
  await beat('rollouts', record);
  await beat('overlay-after', closeDiagram);
  await page.screenshot({ path: path.join(OUT, 'diagram-overlay.png') });

  // ---- 10. The results, back in CALM Hub
  await chapter(9);
  await beat('decorators-after', () => tab('Decorators'));
  await narrate('record');
  await beat('deployed', refreshExtensions);
  await beat('history', () => scroll(500));
  const deployed = await newest(ctx.valid);
  const decorator = await getJson(`${HUB}/api/calm/namespaces/hackathon/decorators/${deployed.id}`);
  const jti = decorator.data['hub-audit-id'];
  await beat(
    'audit',
    clear,
    termBeat(
      'audit',
      `curl -s $HUB/api/calm/namespaces/hackathon/decorators/${deployed.id} | jq -r '.data["hub-audit-id"]'`,
      `hub-audit.sh ${jti}`,
    ),
  );
  await narrate('two-ways');

  // ---- 11. The controls gate
  await chapter(10);
  await beat('forbidden', clear, termBeat('forbidden', `npx tsx scripts/new-version.ts hackathon ${NAME} --connect web-client:stream-app`));
  await show(ctx.invalid, 'extensions');
  await extensionText(`this page shows ${ctx.invalid}`).waitFor();
  await beat('deploy-invalid', async () => {
    await page.getByRole('button', { name: 'Deploy this version' }).click();
    await page.getByRole('button', { name: 'Run' }).click();
  });
  await beat('failed', clear, () => sh(`watch-deploy.sh ${NAME} ${ctx.invalid}`));
  await beat(
    'unchanged',
    clear,
    termBeat(
      'unchanged',
      `curl -s "$GITEA/${NAME}/pulls?state=all&limit=1" | jq -r '.[] | "newest pull request: #\\(.number)  \\(.title)"'`,
      `curl -s $EXT/namespaces/hackathon/architectures/${NAME}/status | jq '{deployedVersion, latestVersion}'`,
    ),
  );
  await beat('failed-record', async () => {
    await refreshExtensions();
    await scroll(500);
  });

  // ---- 12. The same extension, for an agent
  await chapter(11);
  await beat(
    'mcp',
    clear,
    termBeat('mcp', `mcp.sh ext_gitops-deploy_history '{"namespace":"hackathon","architecture":"${NAME}"}' | jq -c '.deployments[:3][] | {version, status, requestedBy}'`),
  );
  await narrate('mcp-same');

  // ---- 13. The integration pattern
  await chapter(12);
  await beat('recap-1', async () => {
    await scroll(-1000);
  });
  await narrate('recap-2');
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
