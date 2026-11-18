"""Speaks lines in a voice cloned, on this machine, from a short sample of the presenter (Chatterbox, MIT licence).

Used by voice.cjs with DEMO_TTS=local. Nothing leaves the machine: the sample, the model and the audio stay local,
and the sample is never committed. Chatterbox marks what it generates with an inaudible watermark (synthetic speech).

    python clone-voice.py <sample.wav> <jobs.json>

jobs.json is a list of {"text": ..., "out": ...}; each line is written to its "out" as WAV. The model loads once.
DEMO_EXAGGERATION (default 0.5) and DEMO_CFG (default 0.5) tune expressiveness and pace; a job's own
"exaggeration" and "cfg" override them, and its "ref" names another sample, to compare settings in one run.
A lower cfg leans towards the model's default (American) delivery and a quicker pace. DEMO_SEED (or a job's
"seed") fixes the randomness, so the same settings give the same voice every time. DEMO_DEVICE picks mps or cpu.
The model hears only the first seconds of a sample (about 6 s for delivery and accent, 10 s for the voice), so a
sample that starts on clear, typical speech clones best.
"""
import json
import os
import sys

import torch
import torchaudio
from chatterbox.tts import ChatterboxTTS


def main() -> None:
    sample, jobs_file = sys.argv[1], sys.argv[2]
    with open(jobs_file, encoding="utf-8") as f:
        jobs = json.load(f)
    # The CPU by default: the Apple GPU (DEMO_DEVICE=mps) can need much more memory, which stalls a machine that is also
    # running the demo stack.
    device = os.environ.get("DEMO_DEVICE", "cpu")
    # The checkpoint was saved on CUDA: map it to whatever this machine has.
    original_load = torch.load
    torch.load = lambda *a, **k: original_load(*a, **{**k, "map_location": torch.device(device)})
    model = ChatterboxTTS.from_pretrained(device=device)
    exaggeration = float(os.environ.get("DEMO_EXAGGERATION", "0.5"))
    cfg = float(os.environ.get("DEMO_CFG", "0.5"))
    seed = os.environ.get("DEMO_SEED")
    for i, job in enumerate(jobs, 1):
        # A fixed seed per line keeps a voice that sounded right the same on every run.
        if job.get("seed", seed) is not None:
            torch.manual_seed(int(job.get("seed", seed)))
        wav = model.generate(
            job["text"],
            audio_prompt_path=job.get("ref", sample),
            exaggeration=float(job.get("exaggeration", exaggeration)),
            cfg_weight=float(job.get("cfg", cfg)),
        )
        torchaudio.save(job["out"], wav.cpu(), model.sr)
        print(f"{i}/{len(jobs)} {os.path.basename(job['out'])}", flush=True)


if __name__ == "__main__":
    main()
