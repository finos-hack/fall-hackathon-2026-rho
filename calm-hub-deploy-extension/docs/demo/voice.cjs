// Speaks the demo's narration beats to audio files, cached by provider, voice, settings and text.
//
//   DEMO_TTS=say          (default) macOS `say`: DEMO_VOICE (default Daniel), DEMO_RATE (default 170)
//   DEMO_TTS=elevenlabs   ElevenLabs text to speech: ELEVENLABS_API_KEY, DEMO_VOICE (a voice id),
//                         DEMO_MODEL (default eleven_multilingual_v2), DEMO_SPEED (default 1.0), DEMO_SEED (default 1234)
//
// ElevenLabs lines are voiced in order and stitched: each request carries the request ids of the three lines before it
// (previous_request_ids), so the voice carries on from line to line instead of starting afresh. Voiced separately,
// Jim's professional clone came back in two characters (measured on take v2: most lines at -38 LUFS, 8 of 99 at
// about -20 LUFS and darker), and the gain that evened their level could not even their tone. Each new clip's raw
// level is checked before its id joins the chain; a clip in the loud mode is voiced again with another seed.
// ElevenLabs keeps request ids for two hours: a line voiced later than that after the lines before it fails rather
// than come out unstitched (voice the whole narration again with a new DEMO_SEED).
//
// speak(beats, dir) adds `file`, `seconds` and `lufs` (its loudness) to every beat and returns them. Words the voice gets wrong are respelt
// for it in pronunciation.cjs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const pronunciation = require('./pronunciation.cjs');

/** The text the voice is given: the beat with pronunciation.cjs's respellings. */
const spokenText = text => pronunciation.reduce((t, [pattern, say]) => t.replace(pattern, say), text);

const seconds = file =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

/**
 * A clip's integrated loudness (EBU R128, LUFS). ElevenLabs clips of the same voice come back at very different levels
 * (measured: -39 to -19 LUFS within one narration), so the join gives each clip a fixed gain to one target.
 */
const lufs = (file, filter) => {
  const af = [filter, 'ebur128'].filter(Boolean).join(',');
  const out = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', af, '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr;
  const m = out.match(/I:\s+(-?[\d.]+) LUFS\s+Threshold/);
  if (!m) throw new Error(`could not measure the loudness of ${file}`);
  return Number(m[1]);
};

/** A clip's tone: the median spectral centroid in Hz (reported beside the level; darker clips sit lower). */
const tone = file => {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'aspectralstats=measure=centroid,ametadata=print:key=lavfi.aspectralstats.1.centroid', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  }).stderr;
  const c = [...out.matchAll(/centroid=([\d.]+)/g)].map(m => Number(m[1])).filter(x => x > 0).sort((a, b) => a - b);
  return c.length ? Math.round(c[Math.floor(c.length / 2)]) : undefined;
};

/**
 * The voice's level: every line is brought to TARGET_LUFS (EBU R128), its peaks limited to LIMIT (-3 dBFS). -1.5 dBFS
 * was not enough at AAC 128k: the encoder overshot it to +1.6 dBFS on a sharp onset in a quiet clip raised
 * 24 dB. The join encodes at 192k (measured -2.8 dBFS on the same clip) and check-take.cjs checks the true peak.
 */
const TARGET_LUFS = -16;
const LIMIT = 0.7079;
/** The most gain a clip may need: more means a near-silent clip, which would only lift noise. */
const MAX_GAIN = 30;
/** A raw ElevenLabs clip louder than this is in the voice's loud, darker mode (about -20 LUFS against -38). */
const MAX_RAW_LUFS = -32;
/** How old a previous line's request id may be for stitching (ElevenLabs keeps them for two hours). */
const STITCH_MAX_AGE_MS = 110 * 60 * 1000;
/** The chain each clip goes through in the join: a fixed gain, then the limiter. */
const levelFilter = gain => `aresample=48000,volume=${gain.toFixed(2)}dB,alimiter=limit=${LIMIT}:level=false`;

/**
 * The fixed gain that brings a clip to TARGET_LUFS through levelFilter. The limiter takes a little off peaky clips
 * (measured up to 1.7 LU), so the gain is measured through the chain and corrected, up to three times. Cached beside
 * the clip.
 */
function gainFor(file) {
  const cache = `${file}.gain.json`;
  if (fs.existsSync(cache)) {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (c.target === TARGET_LUFS && c.limit === LIMIT) return c;
  }
  const raw = lufs(file);
  let gain = TARGET_LUFS - raw;
  let level = lufs(file, levelFilter(gain));
  for (let i = 0; i < 3 && Math.abs(TARGET_LUFS - level) > 0.3; i++) {
    gain += TARGET_LUFS - level;
    level = lufs(file, levelFilter(gain));
  }
  if (gain > MAX_GAIN) throw new Error(`${file} needs ${gain.toFixed(1)} dB of gain (most ${MAX_GAIN}): is it silent?`);
  const c = { target: TARGET_LUFS, limit: LIMIT, raw, gain, level };
  fs.writeFileSync(cache, `${JSON.stringify(c)}\n`);
  return c;
}

/**
 * The ffmpeg filter that places each spoken line (inputs from `first` on) at its start, at the even level, and mixes
 * them into [aout]. `said` is [{ start, file }].
 */
