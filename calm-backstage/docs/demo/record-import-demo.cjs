// Records the import demo: a diagram in draw.io, C4 and Mermaid turned into a CALM architecture with the
// "Import a diagram" Template, then shown in the catalog, and a file in the wrong format refused. Narrated
// (import-narration.cjs, spoken by voice.cjs) with the words as captions.
//
// Patterned on calm-hub-deploy-extension/docs/demo/record-hub-demo.cjs (#53): each step is held until its beat has
// been spoken, and after the take the beats are laid under the video at the times they were spoken, which also give
// the .srt. One Playwright page, no terminal.
//
// Needs the stack running (yarn hub:up && yarn hub:seed, then yarn start), ffmpeg on the PATH, macOS
// `say` (or DEMO_TTS=elevenlabs, see voice.cjs), and calm-import built (npm ci in calm-import/).
//
//   node docs/demo/record-import-demo.cjs <suffix> [out-dir] [base-url]
//   node docs/demo/record-import-demo.cjs <suffix> [out-dir] --audio-only   # only speak and time the beats
//
// It imports <suffix>-drawio, <suffix>-c4 and <suffix>-mmd (pick a suffix not used yet: CALM Hub keeps them) and tries
// <suffix>-wrong, which is refused. Writes <out>/calm-import-demo.mp4, calm-import-demo.srt and chapters.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const { chromium } = createRequire(
  path.resolve(__dirname, '../../package.json'),
)('playwright');
const { speak } = require('./voice.cjs');
const narration = require('./import-narration.cjs');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const AUDIO_ONLY = process.argv.includes('--audio-only');
const SUFFIX = args[0];
if (!SUFFIX || !/^[a-z][a-z0-9-]*$/.test(SUFFIX)) {
  console.error(
    'usage: record-import-demo.cjs <suffix> [out-dir] [base-url] [--audio-only]',
  );
  process.exit(2);
}
const OUT =
  args[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'calm-import-demo-'));
const BASE = args[2] || 'http://localhost:3100';
const BACKEND = BASE.replace(/:3100$/, ':7107').replace(/:3200$/, ':7207');
const HUB = 'http://localhost:8090';
const NS = 'hackathon';
const REPO = path.resolve(__dirname, '../../..');
const EXAMPLES = path.join(REPO, 'calm-import/examples');
const FILES = {
  drawio: path.join(EXAMPLES, 'trading.drawio'),
  c4: path.join(EXAMPLES, 'trading.c4.md'),
  mermaid: path.join(EXAMPLES, 'trading.mmd'),
};
const DIAGRAM_PNG = path.join(__dirname, 'calm-import/01-drawio-diagram.png');
const NAMES = {
  drawio: `${SUFFIX}-drawio`,
  c4: `${SUFFIX}-c4`,
  mermaid: `${SUFFIX}-mmd`,
  wrong: `${SUFFIX}-wrong`,
};
const FORMAT = {
  drawio: 'draw.io',
  c4: 'C4 (Mermaid or PlantUML)',
  mermaid: 'Mermaid flowchart',
};
const AUDIO_DIR = path.join(os.tmpdir(), 'calm-import-demo-audio');
const W = 1600;
const H = 900;
const GAP = 450; // silence after each beat, ms

