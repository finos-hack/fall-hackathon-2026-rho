// Re-voices a finished take: the same footage, with each narration line spoken again (voice.cjs: say or ElevenLabs)
// and laid at the time the take spoke it. No new take, so nothing changes in CALM Hub, Gitea or the cluster.
//
//   DEMO_TTS=elevenlabs DEMO_VOICE=<voice id> node docs/demo/revoice.cjs <take-dir> [out-dir]
//
// <take-dir> holds calm-hub-deploy-demo.mp4 and calm-hub-deploy-demo.srt from record-hub-demo.cjs. Each line keeps its
// start time; a line longer than the gap before the next one is sped up to fit (and listed). Writes
// <out-dir>/calm-hub-deploy-demo.mp4 and .srt (out-dir defaults to <take-dir>/revoiced).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { speak } = require('./voice.cjs');

const DIR = path.resolve(__dirname, '../..');
const [take, outArg] = process.argv.slice(2);
if (!take) {
  console.error('usage: revoice.cjs <take-dir> [out-dir]');
  process.exit(2);
}
const OUT = outArg || path.join(take, 'revoiced');
const VIDEO = path.join(take, 'calm-hub-deploy-demo.mp4');
const SRT = path.join(take, 'calm-hub-deploy-demo.srt');
const GAP = 0.15; // the least silence kept before the next line
const MAX_TEMPO = 1.25; // faster than this sounds rushed: warn

const toSeconds = t => {
  const [h, m, rest] = t.split(':');
  const [s, ms] = rest.split(',');
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
};
const srtTime = s => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const duration = file =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

(async () => {
  const cues = fs
    .readFileSync(SRT, 'utf-8')
    .trim()
    .split(/\r?\n\r?\n/)
    .map(block => {
      const [, times, ...text] = block.split(/\r?\n/);
      const [start] = times.split(' --> ');
      return { start: toSeconds(start), text: text.join(' ').trim() };
    });
  const length = duration(VIDEO);
  const beats = cues.map((c, i) => ({ id: `line-${String(i + 1).padStart(2, '0')}`, text: c.text, start: c.start }));
  const spoken = await speak(beats, path.join(DIR, '.work/demo-audio'));
  console.log(`${beats.length} lines, ${spoken.describe}; ${spoken.made} newly spoken`);

  const rushed = [];
  beats.forEach((b, i) => {
    const slot = (i + 1 < beats.length ? beats[i + 1].start : length) - b.start - GAP;
    b.tempo = b.seconds > slot ? b.seconds / slot : 1;
    b.end = b.start + b.seconds / b.tempo;
    if (b.tempo > 1) rushed.push(`${b.id} ×${b.tempo.toFixed(2)}${b.tempo > MAX_TEMPO ? ' (rushed)' : ''}: ${b.text.slice(0, 60)}…`);
  });
  if (rushed.length) console.log(`sped up to fit:\n  ${rushed.join('\n  ')}`);

  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, 'calm-hub-deploy-demo.mp4');
  const filters = beats.map(
    (b, i) =>
      `[${i + 1}:a]${b.tempo > 1 ? `atempo=${b.tempo.toFixed(4)},` : ''}aresample=48000,adelay=delays=${Math.round(b.start * 1000)}:all=1[a${i}]`,
  );
  const mix = `${beats.map((_, i) => `[a${i}]`).join('')}amix=inputs=${beats.length}:normalize=0:duration=longest,apad[aout]`;
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      VIDEO,
      ...beats.flatMap(b => ['-i', b.file]),
      '-filter_complex',
      [...filters, mix].join(';'),
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-t',
      length.toFixed(2),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: 'inherit' },
  );
  fs.writeFileSync(
    path.join(OUT, 'calm-hub-deploy-demo.srt'),
    beats.map((b, i) => `${i + 1}\n${srtTime(b.start)} --> ${srtTime(b.end + 0.3)}\n${b.text}\n`).join('\n'),
  );
  console.log('video:', out);
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
