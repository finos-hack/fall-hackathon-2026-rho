// Checks a finished take for what a viewer hears and sees, before anyone watches it:
//
//   - loudness: every narrated line, measured in the final mp4 (EBU R128), is within MAX_OFF LU of the target and
//     within MAX_SPREAD LU of every other line, with true peaks under MAX_PEAK; the pauses inside each line (where
//     the gain also lifts the voice clone's room tone and breath) stay under MAX_PAUSE_DB. Between lines the mix is
//     digital silence, so the pauses inside lines are what to measure.
//   - the voice itself: the raw level of every clip (said.json's lufs, before the join's gain) within MAX_RAW_SPREAD
//     LU. The gain evens the level but not the tone: a clip voiced in the clone's loud, darker mode still sounds like
//     a different take after it, so the clips have to agree before the gain (take v2 passed the level check and
//     still sounded uneven; its clips spread 19 LU raw).
//   - frames against words: one frame from the middle of every line, on contact sheets labelled with the line, to be
//     looked at line by line (a line that describes the screen must be true of the frame it plays over); and the
//     frames either side of every card's cuts (sheets/cuts.png).
//
//   node docs/demo/check-take.cjs <out-dir>     # reads <out-dir>/said.json and the take's mp4; writes qa.json,
//                                               # frames/ and sheets/; exits 1 if the loudness check fails
//
// The recorder runs it after the join. Captions-only takes have no audio: only the frames are made.
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { createRequire } = require('module');

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: check-take.cjs <out-dir>');
const DIR = path.resolve(__dirname, '../..');
const BACKSTAGE = process.env.CALM_BACKSTAGE_DIR || path.resolve(DIR, '../calm-backstage');
const { TARGET_LUFS } = require('./voice.cjs');
const MAX_OFF = 1.5;
const MAX_SPREAD = 2;
const MAX_PAUSE_DB = -45; // RMS of the pauses inside a line (measured -47 to -50 for clips raised 24 dB)
const MAX_PEAK = -0.5; // dBFS (true peak, in the encoded file)
const MAX_RAW_SPREAD = 5; // LU between the clips as voiced (the approved test of the opening: 2.3)
const PER_SHEET = 12;

