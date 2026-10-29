"""Kokoro text-to-speech with word timings, for the tutorials plugin.

voice.mjs runs this in the plugin's own Python environment. It reads one job from stdin:

    {"voice": "af_heart", "speed": 1.0, "lines": [{"text": "Click New project.", "out": "/abs/path.wav"}]}

A line can name its own "voice", which is how voice.mjs --samples reads one line in several voices.

writes each line as a 24 kHz mono WAV, and prints one JSON line per clip to stdout:

    {"out": "/abs/path.wav", "duration": 1.42, "words": [{"text": "Click", "start": 0.1, "end": 0.38}, ...]}

Word timings come from Kokoro's predicted phoneme durations, which it provides for English voices.
For other languages "words" is empty. Silence at either end of a clip is trimmed to 50 ms, so lines
follow each other at the pace record.mjs sets, and word times are shifted to match.
"""
import json
import sys

# Libraries can print to stdout while loading; keep stdout for results only.
results = sys.stdout
sys.stdout = sys.stderr

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from kokoro import KPipeline  # noqa: E402

SAMPLE_RATE = 24000
PAD = int(0.05 * SAMPLE_RATE)
QUIET = 0.01  # below this the clip counts as silent


def trim(audio):
    """Where the sound starts and ends, keeping PAD samples of silence on each side."""
    loud = np.flatnonzero(np.abs(audio) > QUIET)
    if not len(loud):
        return 0, len(audio)
    return max(0, loud[0] - PAD), min(len(audio), loud[-1] + PAD)


job = json.load(sys.stdin)
pipelines = {}  # one per language, the first letter of the voice


def pipeline_for(voice):
    if voice[0] not in pipelines:
        pipelines[voice[0]] = KPipeline(lang_code=voice[0], repo_id="hexgrad/Kokoro-82M")
    return pipelines[voice[0]]


for line in job["lines"]:
    voice = line.get("voice") or job["voice"]
    chunks, words, offset = [], [], 0.0
    for result in pipeline_for(voice)(line["text"], voice=voice, speed=float(job.get("speed", 1.0))):
        audio = result.audio.cpu().numpy() if hasattr(result.audio, "cpu") else np.asarray(result.audio)
        for token in result.tokens or []:
            if token.start_ts is None or token.end_ts is None or not any(c.isalnum() for c in token.text):
                continue
            words.append({"text": token.text, "start": round(offset + token.start_ts, 3), "end": round(offset + token.end_ts, 3)})
        chunks.append(audio)
        offset += len(audio) / SAMPLE_RATE
    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    first, last = trim(audio)
    audio = audio[first:last]
    shift = first / SAMPLE_RATE
    end = len(audio) / SAMPLE_RATE
    words = [{**w, "start": round(min(max(0.0, w["start"] - shift), end), 3), "end": round(min(max(0.0, w["end"] - shift), end), 3)} for w in words]
    sf.write(line["out"], audio, SAMPLE_RATE)
    results.write(json.dumps({"out": line["out"], "duration": round(len(audio) / SAMPLE_RATE, 3), "words": words}) + "\n")
    results.flush()
