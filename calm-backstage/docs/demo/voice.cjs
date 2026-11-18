// Copied from calm-hub-deploy-extension/docs/demo/voice.cjs (main, 34eff22) (#53), with DEMO_TTS=local and kept clips added.
// Speaks the demo's narration beats to audio files, cached by provider, voice, settings and text.
//
//   DEMO_TTS=say          (default) macOS `say`: DEMO_VOICE (default Daniel), DEMO_RATE (default 170)
//   DEMO_TTS=elevenlabs   ElevenLabs text to speech: ELEVENLABS_API_KEY, DEMO_VOICE (a voice id),
//                         DEMO_MODEL (default eleven_multilingual_v2), DEMO_SPEED (default 1.0)
//   DEMO_TTS=local        the presenter's voice cloned on this machine (clone-voice.py): DEMO_VOICE_SAMPLE, and
//                         DEMO_CFG, DEMO_EXAGGERATION, DEMO_SEED; kept clips in DEMO_VOICE_DIR replace single lines
//
// speak(beats, dir) adds `file` and `seconds` to every beat and returns them. Words the voice gets wrong are respelt
// for it in pronunciation.cjs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pronunciation = require('./pronunciation.cjs');

/** The text the voice is given: the beat with pronunciation.cjs's respellings. */
const spokenText = text =>
  pronunciation.reduce((t, [pattern, say]) => t.replace(pattern, say), text);

const seconds = file =>
  Number(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim(),
  );

function provider() {
  const tts = process.env.DEMO_TTS || 'say';
  if (tts === 'say') {
    const voice = process.env.DEMO_VOICE || 'Daniel';
    const rate = process.env.DEMO_RATE || '170';
    return {
      key: `say|${voice}|${rate}`,
      ext: 'aiff',
      describe: `macOS say, voice ${voice} at ${rate}`,
      render: async (text, file) =>
        execFileSync('say', ['-v', voice, '-r', rate, '-o', file, text]),
    };
  }
  if (tts === 'elevenlabs') {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.DEMO_VOICE;
    if (!apiKey)
      throw new Error('DEMO_TTS=elevenlabs needs ELEVENLABS_API_KEY');
    if (!voice)
      throw new Error(
        'DEMO_TTS=elevenlabs needs DEMO_VOICE (an ElevenLabs voice id)',
      );
    const model = process.env.DEMO_MODEL || 'eleven_multilingual_v2';
    const speed = Number(process.env.DEMO_SPEED || '1');
    const settings = {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0,
      use_speaker_boost: true,
      speed,
    };
    return {
      key: `elevenlabs|${voice}|${model}|${JSON.stringify(settings)}`,
      ext: 'mp3',
      describe: `ElevenLabs voice ${voice}, ${model}, speed ${speed}`,
      render: async (text, file) => {
        for (let attempt = 1; ; attempt++) {
          const r = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
            {
              method: 'POST',
              headers: {
                'xi-api-key': apiKey,
                'content-type': 'application/json',
                accept: 'audio/mpeg',
              },
              body: JSON.stringify({
                text,
                model_id: model,
                voice_settings: settings,
              }),
            },
          );
          if (r.ok)
            return fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          const detail = (await r.text()).slice(0, 300);
          // 429: too many requests at once; anything else (quota, bad voice) will not get better by retrying.
          if (r.status !== 429 || attempt >= 5)
            throw new Error(`ElevenLabs answered ${r.status}: ${detail}`);
          await new Promise(res => setTimeout(res, 2000 * attempt));
        }
      },
    };
  }
  if (tts === 'local') {
    // The presenter's voice, cloned on this machine from a short sample (clone-voice.py, Chatterbox). Nothing leaves
    // the machine; the sample is never committed.
    const sample = process.env.DEMO_VOICE_SAMPLE;
    if (!sample || !fs.existsSync(sample))
      throw new Error(
        'DEMO_TTS=local needs DEMO_VOICE_SAMPLE, a WAV of the presenter',
      );
    const python = process.env.DEMO_PYTHON || 'python3';
    const cfg = process.env.DEMO_CFG || '0.5';
    const exaggeration = process.env.DEMO_EXAGGERATION || '0.5';
    const seed = process.env.DEMO_SEED || '';
    const stat = fs.statSync(sample);
    return {
      key: `local|${path.basename(sample)}|${stat.size}|${
        stat.mtimeMs
      }|${cfg}|${exaggeration}|${seed}`,
      ext: 'wav',
      describe: `your cloned voice (cfg ${cfg}, exaggeration ${exaggeration}${
        seed ? `, seed ${seed}` : ''
      })`,
      /** Speaks every missing line in one run, so the model loads once. */
      renderAll: jobs => {
        const list = path.join(
          os.tmpdir(),
          `clone-voice-jobs-${process.pid}.json`,
        );
        fs.writeFileSync(
          list,
          JSON.stringify(jobs.map(j => ({ text: j.text, out: j.file }))),
        );
        execFileSync(
          python,
          [path.join(__dirname, 'clone-voice.py'), sample, list],
          {
            stdio: ['ignore', 'inherit', 'ignore'],
            env: {
              ...process.env,
              HF_HUB_OFFLINE: '1',
              PYTORCH_ENABLE_MPS_FALLBACK: '1',
            },
          },
        );
        fs.rmSync(list, { force: true });
      },
    };
  }
  throw new Error(`unknown DEMO_TTS ${tts} (say, elevenlabs or local)`);
}

/**
 * Clips that replace a beat's generated line (added for the import demo): `<id>.wav` in DEMO_VOICE_DIR (default
 * docs/demo/.voice, git-ignored), used with DEMO_TTS=local, for example a take of one line that came out well.
 */
const CLIP_DIR = process.env.DEMO_VOICE_DIR || path.join(__dirname, '.voice');
const keptClip = id => {
  const file = path.join(CLIP_DIR, `${id}.wav`);
  return fs.existsSync(file) ? file : undefined;
};

async function speak(beats, dir) {
  const p = provider();
  const local = process.env.DEMO_TTS === 'local';
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  let kept = 0;
  const missing = [];
  for (const b of beats) {
    const clip = local && keptClip(b.id);
    if (clip) {
      b.file = clip;
      kept++;
      continue;
    }
    const spoken = spokenText(b.text);
    const hash = crypto
      .createHash('sha1')
      .update(`${p.key}|${spoken}`)
      .digest('hex')
      .slice(0, 16);
    b.file = path.join(dir, `${b.id}-${hash}.${p.ext}`);
    if (!fs.existsSync(b.file))
      missing.push({
        b,
        text: spoken,
        file: b.file.replace(/(\.[a-z0-9]+)$/, '.part$1'),
      });
  }
  if (missing.length && p.renderAll) {
    p.renderAll(missing);
  } else {
    for (const m of missing) await p.render(m.text, m.file);
  }
  for (const m of missing) fs.renameSync(m.file, m.b.file);
  made = missing.length;
  for (const b of beats) b.seconds = seconds(b.file);
  const describe = kept
    ? `${p.describe}, with ${kept} kept clip(s)`
    : p.describe;
  return Object.assign(beats, { describe, made });
}

module.exports = { speak, spokenText };
