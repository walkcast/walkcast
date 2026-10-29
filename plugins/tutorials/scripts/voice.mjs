#!/usr/bin/env node
// Generate each tour's narration: one clip per say line, with the time of every word.
// Usage: node voice.mjs [<tutorial-id> ...] [--config tutorials/config.yaml]
//        node voice.mjs --samples [--voices af_heart,US_Emma] [--text "..."]
//
// Two engines. Kokoro (Apache-2.0) is the default: small, fast, and the same voice on every line, which is
// what the user picked twice in blind listening tests. Ming-3.0 (MIT, through MLX, Apple Silicon only) is
// an option with five built-in voices, and it can copy a recording of a real voice (voice.reference).
//
// --samples reads one line (the first narration line in the plan) in several voices and writes
// tutorials/.cache/voice/samples.html to compare them.
//
// Clips are cached in tutorials/.cache/voice/ by a hash of the engine, voice, speed and text, so a line
// is only generated again when it changes. Writes tutorials/<id>/produce/voice.json for each tour.
// The first run installs the engine into its own Python environment in the plugin's data folder, which
// needs uv (https://docs.astral.sh/uv/), and downloads the engine and its models.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, done, fail, loadConfig, parseArgs, readYaml, tourIds, writeJson } from './lib/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Each engine runs in its own Python environment. Packages resolve as they were on `snapshot`, so an
// install today and one next year get the same versions. An engine prints word timings, or [] if it can't.
const ENGINES = {
  ming: {
    python: '3.12',
    snapshot: '2026-10-21',
    packages: ['mlx-audio==0.6.1', 'soundfile==0.13.1'],
    script: 'voice/ming_tts.py',
    version: 1, // bump when the script's output changes, so cached clips are made again
    voice: 'US_Emma',
    // Built-in voices. A voice Ming makes from a description drifts in pitch from line to line, so there are none of those.
    voices: ['US_Emma', 'UK_George', 'UK_Charlotte', 'US_James', 'US_Stella'],
    model: 'mlx-community/Ming-3.0-tts-0.5B-bf16',
    aligner: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
    only: 'darwin-arm64', // MLX runs on Apple Silicon only
    download: 'about 4.5 GB',
  },
  kokoro: {
    python: '3.12',
    snapshot: '2026-10-01',
    packages: [
      'kokoro==0.9.4',
      'soundfile==0.13.1',
      // Without a floor the resolver can fall back to transformers 4.12, whose tokenizers must be compiled from source.
      'transformers>=4.45,<5',
      'en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl',
    ],
    script: 'voice/kokoro_tts.py',
    version: 2,
    voice: 'af_heart',
    download: 'about 1.2 GB',
  },
};
// Kokoro voices worth hearing first, by language: the first letter of a Kokoro voice is its language.
const KOKORO_SAMPLES = {
  a: ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'],
  e: ['ef_dora', 'em_alex'], f: ['ff_siwis'], h: ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'], i: ['if_sara', 'im_nicola'], p: ['pf_dora', 'pm_alex'],
};
KOKORO_SAMPLES.b = KOKORO_SAMPLES.a;
const ACCENTS = { a: 'American English', b: 'British English', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Brazilian Portuguese', z: 'Mandarin' };

const args = parseArgs();
const { cfg, tutorials } = loadConfig(args.config);
const platform = `${process.platform}-${process.arch}`;
const usable = (name) => !ENGINES[name].only || ENGINES[name].only === platform;
const engineName = cfg.voice?.engine || 'kokoro';
if (!ENGINES[engineName]) fail(`Unknown voice engine "${engineName}" in config.yaml. Available: ${Object.keys(ENGINES).join(', ')}`);
if (!usable(engineName)) fail(`The ${engineName} voice engine runs only on Apple Silicon Macs. Set voice.engine to kokoro in config.yaml.`);
const speed = Number(cfg.voice?.speed || 1);
const lang = String(cfg.voice?.lang || 'en').toLowerCase().slice(0, 2);
const cacheDir = path.join(tutorials, '.cache', 'voice');
const clip = (key, ext) => path.join(cacheDir, `${key}.${ext}`);

if (args.samples) samples();
const current = speaker(engineName, cfg.voice || {});
const ids = tourIds(tutorials, args._, { videos: true });

const tours = ids.map((id) => {
  const file = path.join(tutorials, id, 'tour.yaml');
  if (!fs.existsSync(file)) fail(`No ${path.relative(process.cwd(), file)}`);
  const steps = (readYaml(file).steps || []).map((s, i) => {
    const text = String(s?.say ?? '').trim();
    if (!text) return { n: i + 1, say: null, duration: 0 };
    return { n: i + 1, say: text, key: keyFor(current, text) };
  });
  return { id, steps };
});

const todo = new Map();
for (const t of tours) for (const s of t.steps) if (s.key && !fs.existsSync(clip(s.key, 'json'))) todo.set(s.key, { ...current, text: s.say });
generate(engineName, todo);

const summary = [];
for (const t of tours) {
  const steps = t.steps.map((s) => {
    if (!s.key) return s;
    const c = JSON.parse(fs.readFileSync(clip(s.key, 'json'), 'utf8'));
    return { n: s.n, say: s.say, audio: path.relative(tutorials, clip(s.key, 'wav')), duration: c.duration, words: c.words, ...(c.suspect ? { suspect: true } : {}) };
  });
  writeJson(path.join(tutorials, t.id, 'produce', 'voice.json'), { engine: engineName, voice: current.label, speed, steps });
  const spoken = steps.filter((s) => s.audio);
  summary.push({
    id: t.id,
    clips: spoken.length,
    generated: t.steps.filter((s) => s.key && todo.has(s.key)).length,
    narration_seconds: Math.round(spoken.reduce((sum, s) => sum + s.duration, 0) * 10) / 10,
    without_word_timings: spoken.filter((s) => !s.words?.length).map((s) => s.n),
    // Ming stopped early on these in every take; listen, and reword or shorten the line if it's cut off.
    cut_short: spoken.filter((s) => s.suspect).map((s) => s.n),
  });
}
done({ ok: true, engine: engineName, voice: current.label, tours: summary });

// Who speaks, for an engine and a voice setting: { engine, label, id (for the cache), and what the engine needs }.
function speaker(engine, v) {
  if (engine === 'kokoro') {
    const voice = v.voice || ENGINES.kokoro.voice;
    return { engine, label: voice, id: voice, voice };
  }
  if (v.reference) {
    const audio = path.resolve(tutorials, v.reference);
    if (!fs.existsSync(audio)) fail(`voice.reference ${v.reference} doesn't exist (paths are relative to tutorials/).`);
    if (!v.reference_text) fail('voice.reference needs voice.reference_text: the exact words spoken in it.');
    return { engine, label: v.reference, id: `ref:${hash(fs.readFileSync(audio))}:${v.reference_text}`, reference: { audio, text: v.reference_text } };
  }
  const voice = v.voice || ENGINES.ming.voice;
  if (!ENGINES.ming.voices.includes(voice)) fail(`Ming has no voice "${voice}". Its English voices: ${ENGINES.ming.voices.join(', ')}.`);
  return { engine, label: voice, id: voice, voice };
}

function keyFor(who, text) {
  // Kokoro's key is unchanged from before Ming arrived, so existing clips stay cached.
  const parts = who.engine === 'kokoro'
    ? ['kokoro', ENGINES.kokoro.version, who.id, speed, text]
    : [who.engine, ENGINES[who.engine].version, who.id, null, speed, lang, text];
  return hash(JSON.stringify(parts)).slice(0, 20);
}

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Make the clips that aren't cached yet. todo maps each clip's key to its speaker and text.
function generate(engine, todo) {
  if (!todo.size) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const python = ensureEngine(engine);
  const spec = ENGINES[engine];
  const lines = [...todo].map(([key, l]) => ({ key, text: l.text, out: clip(key, 'wav'), voice: l.voice, reference: l.reference }));
  const job = { voice: spec.voice, speed, lang, model: spec.model, aligner: spec.aligner, lines };
  console.error(`Generating ${todo.size} narration clip${todo.size > 1 ? 's' : ''} with ${engine}...`);
  const run = spawnSync(python, [path.join(here, spec.script)], {
    input: JSON.stringify(job),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HF_HOME: path.join(dataDir(), 'huggingface'), HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' },
  });
  const byOut = new Map(lines.map((l) => [l.out, l.key]));
  for (const line of (run.stdout || '').split('\n').filter(Boolean)) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const key = byOut.get(r.out);
    if (key) writeJson(clip(key, 'json'), { engine, voice: todo.get(key).label, speed, text: todo.get(key).text, duration: r.duration, words: r.words, ...(r.suspect ? { suspect: true } : {}) });
  }
  if (run.error || run.status !== 0) fail(`The ${engine} voice engine failed.`, { output: tail(run.stderr || String(run.error)) });
}

