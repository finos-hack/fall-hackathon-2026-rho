// Records the Platform Connector demo, narrated: a terminal (left) on the local cluster and CALM Hub (right), side by
// side, live, in one take. It walks through CALM Hub as it ships (namespaces, a pattern and its decisions, a control,
// an architecture and the built-in deployment records, which are write-only), plugs the Platform Connector in, and
// shows it woven into CALM Hub's screens: the home page card, the Extensions tab and the node sidebar's Platform
// panel. Then drift (a workload scaled behind Git's back), a pattern decision deployed from CALM Hub (the standard
// record, the firm's approval of the pull request, Flux, and CALM Hub validating the record), a version refused at
// the controls gate (a control evaluation) or because it names no pattern, runtime control evidence (the connector's
// sensors turn a connection red on CALM Hub's diagram when its network policy is deleted, and Flux heals it), and an
// agent calling the same connector over MCP.
//
// The voiceover is narration.cjs, spoken by voice.cjs (macOS `say`, or ElevenLabs with DEMO_TTS=elevenlabs); each beat
// is also the caption. Every step is held until its beat has been spoken; the next beat follows after a short, fixed
// GAP, so nothing lingers on screen once a line ends. Typing is 3x the first take's pace. After the take it lists every
// silence longer than SILENCE_LIMIT_S (silences.json), to fix before anyone watches it.
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
//   node docs/demo/record-hub-demo.cjs [out-dir] --captions-only
//       # the take with captions and no voice: the beats are timed by the voice (macOS `say` by default) and the video
//       # has no audio track, for reviewing the story before it is voiced
//
// Each take stores three new architecture versions (CALM Hub versions cannot be deleted): one that flips the broker's
// storage between PostgreSQL and SQLite, one with a connection the pattern forbids, and one that names no pattern. It
// restarts CALM Hub twice (without, then with, the extension) and the backend (manual approval during the take, auto
// afterwards). Off camera it deletes the runtime evidence records earlier runs left (so CALM Hub as it ships shows
// none), and slows Flux's own reconcile of the service for the take (every heal is asked for, with reconcile.sh), then
// restores it. It scales stream-app to 0, deletes two network policies, and asks Flux to put them back. It posts one
// deliberately broken decorator, which CALM Hub refuses.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { createRequire } = require('module');
const narration = require('./narration.cjs');
const { speak, voiceMix } = require('./voice.cjs');

const DIR = path.resolve(__dirname, '../..');
const BACKSTAGE = process.env.CALM_BACKSTAGE_DIR || path.resolve(DIR, '../calm-backstage');
const { chromium } = createRequire(path.join(BACKSTAGE, 'package.json'))('playwright');
const args = process.argv.slice(2);
const AUDIO_ONLY = args.includes('--audio-only');
const CAPTIONS_ONLY = args.includes('--captions-only');
const OUT = args.find(a => !a.startsWith('--')) || fs.mkdtempSync(path.join(os.tmpdir(), 'calm-hub-demo-'));
const KUBECONFIG = process.env.CALM_KUBECONFIG || path.join(BACKSTAGE, '.kube/config');
const HUB = 'http://localhost:8090';
const EXT = `${HUB}/api/calm/extensions/platform-connector/api`;
const GITEA = 'http://localhost:3300/api/v1/repos/calm-services';
const NAME = 'events-stream';
const DRIFT_WORKLOAD = 'stream-app';
const TTYD_PORT = 7682;
const AUDIO_DIR = path.join(DIR, '.work/demo-audio');
// Terminal on the left, CALM Hub on the right: 1920×1080 together. CALM Hub renders at its own size (ZOOM 1: an earlier
// 1.15 rendered more of it, smaller, and was hard to read), with its sidebar collapsed so the diagram and the tab have
// room. Narrower than 1060 px, CALM Hub switches to its compact layout (no tabs, no legend).
const TW = 860,
  BW = 1060,
  H = 1080,
  ZOOM = 1;
// Whichever pane is in use fills the screen; the split screen only when both act at once. Both panes are recorded at
// the full width: CALM Hub is full width for chapters 1-2 (the terminal is not used there), the terminal for
// chapter 3 (CALM Hub is idle there), each at a larger terminal font. Under a chapter card each page shrinks to its
// pane (it then renders in the left part of its recording, which the join crops). The join lays the full-width
// recording over the split screen during its window.
const W = TW + BW;
const TERM_FONT = 16;
const TERM_FONT_FULL = 24;
/** CALM Hub's own A+ setting (diagram text size, 1 to 2): 2 wraps "PostgreSQL" in its node, 1.75 does not. */
const DIAGRAM_TEXT_SCALE = '1.75';
// Pacing: typing and screen holds at 3× the first take (see ~/.claude CLAUDE.md "Demo videos"), but the voice leads:
// a beat lasts as long as its line, and the next follows after the same short GAP everywhere.
const SLOW = 3;
const TYPE_DELAY = 18 * SLOW;
const GAP = 500; // silence after each beat
/** A silence longer than this between two lines is listed after the take (silences.json), to be fixed. */
const SILENCE_LIMIT_S = 1.2;
// Flux would put a scaled workload or a deleted policy back at its own next run (every minute), possibly before the
// take has shown it. For the take its Kustomization runs only every TAKE_FLUX_INTERVAL; every heal is asked for.
const TAKE_FLUX_INTERVAL = '60m';
const FLUX_DEFAULT_INTERVAL = '1m'; // what calm-backstage's k8s/up.sh sets
const BROKEN_POLICY = 'api-gateway-stream-app-ingress';
const SENSOR = 'platform-connector-sensors';