function voiceMix(said, first) {
  const lines = said.map((s, i) => `[${i + first}:a]${levelFilter(gainFor(s.file).gain)},adelay=delays=${Math.round(s.start * 1000)}:all=1[a${i}]`);
  return [...lines, `${said.map((_, i) => `[a${i}]`).join('')}amix=inputs=${said.length}:normalize=0:duration=longest,apad[aout]`];
}

function provider() {
  const tts = process.env.DEMO_TTS || 'say';
  if (tts === 'say') {
    const voice = process.env.DEMO_VOICE || 'Daniel';
    const rate = process.env.DEMO_RATE || '170';
    return {
      key: `say|${voice}|${rate}`,
      ext: 'aiff',
      describe: `macOS say, voice ${voice} at ${rate}`,
      render: async (text, file) => execFileSync('say', ['-v', voice, '-r', rate, '-o', file, text]),
    };
  }
  if (tts === 'elevenlabs') {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.DEMO_VOICE;
    if (!apiKey) throw new Error('DEMO_TTS=elevenlabs needs ELEVENLABS_API_KEY');
    if (!voice) throw new Error('DEMO_TTS=elevenlabs needs DEMO_VOICE (an ElevenLabs voice id)');
    const model = process.env.DEMO_MODEL || 'eleven_multilingual_v2';
    const speed = Number(process.env.DEMO_SPEED || '1');
    const seed = Number(process.env.DEMO_SEED || '1234');
    // Stability 0.7 (was 0.5): steadier from line to line. Approved with stitching on a test of the opening.
    const settings = { stability: 0.7, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed };
    return {
      key: `elevenlabs|${voice}|${model}|${JSON.stringify(settings)}|stitched|seed ${seed}`,
      ext: 'mp3',
      describe: `ElevenLabs voice ${voice}, ${model}, speed ${speed}, stitched, seed ${seed}`,
      stitched: true,
      seed,
      /** Writes the clip and returns its request id (for the next lines' previous_request_ids). */
      render: async (text, file, { previous = [], seed: s = seed } = {}) => {
        for (let attempt = 1; ; attempt++) {
          const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: model, voice_settings: settings, seed: s, previous_request_ids: previous }),
          });
          if (r.ok) {
            fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
            const id = r.headers.get('request-id');
            if (!id) throw new Error('ElevenLabs sent no request-id header: the next lines could not be stitched to this one');
            return id;
          }
          const detail = (await r.text()).slice(0, 300);
          // 429: too many requests at once; anything else (quota, bad voice) will not get better by retrying.
          if (r.status !== 429 || attempt >= 5) throw new Error(`ElevenLabs answered ${r.status}: ${detail}`);
          await new Promise(res => setTimeout(res, 2000 * attempt));
        }
      },
    };
  }
  throw new Error(`unknown DEMO_TTS ${tts} (say or elevenlabs)`);
}

async function speak(beats, dir) {
  const p = provider();
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  const chain = []; // the request ids of the lines so far, in order: { id, at }
  for (const b of beats) {
    const spoken = spokenText(b.text);
    const hash = crypto.createHash('sha1').update(`${p.key}|${spoken}`).digest('hex').slice(0, 16);
    b.file = path.join(dir, `${b.id}-${hash}.${p.ext}`);
    const sidecar = `${b.file}.request.json`;
    if (!fs.existsSync(b.file)) {
      const part = b.file.replace(/(\.[a-z0-9]+)$/, '.part$1');
      if (!p.stitched) {
        await p.render(spoken, part);
      } else {
        const previous = chain.slice(-3);
        const stale = previous.find(r => !r.id || Date.now() - r.at > STITCH_MAX_AGE_MS);
        if (stale) {
          throw new Error(
            `${b.id}: the lines before it were voiced over two hours ago (or without a request id), so it can't be stitched to them; voice the whole narration again with a new DEMO_SEED`,
          );
        }
        let request;
        for (let attempt = 0; ; attempt++) {
          const seed = p.seed + attempt * 1000;
          const id = await p.render(spoken, part, { previous: previous.map(r => r.id), seed });
          const raw = lufs(part);
          request = { id, at: Date.now(), seed, raw, tone: tone(part) };
          if (raw <= MAX_RAW_LUFS) break;
          console.log(`  ${b.id}: came back in the loud mode (${raw} LUFS, tone ${request.tone} Hz); voicing it again`);
          if (attempt >= 4) throw new Error(`${b.id}: five voicings all came back louder than ${MAX_RAW_LUFS} LUFS`);
        }
        fs.writeFileSync(sidecar, `${JSON.stringify(request)}\n`);
        console.log(`  voiced ${b.id.padEnd(22)} ${String(request.raw).padStart(6)} LUFS  tone ${request.tone} Hz${request.seed === p.seed ? '' : `  (seed ${request.seed})`}`);
      }
      fs.renameSync(part, b.file);
      made++;
    }
    if (p.stitched) chain.push(fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : {});
    b.seconds = seconds(b.file);
    const level = gainFor(b.file);
    b.lufs = level.raw;
    b.gain = level.gain;
  }
  return Object.assign(beats, { describe: p.describe, made });
}

module.exports = { speak, spokenText, lufs, tone, gainFor, voiceMix, TARGET_LUFS, MAX_RAW_LUFS };
