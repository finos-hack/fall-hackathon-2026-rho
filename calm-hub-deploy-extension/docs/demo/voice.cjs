// Speaks the demo's narration beats to audio files, cached by provider, voice, settings and text.
//
//   DEMO_TTS=say          (default) macOS `say`: DEMO_VOICE (default Daniel), DEMO_RATE (default 170)
//   DEMO_TTS=elevenlabs   ElevenLabs text to speech: ELEVENLABS_API_KEY, DEMO_VOICE (a voice id),
//                         DEMO_MODEL (default eleven_multilingual_v2), DEMO_SPEED (default 1.0)
//
// speak(beats, dir) adds `file` and `seconds` to every beat and returns them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const seconds = file =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

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
    const settings = { stability: 0.5, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed };
    return {
      key: `elevenlabs|${voice}|${model}|${JSON.stringify(settings)}`,
      ext: 'mp3',
      describe: `ElevenLabs voice ${voice}, ${model}, speed ${speed}`,
      render: async (text, file) => {
        for (let attempt = 1; ; attempt++) {
          const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
          });
          if (r.ok) return fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
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
  for (const b of beats) {
    const hash = crypto.createHash('sha1').update(`${p.key}|${b.text}`).digest('hex').slice(0, 16);
    b.file = path.join(dir, `${b.id}-${hash}.${p.ext}`);
    if (!fs.existsSync(b.file)) {
      const part = b.file.replace(/(\.[a-z0-9]+)$/, '.part$1');
      await p.render(b.text, part);
      fs.renameSync(part, b.file);
      made++;
    }
    b.seconds = seconds(b.file);
  }
  return Object.assign(beats, { describe: p.describe, made });
}

module.exports = { speak };
