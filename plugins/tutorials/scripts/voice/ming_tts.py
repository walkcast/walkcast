"""Ming-3.0 text-to-speech on Apple Silicon (MLX), with word timings from Qwen3-ForcedAligner.

voice.mjs runs this in the plugin's own Python environment. It reads one job from stdin:

    {"model": "mlx-community/Ming-3.0-tts-0.5B-bf16", "aligner": "mlx-community/Qwen3-ForcedAligner-0.6B-8bit",
     "lang": "en", "speed": 1.0,
     "lines": [{"text": "Click New project.", "out": "/abs/path.wav", "voice": "US_James"}]}

A line is spoken in a built-in "voice", or copies a "reference" ({"audio": path, "text": its words}), such
as a recording of a real voice. (Ming can also make a voice from a description, but those drift in pitch
from line to line, so walkcast doesn't use them.)
Each clip is written as a WAV, trimmed to 50 ms of silence at each end, and one JSON line is printed:

    {"out": "/abs/path.wav", "duration": 1.42, "words": [{"text": "Click", "start": 0.05, "end": 0.33}, ...], "suspect": false}

Ming doesn't report word timings, so the aligner finds them in the finished clip. On Kokoro's clips it
agrees with Kokoro's own timings to within about 30 ms. Ming sometimes stops before the end of a line.
The aligner shows it: the words it never spoke get no time. A clip like that is made again with another
seed, up to three times; if every take falls short, the best one is kept and marked "suspect".
"""
import json
import os
import re
import sys

# Libraries can print to stdout while loading; keep stdout for results only.
results = sys.stdout
sys.stdout = sys.stderr

import mlx.core as mx  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from mlx_audio.stt import load as load_stt  # noqa: E402
from mlx_audio.tts.utils import load_model  # noqa: E402

LANGS = {"en": "English", "de": "German", "es": "Spanish", "fr": "French", "ko": "Korean", "ja": "Japanese", "zh": "Chinese"}
QUIET = 0.01  # below this the clip counts as silent
PAD = 0.05  # seconds of silence kept at each end

TRIES = 3


def cut_short(words):
    """Whether the aligner squeezed words to nothing in a way that means they weren't spoken: the last
    word, three in a row, or any longer word. Short words like "a" or "to" alone can get no time anyway,
    because the aligner works in 80 ms steps."""
    if not words:
        return True
    gone = [w["end"] - w["start"] < 0.02 for w in words]
    if gone[-1]:
        return True
    run = 0
    for word, g in zip(words, gone):
        run = run + 1 if g else 0
        if run >= 3 or (g and len(re.sub(r"\W", "", word["text"])) >= 4):
            return True
    return False


job = json.load(sys.stdin)
lang = job.get("lang") or "en"
model = load_model(job["model"])
aligner = load_stt(job["aligner"])


def speak(line, kwargs, seed, out):
    """One take of a line: the clip, trimmed and written to out, and its word timings."""
    mx.random.seed(seed)
    parts = list(model.generate(**kwargs))
    audio = np.concatenate([np.array(p.audio, dtype=np.float32).reshape(-1) for p in parts])
    rate = parts[0].sample_rate
    loud = np.flatnonzero(np.abs(audio) > QUIET)
    if len(loud):
        audio = audio[max(0, loud[0] - int(PAD * rate)): loud[-1] + int(PAD * rate)]
    sf.write(out, audio, rate)
    duration = len(audio) / rate
    words = []
    for w in aligner.generate(out, text=line["text"], language=LANGS.get(lang, "English")):
        start, end = min(float(w.start_time), duration), min(float(w.end_time), duration)
        words.append({"text": w.text, "start": round(start, 3), "end": round(max(start, end), 3)})
    return duration, words


for line in job["lines"]:
    kwargs = {"text": line["text"], "lang_code": lang, "verbose": False}
    if line.get("reference"):
        kwargs.update(ref_audio=line["reference"]["audio"], ref_text=line["reference"]["text"])
    else:
        kwargs["voice"] = line.get("voice") or "US_James"
    if float(job.get("speed") or 1) != 1:
        kwargs["speed"] = float(job["speed"])
    best = None
    for k, seed in enumerate(range(TRIES)):
        take = f"{line['out']}.take{k}.wav"
        duration, words = speak(line, kwargs, seed, take)
        short = cut_short(words)
        squeezed = sum(w["end"] - w["start"] < 0.02 for w in words)
        if best is None or (short, squeezed) < (best[3], best[4]):
            if best:
                os.remove(best[0])
            best = (take, duration, words, short, squeezed)
        else:
            os.remove(take)
        if not short:
            break
    os.replace(best[0], line["out"])
    results.write(json.dumps({"out": line["out"], "duration": round(best[1], 3), "words": best[2], "suspect": best[3]}) + "\n")
    results.flush()
    mx.clear_cache()