// One line in several voices, on a page to compare them.
function samples() {
  const text = String(args.text || sampleLine()).trim();
  const names = args.voices
    ? String(args.voices).split(',').map((v) => v.trim()).filter(Boolean)
    : [...(KOKORO_SAMPLES[(cfg.voice?.engine !== 'ming' && cfg.voice?.voice) ? cfg.voice.voice[0] : 'a'] || KOKORO_SAMPLES.a), ...(usable('ming') ? ENGINES.ming.voices.slice(0, 3) : [])];
  // Kokoro voices look like af_heart: a language letter, f or m, and a name.
  const list = names.map((n) => speaker(/^[a-z][fm]_/.test(n) ? 'kokoro' : 'ming', { voice: n }));
  const lines = list.map((who) => ({ ...who, text, key: keyFor(who, text) }));
  for (const engine of ['kokoro', 'ming']) {
    generate(engine, new Map(lines.filter((l) => l.engine === engine && !fs.existsSync(clip(l.key, 'json'))).map((l) => [l.key, l])));
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const describeVoice = (l) => l.engine === 'kokoro'
    ? `Kokoro: ${ACCENTS[l.voice[0]] || l.voice[0]}, ${l.voice[1] === 'm' ? 'man' : 'woman'}`
    : `Ming: ${l.label.startsWith('UK') ? 'British' : 'American'}, Apple Silicon only`;
  const isCurrent = (l) => l.engine === engineName && l.label === (cfg.voice?.reference || cfg.voice?.voice || ENGINES[engineName].voice);
  const page = path.join(cacheDir, 'samples.html');
  fs.writeFileSync(page, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Narrator voices</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f27;--muted:#5f6673;--line:#e3e6eb;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#e8eaee;--muted:#9aa1ad;--line:#2a2e37;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 56px}h1{font-size:26px;margin:0 0 6px}.lede{color:var(--muted);margin:0 0 24px}
section{display:grid;grid-template-columns:1fr minmax(0,320px);gap:6px 16px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:10px}
h2{font-size:17px;margin:0}.meta{color:var(--muted);font-size:14px;margin:0}audio{width:100%}
@media (max-width:600px){section{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Narrator voices</h1>
<p class="lede">Each reads: “${esc(text)}” Tell Claude which you'd like.</p>
${lines.map((l) => `<section><div><h2>${esc(l.label)}${isCurrent(l) ? ' (current)' : ''}</h2><p class="meta">${esc(describeVoice(l))}</p></div><audio controls preload="metadata" src="${path.basename(clip(l.key, 'wav'))}"></audio></section>`).join('\n')}
</main></body></html>
`);
  done({
    ok: true,
    page: path.relative(process.cwd(), page),
    text,
    current: { engine: engineName, voice: cfg.voice?.reference || cfg.voice?.voice || ENGINES[engineName].voice },
    voices: lines.map((l) => ({ engine: l.engine, voice: l.label, about: describeVoice(l), clip: path.relative(process.cwd(), clip(l.key, 'wav')) })),
  });
}

// The first narration line in the plan, so the samples sound like the real thing.
function sampleLine() {
  const planFile = path.join(tutorials, 'plan.yaml');
  const items = fs.existsSync(planFile) ? readYaml(planFile).items || [] : [];
  for (const it of items) {
    const tour = path.join(tutorials, it.id, 'tour.yaml');
    const say = fs.existsSync(tour) ? (readYaml(tour).steps || []).find((s) => s?.say)?.say : null;
    if (say || it.opening) return say || it.opening;
  }
  return "Here's how to create your first project and invite your team.";
}

// Set up an engine's Python environment once, and again whenever its package list changes.
function ensureEngine(engine) {
  const spec = ENGINES[engine];
  const venv = path.join(dataDir(), 'voice', engine);
  const python = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  const stamp = path.join(venv, 'tutorials-plugin.json');
  const want = JSON.stringify({ python: spec.python, snapshot: spec.snapshot, packages: spec.packages });
  if (fs.existsSync(python) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return python;
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (uv.error || uv.status !== 0) fail('The voice engine needs uv to set up its Python environment. Install it with "brew install uv" or "curl -LsSf https://astral.sh/uv/install.sh | sh", then run this again.');
  console.error(`Setting up the ${engine} voice engine in ${venv}. This happens once and downloads ${spec.download}...`);
  for (const step of [
    ['venv', '--python', spec.python, '--clear', venv],
    ['pip', 'install', '--python', python, '--exclude-newer', spec.snapshot, ...spec.packages],
  ]) {
    const r = spawnSync('uv', step, { encoding: 'utf8' });
    if (r.status !== 0) fail(`Setting up the voice engine failed at "uv ${step.slice(0, 2).join(' ')}".`, { output: tail(r.stderr || r.stdout) });
  }
  fs.writeFileSync(stamp, want);
  return python;
}

function tail(text, lines = 15) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n');
}