const { said, cards } = JSON.parse(fs.readFileSync(path.join(OUT, 'said.json'), 'utf8'));
// The newest take in the directory (a voiced take and a captions-only one can sit side by side).
const video = ['calm-hub-deploy-demo.mp4', 'calm-hub-deploy-demo-captions.mp4']
  .map(f => path.join(OUT, f))
  .filter(f => fs.existsSync(f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!video) throw new Error(`no take in ${OUT}`);
const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', video])
  .toString()
  .trim().length > 0;

const ffmpegErr = args => spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr;
const loudness = (start, seconds) => {
  const out = ffmpegErr(['-ss', start.toFixed(3), '-t', seconds.toFixed(3), '-i', video, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  return { lufs: Number((out.match(/I:\s+(-?[\d.]+) LUFS\s+Threshold/) || [])[1]), peak: Number((out.match(/Peak:\s+(-?[\d.]+) dBFS/) || [])[1]) };
};
const rms = (start, seconds) => {
  const out = ffmpegErr(['-ss', start.toFixed(3), '-t', seconds.toFixed(3), '-i', video, '-vn', '-af', 'astats=measure_perchannel=none', '-f', 'null', '-']);
  const m = out.match(/RMS level dB:\s+(-?[\d.]+|-inf)/);
  return m && m[1] !== '-inf' ? Number(m[1]) : -120;
};
/** The pauses inside a line (at least 0.12 s under -38 dB): the loudest one's RMS, or undefined if it has none. */
const loudestPause = (start, seconds) => {
  const out = ffmpegErr(['-ss', start.toFixed(3), '-t', seconds.toFixed(3), '-i', video, '-vn', '-af', 'silencedetect=n=-38dB:d=0.12', '-f', 'null', '-']);
  const starts = [...out.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]));
  const levels = ends.map((e, i) => (e - starts[i] > 0.08 ? rms(start + starts[i] + 0.02, e - starts[i] - 0.04) : undefined)).filter(x => x !== undefined);
  return levels.length ? Math.max(...levels) : undefined;
};

const failures = [];
const lines = said.map((s, i) => ({ n: i + 1, id: s.id, start: s.start, seconds: s.seconds, text: s.text }));
if (hasAudio) {
  for (const l of lines) Object.assign(l, loudness(l.start, l.seconds));
  const levels = lines.map(l => l.lufs).filter(Number.isFinite);
  if (levels.length !== lines.length) failures.push(`${lines.length - levels.length} lines could not be measured (silent?)`);
  for (const l of lines) {
    if (Math.abs(l.lufs - TARGET_LUFS) > MAX_OFF) failures.push(`line ${l.n} (${l.id}) is ${l.lufs} LUFS, target ${TARGET_LUFS} ± ${MAX_OFF}`);
    if (l.peak > MAX_PEAK) failures.push(`line ${l.n} (${l.id}) peaks at ${l.peak} dBFS (most ${MAX_PEAK})`);
  }
  const spread = Math.max(...levels) - Math.min(...levels);
  if (spread > MAX_SPREAD) failures.push(`lines differ by ${spread.toFixed(1)} LU (most ${MAX_SPREAD})`);
  for (const l of lines) {
    l.pauseRms = loudestPause(l.start, l.seconds);
    if (l.pauseRms > MAX_PAUSE_DB) failures.push(`a pause in line ${l.n} (${l.id}) is at ${l.pauseRms.toFixed(1)} dB RMS (most ${MAX_PAUSE_DB})`);
  }
  const raws = said.map(s => s.lufs).filter(Number.isFinite);
  const rawSpread = raws.length ? Math.max(...raws) - Math.min(...raws) : 0;
  if (raws.length !== said.length) failures.push(`${said.length - raws.length} lines have no raw level in said.json`);
  if (rawSpread > MAX_RAW_SPREAD) {
    const median = [...raws].sort((a, b) => a - b)[Math.floor(raws.length / 2)];
    const odd = said.filter(s => Math.abs(s.lufs - median) > MAX_RAW_SPREAD / 2).map(s => `${s.id} ${s.lufs}`);
    failures.push(`the clips as voiced differ by ${rawSpread.toFixed(1)} LU (most ${MAX_RAW_SPREAD}); away from the median ${median}: ${odd.join(', ')}`);
  }
  console.log(`voice as voiced: ${Math.min(...raws)} to ${Math.max(...raws)} LUFS raw (spread ${rawSpread.toFixed(1)} LU)`);
  const pauses = lines.map(l => l.pauseRms).filter(p => p !== undefined);
  console.log(`loudness: ${Math.min(...levels).toFixed(1)} to ${Math.max(...levels).toFixed(1)} LUFS over ${levels.length} lines (target ${TARGET_LUFS})`);
  console.log(`peaks: at most ${Math.max(...lines.map(l => l.peak))} dBFS; pauses inside lines: at most ${Math.max(...pauses).toFixed(1)} dB RMS (${pauses.length} lines have pauses)`);
}

// Frames: the middle of every line, then contact sheets (a page of images, screenshotted).
const frames = path.join(OUT, 'frames');
const sheets = path.join(OUT, 'sheets');
for (const d of [frames, sheets]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}
const onCard = t => cards.some(c => t >= c.start && t <= (c.end ?? Infinity));
for (const l of lines) {
  l.frameAt = l.start + l.seconds / 2;
  l.card = onCard(l.frameAt);
  l.frame = path.join(frames, `${String(l.n).padStart(3, '0')}-${l.id}.jpg`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', l.frameAt.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '4', l.frame]);
}
// The cuts: each card's first frame, its last frames, and the first frame after it (a lagging recording shows the
// wrong card, or the panes, at a cut; the middle of a line never would).
const cuts = cards.flatMap((c, i) =>
  [
    ['first frame of the card', c.start + 0.04],
    ['card, 0.08 s before the cut', c.end - 0.08],
    ['first frame after the card', c.end + 0.04],
  ].map(([what, t], j) => ({ what: `card ${i + 1}: ${what}`, frameAt: t, frame: path.join(frames, `cut-${String(i + 1).padStart(2, '0')}-${j}.jpg`) })),
);
for (const c of cuts) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', c.frameAt.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '4', c.frame]);
}
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sheetFiles = [];
(async () => {
  const { chromium } = createRequire(path.join(BACKSTAGE, 'package.json'))('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2600, height: 1000 } });
  for (let s = 0; s * PER_SHEET < lines.length; s++) {
    const part = lines.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const cells = part
      .map(
        l => `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(l.frame).toString('base64')}">
        <figcaption><b>${l.n} · ${esc(l.id)}</b> <i>${l.card ? 'card' : 'panes'} at ${l.frameAt.toFixed(1)} s${l.lufs ? `, ${l.lufs} LUFS` : ''}</i><br>${esc(l.text)}</figcaption></figure>`,
      )
      .join('');
    await page.setContent(`<!doctype html><style>body{margin:0;padding:16px;background:#fff;font:15px/1.35 system-ui}
      main{display:grid;grid-template-columns:repeat(4,640px);gap:16px} figure{margin:0} img{display:block;width:640px}
      figcaption{padding:6px 2px} i{color:#666}</style><main>${cells}</main>`);
    const file = path.join(sheets, `sheet-${String(s + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: file, fullPage: true });
    sheetFiles.push(file);
  }
  if (cuts.length) {
    const cells = cuts
      .map(c => `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(c.frame).toString('base64')}"><figcaption><b>${esc(c.what)}</b> <i>at ${c.frameAt.toFixed(2)} s</i></figcaption></figure>`)
      .join('');
    await page.setContent(`<!doctype html><style>body{margin:0;padding:16px;background:#fff;font:15px/1.35 system-ui}
      main{display:grid;grid-template-columns:repeat(3,640px);gap:16px} figure{margin:0} img{display:block;width:640px}
      figcaption{padding:6px 2px} i{color:#666}</style><main>${cells}</main>`);
    const file = path.join(sheets, 'cuts.png');
    await page.screenshot({ path: file, fullPage: true });
    sheetFiles.push(file);
  }
  await browser.close();
  const qa = { video, hasAudio, target: TARGET_LUFS, passed: failures.length === 0, failures, sheets: sheetFiles, lines };
  fs.writeFileSync(path.join(OUT, 'qa.json'), `${JSON.stringify(qa, null, 2)}\n`);
  console.log(`frames: ${lines.length}, on ${sheetFiles.length} contact sheets in ${sheets} (look at every one)`);
  if (failures.length) {
    console.error(`QA FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('QA: loudness passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