const CHAPTERS = [
  'Diagrams already exist',
  'The diagram',
  'The Template',
  'Import the draw.io file',
  'The same platform in C4',
  'In CALM Hub',
  'Mermaid flowcharts',
  'In the catalog',
  'The wrong file',
  'Recap',
];
// Every beat this recorder speaks, in order. checkBeats() holds it against import-narration.cjs before anything runs.
const SPOKEN = [
  'intro',
  'diagram',
  'template',
  'form',
  'drawio-import',
  'drawio-steps',
  'drawio-result',
  'c4-source',
  'c4-import',
  'c4-result',
  'hub',
  'mermaid',
  'catalog-drawio',
  'catalog-c4',
  'wrong',
  'recap',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const srtTime = s => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(
    Math.floor(ms / 1000) % 60,
  )},${p(ms % 1000, 3)}`;
};

/**
 * The short white flashes of a recording, as [first, last] frame numbers at 25 fps from `offset` seconds: up to 2 s of
 * near-white frames right after a darker one. A white page that stays (CALM Hub's light theme) is longer, so it stays.
 */
function whiteFlashes(video, offset) {
  const stats = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      offset,
      '-i',
      video,
      '-an',
      '-vf',
      'setpts=PTS-STARTPTS,fps=25,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
      '-f',
      'null',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  const white = [...stats.matchAll(/YAVG=([\d.]+)/g)].map(
    m => Number(m[1]) > 180,
  );
  const flashes = [];
  for (let i = 1; i < white.length; i++) {
    if (!white[i] || white[i - 1]) continue;
    let j = i;
    while (j + 1 < white.length && white[j + 1]) j++;
    if (j - i + 1 <= 50) flashes.push([i, j]);
    i = j;
  }
  return flashes;
}

function checkBeats(beats) {
  const ids = beats.map(b => b.id);
  const missing = SPOKEN.filter(id => !ids.includes(id));
  const unused = ids.filter(id => !SPOKEN.includes(id));
  if (missing.length || unused.length || ids.join() !== SPOKEN.join()) {
    throw new Error(
      `narration and recorder disagree: missing ${missing}, unused ${unused}, order ${ids}`,
    );
  }
}

/** What the narration says, worked out from the converter itself: the guesses each sample makes. */
async function plan() {
  const lib = require(path.join(REPO, 'calm-import/dist/index.js'));
  const read = f => fs.readFileSync(f, 'utf8');
  const drawio = await lib.convertDrawio(read(FILES.drawio));
  const c4 = await lib.convertC4(read(FILES.c4));
  for (const [what, r] of [
    ['draw.io', drawio],
    ['C4', c4],
  ]) {
    if (r.nodes !== 7 || r.relationships !== 7) {
      throw new Error(
        `the ${what} sample gives ${r.nodes} nodes and ${r.relationships} relationships; the narration says 7 and 7`,
      );
    }
  }
  return { drawio: drawio.guesses.length, c4: c4.guesses.length };
}

/** Fails before the take if a name is taken in CALM Hub (the Template would refuse it on camera). */
async function checkNamesFree() {
  for (const name of Object.values(NAMES)) {
    const r = await fetch(
      `${HUB}/calm/namespaces/${NS}/architectures/${name}/versions`,
    );
    if (r.ok)
      throw new Error(`${name} is already in CALM Hub: pick another suffix`);
  }
}

async function guestToken() {
  const r = await fetch(`${BACKEND}/api/auth/guest/refresh`);
  if (!r.ok)
    throw new Error(`guest sign-in at ${BACKEND} answered ${r.status}`);
  return (await r.json()).backstageIdentity.token;
}

async function inCatalog(name, token) {
  const r = await fetch(
    `${BACKEND}/api/catalog/entities/by-name/component/default/${name}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  return r.ok;
}

const escapeHtml = s =>
  s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const PAGE_STYLE = `body{margin:0;height:100vh;background:#1e1e1e;color:#e6e6e6;font-family:system-ui,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center}`;
const titleCard =
  () => `<style>${PAGE_STYLE} h1{font-size:64px;margin:0 0 18px} p{font-size:28px;color:#9fb4d8}</style>
  <h1>Import a diagram into CALM</h1><p>draw.io, C4 and Mermaid, from Backstage to CALM Hub</p>`;
const imageCard = (
  file,
  caption,
) => `<style>${PAGE_STYLE} img{max-width:94vw;max-height:82vh;border-radius:8px}
  .f{font:500 22px system-ui;color:#9fb4d8;margin-bottom:14px}</style>
  <div class="f">${escapeHtml(
    caption,
  )}</div><img src="data:image/png;base64,${fs
  .readFileSync(file)
  .toString('base64')}">`;