// Each chapter's title (the badge) and what it shows (the contents card at the start).
const CHAPTERS = [
  ['CALM Hub today', 'Namespaces, a pattern and its open decision, a control, an architecture'],
  ['Deployment records are write-only', 'The built-in deployments view, and what a record cannot know'],
  ['A Platform Connector', 'The manifest and the backend; CALM Hub restarted with it'],
  ['Woven in', 'The home page card, the Extensions tab and the node panel'],
  ['Drift: what a record can’t know', 'A workload scaled behind Git’s back, and Flux putting it back'],
  ['A decision changes, and the connector deploys it', 'The controls gate, a pull request, approval, Flux, a validated record'],
  ['The controls gate, as a control evaluation', 'A forbidden connection and a version with no pattern, both refused'],
  ['Runtime sensors and controls', 'Sensors, evidence records, and a deleted network policy turning red'],
  ['The same connector, for an agent', 'Status, history and verify, as MCP tools'],
  ['The pattern', 'What a Platform Connector adds, for any platform'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async (url, init) => {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
};
const postJson = url => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
/**
 * A value read from live data that the take types into the terminal (or puts in a URL): it must have the expected
 * shape, so nothing unexpected is ever typed. Throws early otherwise.
 */
const SHAPES = {
  version: v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v),
  jti: v => typeof v === 'string' && /^[0-9a-f-]{8,64}$/i.test(v),
  integer: v => Number.isSafeInteger(v) && v >= 0,
  sha: v => typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v),
};
const checked = (shape, value, what) => {
  if (!SHAPES[shape](value)) throw new Error(`${what} is not a ${shape}: ${JSON.stringify(value)}`);
  return value;
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
  const runningVersion = checked('version', status.deployedVersion, 'the running version');
  const running = await getJson(`${HUB}/calm/namespaces/hackathon/architectures/${NAME}/versions/${runningVersion}`);
  const storage = running.relationships.find(r => r['unique-id'] === 'broker-storage')['relationship-type'].options[0].description;
  const choice = storage === 'PostgreSQL' ? 'SQLite on the broker’s volume' : 'PostgreSQL';
  const bump = v => v.replace(/(\d+)$/, n => String(Number(n) + 1));
  const valid = checked('version', bump(checked('version', status.latestVersion, 'the latest version')), 'the next version');
  return {
    name: NAME,
    running: runningVersion,
    storage: storage === 'PostgreSQL' ? 'PostgreSQL' : 'SQLite',
    choice,
    valid,
    invalid: checked('version', bump(valid), 'the version after it'),
    nopattern: checked('version', bump(bump(valid)), 'the version that names no pattern'),
    card: await cardCounts(),
  };
}

/** The home page card's counts (its first stats block), as the narration speaks them. */
async function cardCounts() {
  const reply = await getJson(`${EXT}/card`);
  const stats = (reply.blocks ?? []).find(b => b.type === 'stats');
  const value = label => {
    const n = Number(stats?.items?.find(i => i.label === label)?.value);
    if (!Number.isInteger(n)) throw new Error(`the card has no ${label} count: ${JSON.stringify(reply)}`);
    return n;
  };
  return { services: value('Services'), inSync: value('In sync'), drifted: value('Drifted') };
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
  CHAPTERS.forEach((_, i) => used.add(`chapter-${i + 1}`)); // chapter() speaks each chapter's card
  const missing = [...used].filter(id => !ids.has(id));
  const unused = [...ids].filter(id => !used.has(id));
  if (missing.length || unused.length) {
    throw new Error(`narration.cjs and the recorder disagree: no beat for ${missing.join(', ') || '-'}; never spoken: ${unused.join(', ') || '-'}`);
  }
}

/** The Kustomization's own reconcile interval, and setting it (Flux's reconcile requests are unaffected). */
const KS = ['-n', 'flux-system', `kustomization/calm-${NAME}`];
const fluxInterval = async () => (await kubectl(['get', ...KS, '-o', 'jsonpath={.spec.interval}'])).trim();
const setFluxInterval = interval =>
  kubectl(['patch', ...KS, '--type', 'merge', '-p', JSON.stringify({ spec: { interval: interval } })]);

/**
 * Off camera: deletes the runtime evidence records (evidence decorators and the sensors' control evaluations) earlier
 * runs left in CALM Hub, so CALM Hub as it ships shows none. The sensors write fresh ones once the connector runs.
 */
async function deleteRuntimeRecords() {
  // CALM Hub has just been restarted and can reset connections while it starts: retry the whole (idempotent) sweep.
  for (let attempt = 1; ; attempt++) {
    try {
      return await deleteRuntimeRecordsOnce();
    } catch (e) {
      if (attempt >= 30) throw e;
      await sleep(3000);
    }
  }
}

