// Lays the voice under a finished take again, at the same timings, without re-recording: for a change to the level
// only (voice.cjs's voiceMix). The picture is copied as it is; the lines are the same clips at the same starts.
//
//   node docs/demo/remix-audio.cjs <out-dir>    # rewrites <out-dir>/calm-hub-deploy-demo.mp4, then runs check-take.cjs
//
// Never use it to lay a different voice or different words into a take: a take is timed to its own voice.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { voiceMix } = require('./voice.cjs');

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: remix-audio.cjs <out-dir>');
const video = path.join(OUT, 'calm-hub-deploy-demo.mp4');
const { said } = JSON.parse(fs.readFileSync(path.join(OUT, 'said.json'), 'utf8'));
for (const s of said) if (!fs.existsSync(s.file)) throw new Error(`the clip for ${s.id} is gone: ${s.file}`);
const duration = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString().trim();
const tmp = path.join(OUT, 'calm-hub-deploy-demo.remix.mp4');
execFileSync(
  'ffmpeg',
  [
    '-y', '-loglevel', 'error',
    '-i', video,
    ...said.flatMap(s => ['-i', s.file]),
    '-filter_complex', voiceMix(said, 1).join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-t', duration,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    tmp,
  ],
  { stdio: 'inherit' },
);
fs.renameSync(tmp, video);
console.log(`remixed ${said.length} lines under ${video}`);
execFileSync(process.execPath, [path.join(__dirname, 'check-take.cjs'), OUT], { stdio: 'inherit' });