const sourceCard = (
  file,
  caption,
) => `<style>${PAGE_STYLE} pre{font:20px/1.45 ui-monospace,Menlo,monospace;background:#111;
  padding:28px 36px;border-radius:10px;border:1px solid #333;max-height:70vh;overflow:hidden;margin:0}
  .f{font:500 22px system-ui;color:#9fb4d8;margin-bottom:14px}</style>
  <div class="f">${escapeHtml(caption)}</div><pre>${escapeHtml(
  fs.readFileSync(file, 'utf8').trim(),
)}</pre>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await plan();
  const beats = await speak(narration(ctx), AUDIO_DIR);
  checkBeats(beats);
  const byId = new Map(beats.map(b => [b.id, b]));
  const total = beats.reduce((s, b) => s + b.seconds + GAP / 1000, 0);
  log(
    `${beats.describe}: ${beats.length} beats, ${
      beats.made
    } new, ${total.toFixed(0)} s spoken`,
  );
  if (AUDIO_ONLY) {
    for (const b of beats) log(`  ${b.id}: ${b.seconds.toFixed(1)} s`);
    return;
  }
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  await checkNamesFree();
  let token = await guestToken();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    // Recorded at the page's own size: a larger size would pad the page into the top-left corner, not scale it.
    // ffmpeg scales it to 1920x1080 afterwards.
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  // Backstage's dark theme, as in the screenshots; guest sign-in is remembered by the app.
  await context.addInitScript(base => {
    try {
      localStorage.setItem('theme', 'dark');
    } catch {}
    // Backstage's pages start blank white until it paints: start them dark, as its theme is.
    if (location.origin === base)
      document.documentElement.style.background = '#333';
  }, new URL(BASE).origin);
  const created = Date.now();
  const page = await context.newPage();
  // Backstage's own page: text lookups stay inside it, so they never match the caption or the chapter badge.
  const app = page.locator('#root');
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const said = [];
  const marks = [];

  // ---- Overlays: the caption (the words being spoken) and the chapter badge. A navigation drops them: put them back.
  let lastCaption = '';
  let lastBadge = '';
  const draw = (id, text, style) =>
    page
      .evaluate(
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
      )
      .catch(() => {});
  const caption = text => {
    lastCaption = text;
    return draw('__demo_caption', text, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      zIndex: 99999,
      background: 'rgba(14,18,28,0.94)',
      color: '#fff',
      font: '500 19px/1.4 system-ui, sans-serif',
      padding: '12px 22px',
      borderRadius: '10px',
      width: '86%',
      boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      border: '1px solid rgba(122,162,255,0.45)',
      pointerEvents: 'none',
    });
  };
  const badge = text => {
    lastBadge = text;
    return draw('__demo_badge', text, {
      position: 'fixed',
      right: '18px',
      top: '14px',
      zIndex: 99999,
      background: 'rgba(122,162,255,0.95)',
      color: '#0b1020',
      font: '700 16px/1.2 system-ui, sans-serif',
      padding: '8px 14px',
      borderRadius: '8px',
      pointerEvents: 'none',
    });
  };
  page.on('load', () => {
    badge(lastBadge);
    caption(lastCaption);
  });
  const chapter = async i => {
    marks.push({ start: Math.round(now()), title: CHAPTERS[i] });
    await badge(`${i + 1}. ${CHAPTERS[i]}`);
    log(`chapter ${i + 1}: ${CHAPTERS[i]}`);
  };

  // ---- Narration: one beat at a time, in order; each beat's actions run while it is spoken.
  let voice = Promise.resolve();
  const narrate = id =>
    (voice = voice.then(async () => {
      const b = byId.get(id);
      await caption(b.text);
      said.push({
        start: now(),
        seconds: b.seconds,
        text: b.text,
        file: b.file,
      });
      log(`  "${id}" (${b.seconds.toFixed(1)} s)`);
      await sleep(b.seconds * 1000 + GAP);
    }));
  const beat = (id, ...actions) =>
    Promise.all([
      narrate(id),
      (async () => {
        for (const a of actions) await a();
      })(),
    ]);
  /** A pause with no words: the caption is cleared so it doesn't hang over the pause. */
  const hold = async ms => {
    await voice;
    await caption('');
    await sleep(ms);
  };
  const show = html =>
    page
      .setContent(html, { waitUntil: 'load' })
      .then(() => Promise.all([badge(lastBadge), caption(lastCaption)]));
  const goto = async url => {
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
    await signInIfAsked();
  };
  /** Waits for Backstage to render either its guest sign-in (and enters) or its sidebar (already signed in). */
  async function signInIfAsked() {
    const enter = page.getByRole('button', { name: /^enter$/i });
    const sidebar = app.getByRole('link', { name: /^home$/i }).first();
    await Promise.race([
      enter.waitFor({ timeout: 30000 }),
      sidebar.waitFor({ timeout: 30000 }),
    ]).catch(() => {});
    if (await enter.isVisible()) {
      await enter.click();
      await sidebar.waitFor({ timeout: 30000 });
    }
  }
  const slowType = async (locator, text) => {
    await locator.click();
    await locator.pressSequentially(text, { delay: 70 });
  };

  /** Opens the Template and fills it in; leaves the form on the Review step. */
  async function fillForm(kind, name, file) {
    await goto('/create/templates/default/calm-import-diagram');
    const nameField = page.getByLabel('Name', { exact: false }).first();
    await nameField.waitFor({ timeout: 30000 });
    await slowType(nameField, name);
    await page.getByLabel('Format', { exact: false }).first().click();
    await sleep(600);
    await page.getByRole('option', { name: FORMAT[kind], exact: true }).click();
    await sleep(400);
    await page.locator('input[type=file]').first().setInputFiles(file);
    await sleep(900);
    await page.getByRole('button', { name: 'Review' }).click();
    await page
      .getByRole('button', { name: 'Create' })
      .waitFor({ timeout: 15000 });
    await sleep(800);
  }
  /** Runs the reviewed form and waits for the task to finish; `expect` is a text the finished page shows. */
  async function create(expect) {
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/create\/tasks\//, { timeout: 30000 });
    await app.getByText(expect).first().waitFor({ timeout: 120000 });
    await sleep(500);
  }
  const scrollTo = async text => {
    await app
      .getByText(text)
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await sleep(400);
  };
  /** Waits (silently) for the CALM provider to bring a Component into the catalog. */
  async function waitForCatalog(name) {
    for (let i = 0; i < 90; i++) {
      if (await inCatalog(name, token)) return;
      if (i === 0) log(`waiting for ${name} in the catalog`);
      if (i % 20 === 19) token = await guestToken();
      await sleep(1000);
    }
    throw new Error(`${name} did not appear in the catalog within 90 s`);
  }
  async function catalogPage(name) {
    await goto(`/catalog/default/component/${name}`);
    await app
      .getByText('CALM architecture')
      .first()
      .waitFor({ timeout: 30000 });
    await sleep(800);
    await app
      .getByText('CALM architecture')
      .first()
      .evaluate(el => el.scrollIntoView({ block: 'start' }));
  }

  // ---- 1. Diagrams already exist
  await show(titleCard());
  await chapter(0);
  await beat('intro');

  // ---- 2. The diagram
  await chapter(1);
  await beat('diagram', () =>
    show(imageCard(DIAGRAM_PNG, 'trading.drawio, in draw.io')),
  );

  // ---- 3. The Template
  await chapter(2);
  await beat('template', async () => {
    await goto('/create');
    await app.getByText('Import a diagram').first().waitFor({ timeout: 30000 });
    await app.getByText('Import a diagram').first().hover();
  });
  await beat('form', async () => {
    await goto('/create/templates/default/calm-import-diagram');
    await page.getByLabel('Format', { exact: false }).first().click();
  });
  await hold(1200);
  await page.keyboard.press('Escape');

  // ---- 4. Import the draw.io file
  await chapter(3);
  await beat('drawio-import', () =>
    fillForm('drawio', NAMES.drawio, FILES.drawio),
  );
  await beat('drawio-steps', () => create('Guesses made while converting'));
  await beat('drawio-result', () => scrollTo('Guesses made while converting'));

  // ---- 5. The same platform in C4
  await chapter(4);
  await beat('c4-source', () =>
    show(
      sourceCard(FILES.c4, 'trading.c4.md: the same platform, in Mermaid C4'),
    ),
  );
  await beat(
    'c4-import',
    () => fillForm('c4', NAMES.c4, FILES.c4),
    () => create('Guesses made while converting'),
  );
  await beat('c4-result', () => scrollTo('Guesses made while converting'));

  // ---- 6. In CALM Hub: the draw.io import's page, on its Diagram tab
  await chapter(5);
  await beat('hub', async () => {
    await page.goto(`${HUB}/#/${NS}/architectures/${NAMES.drawio}/1.0.0`, {
      waitUntil: 'domcontentloaded',
    });
    const diagram = page
      .getByRole('tablist')
      .getByRole('tab', { name: 'Diagram', exact: true });
    await diagram.waitFor({ timeout: 30000 });
    await diagram.click();
    await sleep(800);
    const fit = page.getByRole('button', { name: 'Fit View' });
    if (await fit.isVisible().catch(() => false)) await fit.click();
  });
  await hold(1500);

  // ---- 7. Mermaid flowcharts
  await chapter(6);
  await beat(
    'mermaid',
    () => show(sourceCard(FILES.mermaid, 'trading.mmd: a Mermaid flowchart')),
    () => sleep(2500),
    () => fillForm('mermaid', NAMES.mermaid, FILES.mermaid),
    () => create('Guesses made while converting'),
    () => scrollTo('Guesses made while converting'),
  );
  await hold(1500);

  // ---- 8. In the catalog: after CALM Hub and Mermaid, so the CALM provider (a read a minute) has usually picked
  // up both imports and nothing waits on camera.
  await hold(0);
  await waitForCatalog(NAMES.drawio);
  await chapter(7);
  await beat('catalog-drawio', () => catalogPage(NAMES.drawio));
  // The lines are short: hold each page long enough to take in the architecture card.
  await hold(3000);
  await waitForCatalog(NAMES.c4);
  await beat('catalog-c4', () => catalogPage(NAMES.c4));
  await hold(3500);

  // ---- 9. The wrong file
  await chapter(8);
  await beat(
    'wrong',
    () => fillForm('c4', NAMES.wrong, FILES.drawio),
    () => create('does not match the chosen format'),
    // The log shows the error's trace with local paths: hide it.
    () =>
      page
        .getByRole('button', { name: /hide logs/i })
        .click()
        .catch(() => {}),
  );
  await hold(2000);

  // ---- 10. Recap
  await chapter(9);
  await beat('recap', async () => {
    await goto('/create');
    await app
      .getByText('Import a diagram')
      .first()
      .hover()
      .catch(() => {});
  });
  await hold(1500);
  const duration = now();

  // ---- Save the video and lay the voiceover under it.
  const video = await page.video().path();
  await context.close();
  await browser.close();
  const out = path.join(OUT, 'calm-import-demo.mp4');
  const offset = ((t0 - created) / 1000).toFixed(2);
  const inputs = said.flatMap(s => ['-i', s.file]);
  const delays = said.map(
    (s, i) =>
      `[${i + 1}:a]aresample=48000,adelay=delays=${Math.round(
        s.start * 1000,
      )}:all=1[a${i}]`,
  );
  const mix = `${said.map((_, i) => `[a${i}]`).join('')}amix=inputs=${
    said.length
  }:normalize=0:duration=longest,apad[aout]`;
  // A page change shows the browser's blank white page for a moment: each flash shows the frame before it instead.
  const flashes = whiteFlashes(video, offset);
  log(`${flashes.length} white flash(es) between pages covered`);
  const base = '[0:v]setpts=PTS-STARTPTS,fps=25';
  const picture = flashes.length
    ? [
        `${base},split=${flashes.length + 1}[f0]${flashes
          .map((_, i) => `[r${i}]`)
          .join('')}`,
        ...flashes.map(
          ([first, last], i) =>
            `[f${i}][r${i}]freezeframes=first=${first}:last=${last}:replace=${
              first - 1
            }[f${i + 1}]`,
        ),
        `[f${flashes.length}]scale=1920:1080:flags=lanczos,format=yuv420p[v]`,
      ]
    : [`${base},scale=1920:1080:flags=lanczos,format=yuv420p[v]`];
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      offset,
      '-i',
      video,
      ...inputs,
      '-filter_complex',
      [...picture, ...delays, mix].join(';'),
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
  fs.rmSync(video, { force: true });
  const srt = said
    .map(
      (s, i) =>
        `${i + 1}\n${srtTime(s.start)} --> ${srtTime(
          s.start + s.seconds + 0.3,
        )}\n${s.text}\n`,
    )
    .join('\n');
  fs.writeFileSync(path.join(OUT, 'calm-import-demo.srt'), srt);
  fs.writeFileSync(
    path.join(OUT, 'chapters.json'),
    `${JSON.stringify(marks, null, 2)}\n`,
  );
  console.log('video:', out);
  console.log(
    marks
      .map(
        m =>
          `${Math.floor(m.start / 60)}:${String(m.start % 60).padStart(
            2,
            '0',
          )} ${m.title}`,
      )
      .join('\n'),
  );
})().catch(e => {
  console.error(e);
  process.exit(1);
});