async function deleteRuntimeRecordsOnce() {
  const base = `${HUB}/api/calm/namespaces/hackathon/decorators`;
  let deleted = 0;
  for (const type of ['evidence', 'control-evaluation']) {
    for (const id of (await getJson(`${base}?type=${type}`)).values) {
      const d = await getJson(`${base}/${checked('integer', id, 'a decorator id')}`);
      const by = d.data?.sensor?.name ?? d.data?.engine?.name;
      if (by !== SENSOR) continue;
      const r = await fetch(`${base}/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`could not delete decorator ${id}: ${r.status}`);
      deleted++;
    }
  }
  return deleted;
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
  console.log(`running ${ctx.running} (${ctx.storage}); will store ${ctx.valid} (${ctx.choice}), ${ctx.invalid} (forbidden) and ${ctx.nopattern} (no pattern)`);
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
  console.log(`deleted ${await deleteRuntimeRecords()} runtime evidence records left by earlier runs`);
  let fluxWas = await fluxInterval();
  if (!fluxWas) throw new Error(`could not read the interval of kustomization/calm-${NAME}`);
  if (fluxWas === TAKE_FLUX_INTERVAL) {
    // A take that crashed before restoring it: put back calm-backstage's default rather than keep the take's.
    console.log(`Flux's interval is still the take's ${TAKE_FLUX_INTERVAL}: it will be restored to ${FLUX_DEFAULT_INTERVAL}`);
    fluxWas = FLUX_DEFAULT_INTERVAL;
  }
  const restoreFlux = () =>
    setFluxInterval(fluxWas).catch(e => console.error(`could not restore Flux's interval to ${fluxWas}:`, e.message));
  // From here a failure must put Flux back, even before the browser and terminal exist (onFailure grows later).
  onFailure = restoreFlux;
  await setFluxInterval(TAKE_FLUX_INTERVAL);

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
  const recorded = async (width, dir, zoom = 1, viewportWidth = width) => {
    const context = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: Math.round(viewportWidth * zoom), height: Math.round(H * zoom) },
      recordVideo: { dir: path.join(OUT, dir), size: { width, height: H } },
    });
    const p = await context.newPage();
    return { context, page: p, created: Date.now() };
  };
  // Both start full width (CALM Hub is full screen first, then the terminal); each shrinks to its pane later.
  const T = await recorded(W, 'terminal');
  const B = await recorded(W, 'hub', ZOOM);
  // The full-screen cards (title, contents, a card per chapter): laid over both panes in the join while one is up.
  const S = await recorded(TW + BW, 'slides');
  // CALM Hub keeps the A+ setting in localStorage: set it before any of its pages load.
  await B.context.addInitScript(scale => {
    try {
      localStorage.setItem('calmHub.diagramTextScale', scale);
    } catch {
      // a page without storage (the contents card)
    }
  }, DIAGRAM_TEXT_SCALE);
  const term = T.page;
  const page = B.page;
  const slides = S.page;
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
    await S.context.close();
    await browser.close();
    // Leave the stack as it was: CALM Hub with the extension, the backend on auto approval.
    try {
      run('scripts/hub-up.sh', [], { stdio: 'ignore' });
    } catch {}
    restoreBackend();
    await restoreFlux();
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
  async function sh(cmd, { wait = true, timeout = 300000, after = 1200 } = {}) {
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
  const comment = text => sh(`# ${text}`, { after: 250 });
  // The terminal is a queue: each terminal step starts when the one before has finished. A beat can leave its terminal
  // part running (detach) while the next line is spoken, and whatever is typed next still waits for it. Without this,
  // a slow command (a restart, a rollout) holds the next line back and leaves a silence.
  let termQueue = Promise.resolve();
  let detachedError;
  const inTerminal = fn => {
    const p = termQueue.then(fn);
    termQueue = p.catch(() => {});
    return p;
  };
  /** Resolves when everything queued for the terminal has finished (and throws what a detached step threw). */
  const termIdle = () =>
    inTerminal(() => {
      if (detachedError) throw detachedError;
    });
  /** Queues terminal steps (clear, termBeat) in order, now, and lets the beat end without waiting for them. */
  const detach =
    (...steps) =>
    () => {
      for (const step of steps) step().catch(e => (detachedError ??= e));
    };
  /** Runs a beat's steps at the same time: the terminal and CALM Hub are separate pages. */
  const par =
    (...steps) =>
    () =>
      Promise.all(steps.map(step => step()));
  /** Runs steps one after another (inside par). */
  const seq =
    (...steps) =>
    async () => {
      for (const step of steps) await step();
    };
  const clear = () => inTerminal(() => sh('clear', { after: 300 }));

  // ---- CALM Hub helpers.
  async function overlay(id, text, style, target = page) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await drawOverlay(id, text, style, target);
      } catch (e) {
        // The page navigated under us: wait for it and draw again.
        if (attempt >= 3) throw e;
        await target.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(500);
      }
    }
  }
  async function drawOverlay(id, text, style, target) {
    await target.evaluate(
      ({ id, text, style }) => {
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          document.body.appendChild(el);
        }
        Object.assign(el.style, style);
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
      },
      { id, text, style },
    );
  }
  const CAPTION_STYLE = {
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
    };
  /** The full-width caption: on the cards and on a pane that fills the screen. */
  const WIDE_CAPTION_STYLE = { ...CAPTION_STYLE, font: '500 26px/1.4 system-ui, sans-serif', width: '76%', bottom: '40px', padding: '18px 30px' };
  /**
   * The caption, on CALM Hub, on the cards and on the terminal while it fills the screen (whichever is on screen shows
   * it); full-width style on a full-width page.
   */
  const caption = text =>
    Promise.all([
      overlay('__demo_caption', text, layout.pane === 'hub' ? WIDE_CAPTION_STYLE : CAPTION_STYLE),
      overlay('__demo_caption', text, WIDE_CAPTION_STYLE, slides),
      overlay('__demo_caption', layout.pane === 'term' ? text : '', WIDE_CAPTION_STYLE, term),
    ]);
  const badge = text =>
    Promise.all([badgeOn(page, text), badgeOn(term, layout.pane === 'term' ? text : '')]);
  const badgeOn = (target, text) =>
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
    }, target);
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
      said.push({ id, start: now(), seconds: b.seconds, text: b.text, file: b.file, lufs: b.lufs });
      log(`  "${id}" (${b.seconds.toFixed(1)} s)`);
      await sleep(b.seconds * 1000 + GAP);
    }));
  /** A beat, and its actions one after another while it is spoken; resolves when both are done (no beat is cut off). */
  const beat = async (id, ...actions) => {
    const started = Date.now();
    let lineEnds;
    await Promise.all([
      narrate(id).then(() => (lineEnds = Date.now())),
      (async () => {
        for (const a of actions) await a();
      })(),
    ]);
    // A beat whose actions outlast its line (and the gap) leaves a silence: say by how much, to fix it.
    const over = (Date.now() - lineEnds) / 1000;
    if (over > 0.3) log(`    actions outlast "${id}" by ${over.toFixed(1)} s (beat ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    if (detachedError) throw detachedError;
  };
  /**
   * A beat's terminal part, queued (see inTerminal): its short comment, then its commands. Output stays on screen while
   * the next command is typed, so only the last command is held for long.
   */
  const termBeat = (id, ...cmds) => () =>
    inTerminal(async () => {
      const b = byId.get(id);
      if (b.term) await comment(b.term);
      for (const [i, c] of cmds.entries()) {
        const last = i === cmds.length - 1;
        await (typeof c === 'string' ? sh(c, last ? {} : { after: 400 }) : c());
      }
    });
  /**
   * A chapter opens on its full-screen card while its line (beat chapter-N) says what it will show. `offCamera` steps
   * run under the card (a clear, CALM Hub moving to its first page), so the chapter starts on screen ready.
   */
  const chapter = async (i, ...offCamera) => {
    const [title] = CHAPTERS[i];
    marks.push({ chapter: i + 1, title, start: Math.round(now()) });
    log(`chapter ${i + 1}: ${title}`);
    await slide('chapter', i);
    cardOn();
    lastBadge = `${i + 1} · ${title}`;
    await badge(lastBadge);
    await beat(`chapter-${i + 1}`, ...offCamera);
    cardOff();
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
  /**
   * A CALM Hub or Gitea step that only shows something: on failure it logs a WARNING and the take carries on. Used once
   * the take has stored a version, where a throw would strand state (an open pull request, a job lost when the backend
   * restarts); checks of real state (the record exists, the pull request, completed, refused) still throw.
   */
  const soft = (what, fn) => async () => {
    try {
      await fn();
    } catch (e) {
      log(`WARNING: ${what} (${String(e.message).split('\n')[0]}); carrying on`);
    }
  };
  /** Outlines an element (a legend row, a stat) so the eye finds it. */
  const outline = locator =>
    locator.evaluate(el => {
      el.style.outline = '2px solid rgba(122,162,255,0.9)';
      el.style.outlineOffset = '3px';
      el.style.borderRadius = '6px';
    });
  /** The Control evaluations row of the diagram's legend (to outline it), and its counts as text. */
  const evaluationsLegend = () => page.locator('label', { hasText: 'Control evaluations · Built-in' }).first().locator('xpath=..');
  /**
   * Only that row's counts ("1 Error 2 OK"): the legend's text from its label to its "View all", so the Deployments
   * row's "OK" never counts, however the rows are nested.
   */
  const evaluationCounts = async () => {
    const text = await page.locator('body').innerText();
    return /Control evaluations · Built-in([\s\S]*?)View all/.exec(text)?.[1] ?? '';
  };
  const legendSays = (re, timeout = 20000) =>
    poll(async () => re.test(await evaluationCounts()), timeout, `the Control evaluations counts to match ${re}`);
  /** Runtime evidence for the running version, now: every check holds (verify also records it in CALM Hub). */
  const allHold = async () => {
    const r = await postJson(`${EXT}/namespaces/hackathon/architectures/${NAME}/verify`);
    return r.managed && r.checked > 0 && r.holding === r.checked && !r.problems.length ? r : undefined;
  };
  const drifted = `${DRIFT_WORKLOAD} runs 0 replicas; Git asks for 1`;

  // ---- Full-screen cards (the slides page, laid over both panes while a card is up): the title, the contents, and a
  // card at the start of each chapter. One document; a card is shown by switching classes, so no blank frame.
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const SLIDES = `<!doctype html><html><head><meta charset="utf-8"><title>Cards</title><style>
    html,body{margin:0;height:100%;background:#121826;color:#eef2f8;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    section{position:fixed;inset:0;display:none;padding:0 160px;box-sizing:border-box}
    body[data-card=title] #title, body[data-card=contents] #contents, body[data-card=chapter] #chapter{display:flex}
    .kicker{font:600 22px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.16em;color:#7aa2ff;margin-bottom:28px}
    #title{flex-direction:column;justify-content:center;padding-bottom:120px}
    #title h1{font:750 88px/1.05 system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 30px}
    #title p{font:400 32px/1.45 system-ui,sans-serif;color:#9fb0c8;max-width:1100px;margin:0}
    #contents{flex-direction:column;padding-top:96px}
    #contents h1{font-size:60px;margin:0 0 8px;letter-spacing:-.01em} #contents .sub{color:#9fb0c8;font-size:26px;margin:0 0 44px}
    #contents ol{margin:0;padding:0;list-style:none;display:grid;grid-auto-flow:column;grid-template-rows:repeat(5,auto);
      grid-template-columns:1fr 1fr;gap:18px 48px}
    #contents li{display:grid;grid-template-columns:62px 1fr;align-items:baseline;padding:12px 18px;border-radius:12px;
      transition:opacity .5s,background .5s}
    #contents .n{font:700 28px ui-monospace,Menlo,monospace;color:#7aa2ff} #contents .t{font-size:30px;font-weight:650}
    #contents .d{color:#9fb0c8;font-size:21px;grid-column:2;margin-top:4px}
    #contents.focus li{opacity:.3} #contents.focus li.on{opacity:1;background:rgba(122,162,255,.14)}
    #chapter{flex-direction:column;justify-content:center;padding-bottom:300px}
    #chapter h1{font:750 84px/1.05 system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 28px;max-width:1500px}
    #chapter p{font:400 34px/1.4 system-ui,sans-serif;color:#9fb0c8;max-width:1400px;margin:0}
    #strip{position:absolute;left:160px;right:160px;bottom:215px;display:grid;grid-template-columns:repeat(10,1fr);gap:10px;
      margin:0;padding:0;list-style:none}
    #strip li{border-top:4px solid #2c3850;padding-top:12px;font-size:16px;line-height:1.3;color:#6f7d96}
    #strip li b{display:block;font:700 18px ui-monospace,Menlo,monospace;margin-bottom:4px}
    #strip li.done{border-color:#4a5d86;color:#8d9bb3} #strip li.on{border-color:#7aa2ff;color:#eef2f8}
    #strip li.on b{color:#7aa2ff}
  </style></head><body data-card="title">
    <section id="title"><div class="kicker">CALM HUB</div><h1>A Platform Connector</h1>
      <p>Drift, deployment and runtime control evidence, from the platform itself: GitOps on Kubernetes.</p></section>
    <section id="contents"><h1>Contents</h1><p class="sub">A Platform Connector for CALM Hub: GitOps on Kubernetes</p>
      <ol>${CHAPTERS.map(([t, d], i) => `<li><span class="n">${i + 1}</span><span class="t">${esc(t)}</span><span class="d">${esc(d)}</span></li>`).join('')}</ol></section>
    <section id="chapter"><div class="kicker" id="chapter-kicker"></div><h1 id="chapter-title"></h1><p id="chapter-what"></p>
      <ol id="strip">${CHAPTERS.map(([t], i) => `<li><b>${i + 1}</b>${esc(t)}</li>`).join('')}</ol></section>
  </body></html>`;
  /** Puts up a card on the slides page: title, contents (with the chapters `arg` picked out) or chapter `arg`. */
  const slide = (card, arg) =>
    slides.evaluate(
      ({ card, arg, chapters }) => {
        document.body.dataset.card = card;
        if (card === 'contents') {
          const ol = document.getElementById('contents');
          ol.classList.toggle('focus', arg.length > 0);
          ol.querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', arg.includes(i)));
        }
        if (card === 'chapter') {
          document.getElementById('chapter-kicker').textContent = `CHAPTER ${arg + 1} OF ${chapters.length}`;
          document.getElementById('chapter-title').textContent = chapters[arg][0];
          document.getElementById('chapter-what').textContent = chapters[arg][1];
          document.querySelectorAll('#strip li').forEach((li, i) => {
            li.classList.toggle('on', i === arg);
            li.classList.toggle('done', i < arg);
          });
        }
      },
      { card, arg, chapters: CHAPTERS },
    );
  /**
   * Which pane fills the screen ('hub', 'term', or null for the split screen): windows on the take's clock, laid over
   * the side-by-side video in the join. Switched only while a card is up.
   */
  const layout = { pane: null, windows: [] };
  const fullScreen = pane => {
    const open = layout.windows.at(-1);
    if (open && open.end === undefined) open.end = now();
    layout.pane = pane;
    if (pane) layout.windows.push({ pane, start: now() });
  };
  /** The terminal's font size, and a resize so ttyd fits the terminal (and the shell its columns) to it. */
  const termFont = size =>
    term.evaluate(n => {
      window.term.options.fontSize = n;
      window.dispatchEvent(new Event('resize'));
    }, size);
  /** When a card covers the panes: windows on the take's clock, laid over the side-by-side video in the join. */
  const cards = [];
  const cardOn = () => {
    if (!cards.length || cards.at(-1).end !== undefined) cards.push({ start: now() });
  };
  const cardOff = () => {
    if (cards.length && cards.at(-1).end === undefined) cards.at(-1).end = now();
  };

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
  await slides.setContent(SLIDES);
  await slide('title');
  await termFont(TERM_FONT_FULL);
  await pause(500);
  t0 = Date.now();
  fullScreen('hub');

  // ---- Introduction and contents: full screen (the panes are under the cards until chapter 1's card ends)
  cardOn();
  await beat('intro');
  await beat('contents-1', () => slide('contents', [0, 1]));
  await beat('contents-2', () => slide('contents', [2, 3]));
  await beat('contents-3', () => slide('contents', [4, 5, 6]));
  await beat('contents-4', () => slide('contents', [7, 8, 9]));

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

  // ---- 3. A Platform Connector: the terminal fills the screen (CALM Hub is idle until chapter 4).
  await chapter(2, async () => {
    fullScreen('term');
    await page.setViewportSize({ width: BW, height: H });
    await restoreOverlays();
    await clear();
  });
  await beat(
    'registry-before',
    termBeat('registry-before', `curl -s $HUB/api/calm/extensions | jq -c '.values[] | {id, routes: (.routes | length), contributes: (.contributes | keys)}'`),
  );
  await beat('connector');
  await beat('manifest', termBeat('manifest', `jq '{id, name, provider, hubApi}' $MANIFEST`));
  await beat('routes', termBeat('routes', `jq -r '.routes[] | "\\(.method)\\t\\(.scope)\\t\\(.path)"' $MANIFEST | column -t`));
  await beat('contributes', clear, termBeat('contributes', `jq -c '.contributes | map_values(map(.title))' $MANIFEST`));
  await beat('commands', termBeat('commands', `jq -c '.commands | map_values({route, input: .input.required})' $MANIFEST`));
  // Starting the backend and restarting CALM Hub outlast their lines: they run on under the next lines (signed).
  await beat('start-backend', detach(clear, termBeat('start-backend', 'start-extension.sh manual')));
  await beat('restart', detach(termBeat('restart', `scripts/hub-up.sh 2>&1 | grep -E 'Recreated|Started|Waiting'`)));
  await beat('signed', termIdle);
  await beat('registry-after', termBeat('registry-after', `curl -s $HUB/api/calm/extensions | jq -r '.values[].id'`));
  await beat('mcp-tools', termBeat('mcp-tools', 'mcp.sh --list ext_'));

  // ---- 4. Woven in
  // Under the card: a reload, so CALM Hub's UI reads its extension registry again (a hash-only goto would not reload).
  await chapter(3, async () => {
    // The split screen from here: the terminal back to its pane and font, without chapter 3's output.
    fullScreen(null);
    await term.setViewportSize({ width: TW, height: H });
    await termFont(TERM_FONT);
    await restoreOverlays();
    await inTerminal(() => sh('clear', { after: 300 }));
    await page.goto(`${HUB}/#/`);
    await page.reload();
    await page.getByText('Platform Connector').first().waitFor();
    await restoreOverlays();
  });
  // The narration speaks the counts read before the take: they must still be what the card shows.
  const card = await cardCounts();
  if (JSON.stringify(card) !== JSON.stringify(ctx.card)) {
    throw new Error(`the card now says ${JSON.stringify(card)}, the narration says ${JSON.stringify(ctx.card)}: retake`);
  }
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

  // ---- 5. Drift: what a record can't know (Flux's own reconcile is slowed for the take: it heals when asked)
  await chapter(4);
  await beat('scale', detach(clear, termBeat('scale', () => sh(`k -n $NS scale deploy ${DRIFT_WORKLOAD} --replicas=0`, { after: 500 }))));
  await beat('drift-panel', async () => {
    // The panel is read when the node is selected: only once the scale has run.
    await termIdle();
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
  // The rollout runs on under the next line.
  await beat('reconcile', detach(clear, termBeat('reconcile', `reconcile.sh ${NAME} && k -n $NS rollout status deploy/${DRIFT_WORKLOAD}`)));
  await beat('in-sync', termIdle, () =>
    poll(
      async () => {
        const s = await getJson(`${EXT}/namespaces/hackathon/architectures/${NAME}/status`);
        const w = (s.workloads ?? []).find(x => x.name === DRIFT_WORKLOAD);
        return s.inSync && w && w.ready === 1 && w.replicas === 1;
      },
      120000,
      `${DRIFT_WORKLOAD} to be back to 1/1 and in sync`,
    ), () => selectNode(DRIFT_WORKLOAD, `In sync: ${DRIFT_WORKLOAD} runs as Git asks.`));

  // ---- 6. A decision changes, and the connector deploys it
  await chapter(5, clear);
  await beat('new-version', termBeat('new-version', `new-version.sh ${NAME} --choose "broker-storage=${ctx.choice}"`));
  // From here the take has stored a version: steps that only show something are soft (see soft()), with a shorter wait.
  page.setDefaultTimeout(15000);
  await beat('diagram-new', soft('showing the new version', async () => {
    await closeDetails();
    await show(ctx.valid);
    await fit();
  }));
  // Hard: the page must show the version about to be deployed before Deploy/Run is clicked (no job exists yet).
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
  await beat('run', par(seq(clear, termBeat('run', async () => {
    watching = await sh(`UNTIL=approval watch-deploy.sh ${NAME} ${ctx.valid}`, { wait: false });
  })), soft('the Extensions tab', refreshExtensions)));
  // No record until the version has passed the controls gate (it does while this line is spoken).
  await beat('record-pending', () => poll(async () => typeof (await newest(ctx.valid))?.id === 'number', 180000, `the deployment record on ${ctx.valid}`), soft('the record', record));
  await beat('steps', soft('the record', record));
  await watching();
  await beat('waiting', soft('the record', record));
  await beat('overlay-progress', soft('the in-progress badge', async () => {
    await closeDiagram();
    await viewBadge('Deployments').click({ timeout: 5000 });
  }));

  const pr = await latestPr('open');
  if (!pr || (prBefore && pr.number <= prBefore.number)) throw new Error('no new pull request is open');
  checked('integer', pr.number, 'the pull request number');
  const prPage = `http://localhost:3300/calm-services/${NAME}/pulls/${pr.number}`;
  const [prCommit] = await getJson(`${GITEA}/${NAME}/pulls/${pr.number}/commits`);
  checked('sha', prCommit?.sha, 'the pull request commit');
  await beat('pr', par(soft('the pull request page', () => visit(prPage)), seq(clear, termBeat('pr', `curl -s "$PULLS?state=open" | jq -r '.[] | "#\\(.number)  \\(.title)"'`))));
  await beat('files', par(soft('the files page', seq(() => visit(`${prPage}/files`), () => scroll(700))), termBeat('files', `curl -s $PULLS/${pr.number}/files | jq -r '.[].filename'`)));
  await beat('commit', par(soft('the commit page', () => visit(`http://localhost:3300/calm-services/${NAME}/commit/${prCommit.sha}`)), seq(clear, termBeat('commit', `curl -s $PULLS/${pr.number}/commits | jq -r '.[0].commit.message'`))));
  await beat('approve', soft('the pull request page', () => visit(prPage)), termBeat('approve', `approve-pr.sh ${NAME} ${pr.number}`), soft('the merged pull request', () => visit(prPage)));

  watching = undefined;
  await beat(
    'flux',
    par(
      seq(clear, () =>
        inTerminal(async () => {
          watching = await sh(`watch-deploy.sh ${NAME} ${ctx.valid}`, { wait: false });
        })),
      soft('back to CALM Hub, on the record', async () => {
        await backToHub(ctx.valid, 'Decorators');
        await page.getByText('notes', { exact: true }).first().waitFor();
        await highlight(['status', 'notes']);
      }),
    ),
  );
  // Flux applies the commit and the rollouts finish while this line is spoken.
  await beat('completed', async () => {
    await watching();
    log('deployment finished');
  }, soft('the record', record));
  await beat('overlay-after', soft('the diagram', closeDiagram));
  await soft('the diagram still', () => page.screenshot({ path: path.join(OUT, 'diagram-overlay.png') }))();

  const deployed = await newest(ctx.valid);
  if (deployed?.status !== 'completed') throw new Error(`the deployment of ${ctx.valid} did not complete: ${JSON.stringify(deployed)}`);
  checked('integer', deployed.id, 'the deployment decorator id');
  const decorator = await getJson(`${HUB}/api/calm/namespaces/hackathon/decorators/${deployed.id}`);
  const jti = decorator.data?.gitops?.['hub-audit-id'] ?? decorator.data?.['hub-audit-id'];
  if (!jti) throw new Error(`decorator ${deployed.id} has no hub-audit-id`);
  checked('jti', jti, `the hub-audit-id of decorator ${deployed.id}`);
  await beat(
    'standard-record',
    clear,
    termBeat(
      'standard-record',
      `curl -s $DECORATORS/${deployed.id} | jq '{schema, data: (.data | {status, kubernetes, gitops})}'`,
    ),
  );
  await beat(
    'audit',
    clear,
    // The audit id is in the record on screen (gitops.hub-audit-id).
    termBeat('audit', `hub-audit.sh ${jti}`),
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
    par(seq(termBeat('sub-standard', `curl -s $STANDARDS | jq '.values[] | {name, description}'`)), soft('the Standards tab', () => route('#/namespace/hackathon?type=standards'))),
  );

  // ---- 7. The controls gate, as a control evaluation
  await chapter(6, clear);
  await beat('forbidden', termBeat('forbidden', `new-version.sh ${NAME} --connect web-client:stream-app`));
  await beat('deploy-invalid', soft(`showing ${ctx.invalid}`, async () => {
    await show(ctx.invalid, 'extensions');
    await collapseSidebar();
  }), async () => {
    // Hard: the page must show the version about to be deployed before Deploy/Run is clicked (no job exists yet).
    await extensionText(`this page shows ${ctx.invalid}`).waitFor();
    await page.getByRole('button', { name: 'Deploy this version' }).click();
    await page.getByRole('button', { name: 'Run' }).click();
  });
  /** Waits for the newest attempt to deploy `version` and checks it was refused at the controls gate. */
  const refused = async version => {
    // A job still at the gate has no final status yet: wait for one.
    const final = ['refused', 'completed', 'failed'];
    const attempt = await poll(
      async () => {
        const status = (await newest(version))?.status;
        return final.includes(status) && status;
      },
      60000,
      `the controls gate's answer on ${version}`,
    );
    if (attempt !== 'refused') throw new Error(`${version} was not refused at the controls gate: ${attempt}`);
  };
  // The watch runs on under the next line.
  await beat('refused', detach(clear, termBeat('refused', () => sh(`watch-deploy.sh ${NAME} ${ctx.invalid}`))));
  await beat('evaluation', () => refused(ctx.invalid), soft('the control evaluation overlay', async () => {
    await tab('Diagram');
    // The overlay re-reads decorators every 5 s.
    const evaluated = viewBadge('Control evaluations');
    const seen = () => evaluated.waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (!(await seen())) {
      // Its legend entry may start switched off.
      await page.getByText(/^Control evaluations · Built-in/).first().click({ timeout: 5000 }).catch(() => {});
      if (!(await seen())) log('WARNING: no Control evaluations badge on the diagram');
    }
  }));
  await beat('finding', soft('the control evaluation details', async () => {
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
  }));
  await beat(
    'unchanged',
    termBeat(
      'unchanged',
      `curl -s "$PULLS?state=all&limit=1" | jq -r '.[0].title'`,
      `curl -s $ARCH_API/status | jq '{deployedVersion, inSync}'`,
    ),
  );
  // The status output is short: no clear, the new version's output follows it.
  await beat('no-pattern', termBeat('no-pattern', `new-version.sh ${NAME} --no-pattern`));
  // deploy.sh asks for the deployment as the button does (CALM Hub's extension API) and follows it; CALM Hub shows the
  // control evaluation the refusal records.
  await beat(
    'no-pattern-refused',
    par(
      seq(clear, termBeat('no-pattern-refused', `deploy.sh ${NAME} ${ctx.nopattern}`)),
      seq(() => refused(ctx.nopattern), soft('the refusal’s control evaluation', async () => {
        await show(ctx.nopattern, 'decorators&type=control-evaluation');
        await page.getByText('not-met').first().waitFor({ timeout: 15000 });
        await highlight(['status', 'findings']);
      })),
    ),
  );

  // ---- 8. Controls at runtime: evidence
  // Under the card: every check holds again (after chapter 7), and CALM Hub shows the running version's diagram.
  await chapter(7, () => poll(allHold, 60000, `every runtime check on ${ctx.valid} to hold`), soft('the diagram', async () => {
    await closeDetails();
    await show(ctx.valid);
    await tab('Diagram');
    await legendSays(/OK/);
  }));
  await beat('runtime-gap');
  await beat(
    'sensors',
    clear,
    termBeat('sensors', `k -n $NS get networkpolicies -o custom-columns='NAME:.metadata.name,RELATIONSHIP:.metadata.annotations.calm\\.finos\\.org/relationship'`),
  );
  await beat('evaluations-met', soft('the legend', () => outline(evaluationsLegend())));
  await beat('tab-checks', soft('the runtime checks stat', async () => {
    await refreshExtensions();
    await outline(extensionText('Runtime checks holding').locator('xpath=..'));
  }));
  await beat('break-policy', par(termBeat('break-policy', `k -n $NS delete networkpolicy ${BROKEN_POLICY}`), soft('the diagram', () => tab('Diagram'))));
  await beat('not-met', async () => {
    try {
      await legendSays(/Error/, 30000);
    } catch (e) {
      throw new Error(`the deleted policy did not show as not met (retake): ${e.message}`);
    }
    await soft('the not-met badge', async () => {
      await page.getByRole('button', { name: 'Zoom In' }).click();
      await outline(evaluationsLegend());
    })();
  });
  await beat('panel', soft('the connection', async () => {
    await closeDetails();
    await fit();
    await page.getByText(/^The gateway forwards/).first().click();
    await page.getByText(`${BROKEN_POLICY} is missing`).first().waitFor();
    await scrollAt(BW * ZOOM * 0.85, 250);
    await highlight(['result', 'observed']);
  }));
  await beat('evidence-record', soft('the evidence record', () => highlight(['evidence-paths', 'control-config-url', 'expected'])));
  await beat('valid-until', soft('the evidence record', async () => {
    await scrollAt(BW * ZOOM * 0.85, 300);
    await highlight(['observed-at', 'valid-until', 'sensor']);
  }));
  await beat('evaluation-record', soft('the control evaluation', async () => {
    await scrollAt(BW * ZOOM * 0.85, 450);
    await highlight(['status', 'findings', 'report-uri']);
  }));
  await beat(
    'heal',
    par(termBeat('heal', `reconcile.sh ${NAME}`), soft('the diagram', async () => {
      await closeDetails();
      await fit();
    })),
    soft('the diagram', () => legendSays(/^(?![\s\S]*Error)[\s\S]*OK/)),
  );
  await beat('default-deny', termBeat('default-deny', 'k -n $NS delete networkpolicy default-deny'), soft('the diagram', () => legendSays(/Error(?![\s\S]*OK)/)));
  await beat('heal-all', termBeat('heal-all', `reconcile.sh ${NAME}`), soft('the diagram', () => legendSays(/^(?![\s\S]*Error)[\s\S]*OK/)));

  // ---- 9. The same connector, for an agent
  await chapter(8);
  // $ARCH (demo.rc) is the tools' input: {"namespace":"hackathon","architecture":"events-stream"}.
  await beat(
    'mcp-status',
    par(
      termBeat('mcp-status', `mcp.sh ext_platform-connector_status "$ARCH" | jq '{deployedVersion, inSync, workloads: [.workloads[].name]}'`),
      () => poll(allHold, 60000, `every runtime check on ${ctx.valid} to hold again`),
      soft('the Platform panel', async () => {
        await show(ctx.valid);
        await tab('Diagram');
        await selectNode(DRIFT_WORKLOAD, `In sync: ${DRIFT_WORKLOAD} runs as Git asks.`);
      }),
    ),
  );
  await beat('mcp-history', termBeat('mcp-history', `mcp.sh ext_platform-connector_history "$ARCH" | jq -c '.deployments[:3][] | [.version, .status]'`));
  await beat('mcp-verify', termBeat('mcp-verify', `mcp.sh ext_platform-connector_verify "$ARCH" | jq '{holding, checked, checks: [.checks[].element]}'`));
  await narrate('mcp-same');

  // ---- 10. The pattern
  await chapter(9);
  await beat('recap-1', soft('the home page', async () => {
    await closeDetails();
    await route('#/');
  }));
  await beat('recap-2', soft('the card', () => page.getByText('Platform Connector').first().hover()));
  await narrate('recap-3');
  await termIdle();
  await caption('');
  // Nothing stays on screen after the voice stops: the last line's gap is the end.
  const duration = now();

  // ---- Save the two videos, join them side by side, and lay the voiceover under them.
  const tPath = await term.video().path();
  const bPath = await page.video().path();
  const sPath = await slides.video().path();
  await T.context.close();
  await B.context.close();
  await S.context.close();
  await browser.close();
  ttyd.kill();
  restoreBackend();
  await restoreFlux();

  // Silences: from the end of one line to the start of the next.
  const silences = said
    .slice(1)
    .map((s, i) => ({ after: said[i].id, before: s.id, at: Number((said[i].start + said[i].seconds).toFixed(1)), seconds: Number((s.start - said[i].start - said[i].seconds).toFixed(1)) }))
    .filter(x => x.seconds > SILENCE_LIMIT_S);
  fs.writeFileSync(path.join(OUT, 'silences.json'), `${JSON.stringify(silences, null, 2)}\n`);
  console.log(silences.length ? `${silences.length} silences over ${SILENCE_LIMIT_S} s:` : `no silence over ${SILENCE_LIMIT_S} s`);
  for (const x of silences) console.log(`  ${x.seconds.toFixed(1).padStart(5)} s at ${x.at.toFixed(0)} s, ${x.after} → ${x.before}`);

  const base = CAPTIONS_ONLY ? 'calm-hub-deploy-demo-captions' : 'calm-hub-deploy-demo';
  const out = path.join(OUT, `${base}.mp4`);
  const at = created => ((t0 - created) / 1000).toFixed(2);
  const inputs = CAPTIONS_ONLY ? [] : said.flatMap(s => ['-i', s.file]);
  // Each line at one even level (ElevenLabs clips differ by up to 20 dB): see voiceMix in voice.cjs.
  for (const c of cards) c.end ??= duration;
  const onCard = cards.map(c => `between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})`).join('+') || '0';
  fullScreen(null);
  const onFull = pane =>
    layout.windows.filter(w => w.pane === pane).map(w => `between(t,${w.start.toFixed(2)},${w.end.toFixed(2)})`).join('+') || '0';
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
      '-ss',
      at(S.created),
      '-i',
      sPath,
      ...inputs,
      '-filter_complex',
      [
        // Each pane's recording is full width: its left part is the pane in the split screen; the whole is laid over
        // while that pane fills the screen.
        `[0:v]setpts=PTS-STARTPTS,fps=25,split[tfull][tsrc]`,
        `[tsrc]crop=${TW}:${H}:0:0[t]`,
        `[1:v]setpts=PTS-STARTPTS,fps=25,split[bfull][bsrc]`,
        `[bsrc]crop=${BW}:${H}:0:0[b]`,
        '[2:v]setpts=PTS-STARTPTS,fps=25[s]',
        '[t][b]hstack=inputs=2[tb]',
        `[tb][bfull]overlay=0:0:enable='${onFull('hub')}'[tb1]`,
        `[tb1][tfull]overlay=0:0:enable='${onFull('term')}'[tb2]`,
        `[tb2][s]overlay=0:0:enable='${onCard}',format=yuv420p[v]`,
        ...(CAPTIONS_ONLY ? [] : voiceMix(said, 3)),
      ].join(';'),
      '-map',
      '[v]',
      ...(CAPTIONS_ONLY ? ['-an'] : ['-map', '[aout]']),
      '-t',
      duration.toFixed(2),
      '-c:v',
      'libx264',
      '-crf',
      '20',
      ...(CAPTIONS_ONLY ? [] : ['-c:a', 'aac', '-b:a', '192k']),
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: 'inherit' },
  );
  const srt = said
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.start + s.seconds + 0.3)}\n${s.text}\n`)
    .join('\n');
  fs.writeFileSync(path.join(OUT, `${base}.srt`), srt);
  fs.writeFileSync(path.join(OUT, 'chapters.json'), `${JSON.stringify(marks, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'said.json'), `${JSON.stringify({ said, cards, layout: layout.windows }, null, 2)}\n`);
  console.log('video:', out);
  // What a viewer hears and sees: the level of every line, and a frame per line on contact sheets (check-take.cjs).
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'check-take.cjs'), OUT], { stdio: 'inherit' });
  } catch (e) {
    // A failed check exits 1 after printing why; anything else (the check could not run) says so here.
    console.error(`the take failed its checks (${e.status !== undefined ? `exit ${e.status}` : e.message}): see ${path.join(OUT, 'qa.json')}, or run: node docs/demo/check-take.cjs ${OUT}`);
    process.exitCode = 1;
  }
  console.log('chapters:', marks.map(m => `${Math.floor(m.start / 60)}:${String(m.start % 60).padStart(2, '0')} ${m.title}`).join('\n'));
})().catch(async e => {
  console.error(e);
  await onFailure().catch(() => {});
  process.exit(1);
});
