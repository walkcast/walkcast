#!/usr/bin/env node
// Turn each tour's recording and narration into the finished video, with HyperFrames.
// Usage: node render.mjs [<tutorial-id> ...] [--config tutorials/config.yaml] [--draft] [--html-only] [--force]
//
// Needs produce/voice.json (voice.mjs) and produce/recording.json and recording.mp4 (record.mjs).
// Builds a HyperFrames composition in produce/render/: the app in a browser window on a brand
// background, a pointer that glides to each target and ripples on click, a ring around each target,
// a zoom onto small targets (nearby actions share one zoom), captions timed to the words, and title
// cards. HyperFrames renders it at 1920x1080, 30 fps, H.264. Then ffmpeg levels the sound to -16 LUFS
// and, when config.yaml names a music file, mixes it in, ducked under the voice. Writes to produce/:
//   video.mp4      the finished video
//   video.json     when each step happens in the video, and a fingerprint of what it was made from
//   captions.vtt   the captions, for players and video sites
//   review.html    a frame at every action, the narration timing, and anything that looks wrong
// A video whose inputs haven't changed isn't rendered again; --force renders it anyway.
// --html-only stops after building the composition; --draft renders faster.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { done, fail, loadConfig, lock, musicOf, parseArgs, readYaml, tourIds, writeJson } from './lib/common.mjs';
import { displayUrl, nextTitle, recordingInputs, renderInputs } from './lib/produce.mjs';

const W = 1920;
const H = 1080;
const FPS = 30;
const INTRO = 2.8; // seconds of title card before the recording
const OUTRO = 3.2;
const BAR = 40; // browser window title bar

const require = createRequire(import.meta.url);
const args = parseArgs();
const { cfg, tutorials } = loadConfig(args.config);
const ids = tourIds(tutorials, args._, { videos: true });
const brand = { color: cfg.brand?.color || '#4c6ef5', background: cfg.brand?.background || '#141a2e' };
const look = { zoom: cfg.video?.zoom !== 'off', maxZoom: Number(cfg.video?.max_zoom || 1.6), captions: cfg.video?.captions !== false };
if (Number(process.versions.node.split('.')[0]) < 22) fail(`Rendering needs Node 22 or later (HyperFrames requires it). This is Node ${process.versions.node}.`);
let hyperframes;
try {
  hyperframes = path.join(path.dirname(require.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
} catch {
  fail('The plugin dependencies are not installed. Run: npm install --prefix "<plugin folder>"');
}
const gsapFile = require.resolve('gsap/dist/gsap.min.js');
if (!args['html-only'] && spawnSync('ffmpeg', ['-version']).status !== 0) fail('Rendering needs ffmpeg. Install it with "brew install ffmpeg" (macOS) or your package manager.');
const plan = fs.existsSync(path.join(tutorials, 'plan.yaml')) ? readYaml(path.join(tutorials, 'plan.yaml')) : { items: [] };

const results = [];
for (const id of ids) results.push(renderTour(id));
const ok = results.every((r) => r.ok);
done({ ok, tours: results }, ok ? 0 : 1);

function renderTour(id) {
  const dir = path.join(tutorials, id);
  const prod = path.join(dir, 'produce');
  const files = { tour: path.join(dir, 'tour.yaml'), voice: path.join(prod, 'voice.json'), rec: path.join(prod, 'recording.json'), video: path.join(prod, 'recording.mp4') };
  for (const [what, f] of Object.entries(files)) {
    if (!fs.existsSync(f)) return { id, ok: false, error: `No ${rel(f)}. Run ${what === 'voice' ? 'voice.mjs' : 'record.mjs'} first.` };
  }
  const tour = readYaml(files.tour);
  const voiceRaw = fs.readFileSync(files.voice, 'utf8');
  const recRaw = fs.readFileSync(files.rec, 'utf8');
  const voice = JSON.parse(voiceRaw);
  const rec = JSON.parse(recRaw);
  if (rec.inputs !== recordingInputs(tour, voiceRaw)) return { id, ok: false, error: 'The tour or its narration changed after it was recorded. Run record.mjs again.' };

  // Nothing to do when everything the video is made from is as it was last time.
  const inputs = renderInputs({ cfg, plan, id, recRaw, voiceRaw });
  const videoFile = path.join(prod, 'video.mp4');
  const infoFile = path.join(prod, 'video.json');
  const last = fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, 'utf8')) : null;
  if (!args.force && !args['html-only'] && fs.existsSync(videoFile) && last?.inputs === inputs) {
    return { id, ok: true, up_to_date: true, video: rel(videoFile), review: rel(path.join(prod, 'review.html')), problems: last.problems || [] };
  }
  const held = lock(prod, 'render');
  if (held.error) return { id, ok: false, error: held.error };
  try {
    return build({ id, tour, voice, rec, prod, files, inputs });
  } finally {
    held.release();
  }
}

function build({ id, tour, voice, rec, prod, files, inputs }) {
  // Build the composition beside the old one and swap it in, so a failed build leaves the last one.
  const tmp = path.join(prod, `render.tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'audio'), { recursive: true });
  link(files.video, path.join(tmp, 'recording.mp4'));
  fs.copyFileSync(gsapFile, path.join(tmp, 'gsap.min.js'));
  const comp = compose({ id, tour, voice, rec, out: tmp });
  fs.writeFileSync(path.join(tmp, 'index.html'), comp.html);
  fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ id, name: tour.title }, null, 2) + '\n');
  const out = path.join(prod, 'render');
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(tmp, out);
  fs.writeFileSync(path.join(prod, 'captions.vtt'), vtt(comp.captionList));
  const info = { id, title: tour.title, inputs: null, duration: round(comp.total, 3), intro: INTRO, steps: comp.steps };
  const summary = { id, ok: true, seconds: round(comp.total, 1), composition: rel(path.join(out, 'index.html')), zooms: comp.zooms, captions: comp.captionList.length };
  if (args['html-only']) {
    writeJson(path.join(prod, 'video.json'), info);
    return summary;
  }

  const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_SKIP_SKILLS: '1' };
  const raw = path.join(prod, `video-raw.tmp-${process.pid}.mp4`);
  const r = spawnSync(process.execPath, [hyperframes, 'render', out, '-o', raw, '--fps', String(FPS), '--quality', args.draft ? 'draft' : 'looks', '--video-frame-format', 'png', '--quiet'], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !fs.existsSync(raw)) {
    fs.rmSync(raw, { force: true });
    return { id, ok: false, error: 'HyperFrames could not render the composition.', output: tail(`${r.stdout}\n${r.stderr}`) };
  }
  // Where the voice is, measured before any music fills the pauses.
  const speech = speechSegments(raw, comp.total);

  // Level the sound, and mix in music under the voice if there is any.
  const music = musicOf(cfg)?.file ? path.resolve(tutorials, musicOf(cfg).file) : null;
  if (music && !fs.existsSync(music)) {
    fs.rmSync(raw, { force: true });
    return { id, ok: false, error: `The music file ${rel(music)} named in config.yaml doesn't exist.` };
  }
  const level = 'loudnorm=I=-16:TP=-1.5:LRA=11';
  const mix = music
    ? ['-stream_loop', '-1', '-i', music, '-filter_complex', `[0:a]asplit=2[v][key];[1:a]volume=0.22,afade=t=out:st=${round(comp.total - 2.5, 2)}:d=2.5[m];[m][key]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450[duck];[v][duck]amix=inputs=2:normalize=0:duration=first,${level}[a]`, '-map', '0:v', '-map', '[a]']
    : ['-af', level];
  const temp = path.join(prod, `video.tmp-${process.pid}.mp4`);
  // A music credit travels inside the file rather than on screen.
  const credit = musicOf(cfg)?.credit ? ['-metadata', `comment=Music: ${musicOf(cfg).credit.replace(/\n/g, ' · ')}`] : [];
  const f = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, ...mix, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', String(comp.total), ...credit, '-movflags', '+faststart', temp], { encoding: 'utf8' });
  fs.rmSync(raw, { force: true });
  if (f.status !== 0) {
    fs.rmSync(temp, { force: true });
    return { id, ok: false, error: `ffmpeg could not finish the sound: ${tail(f.stderr, 3)}` };
  }
  const final = path.join(prod, 'video.mp4');
  fs.renameSync(temp, final);
  const rv = review({ id, tour, prod, comp, rec, speech });
  writeJson(path.join(prod, 'video.json'), { ...info, inputs, problems: rv.problems });
  return { ...summary, video: rel(final), review: rel(rv.file), problems: rv.problems };
}

// Build the HyperFrames composition for one tour.
function compose({ id, tour, voice, rec, out }) {
  const vw = rec.viewport.width;
  const vh = rec.viewport.height;
  const s = Math.min(1440 / vw, 900 / vh); // viewport pixels to composition pixels
  const cw = Math.round(vw * s);
  const ch = Math.round(vh * s);
  const winX = Math.round((W - cw) / 2);
  const winY = 28;
  const R = rec.duration;
  const total = INTRO + R + OUTRO;
  const T = (t) => round(INTRO + t, 3); // recording time to composition time
  const P = (n) => round(n * s, 1);

  // Pointer: where it starts, each move, each press. Steps that only point something out don't move it.
  const acted = rec.steps.filter((st) => st.action && (st.action.x != null || st.action.box)).map((st) => ({ ...st.action, step: st }));
  const actions = acted.filter((a) => a.x != null);
  const start = actions[0]?.from || { x: vw * 0.62, y: vh * 0.58 };
  const moves = actions.filter((a) => a.travel[1] > a.travel[0]).map((a) => ({ t0: T(a.travel[0]), t1: T(a.travel[1]), x0: P(a.from.x), y0: P(a.from.y), x1: P(a.x), y1: P(a.y) }));
  const presses = actions.filter((a) => ['click', 'check', 'select', 'type'].includes(a.do)).map((a) => ({ t: T(a.at), x: P(a.x), y: P(a.y) }));

  // A ring around each target, from just before the pointer arrives until the action is done. A pointed-out
  // element keeps its ring for the rest of the line. When the page changes or the element goes away (a menu
  // item, a dialog button), the ring goes at once.
  const navigates = (a) => a.step.url_after !== a.step.url;
  const gone = (a) => navigates(a) || a.vanished;
  const begin = (a) => (a.do === 'show' ? a.at - 0.2 : a.travel[0]);
  const finish = (a) => (a.do === 'show' ? Math.max(a.at + 1, a.step.end - 0.35) : a.typing ? a.typing[1] + 0.5 : gone(a) ? a.at : a.at + 0.8);
  const rings = acted.filter((a) => a.box).map((a, i) => ({
    id: `ring-${i}`,
    t0: T(a.do === 'show' ? begin(a) : Math.max(a.travel[0], a.at - 0.5)),
    t1: T(finish(a)),
    fade: gone(a) ? 0.12 : 0.3,
    x: P(a.box.x) - 6, y: P(a.box.y) - 6, w: P(a.box.width) + 12, h: P(a.box.height) + 12,
  }));

  // Zoom: consecutive actions on the same page and near each other share one zoom onto their combined
  // box. Skip it when the area is large anyway, or for a single readable-size click that leaves the page
  // at once (the zoom would only bounce in and out), and move straight from one zoom to the next when close.
  const groups = [];
  for (const a of look.zoom ? acted.filter((x) => x.box) : []) {
    const g = groups.at(-1);
    const c = { x: a.box.x + a.box.width / 2, y: a.box.y + a.box.height / 2 };
    if (g && !g.closed && a.step.url === g.url && Math.hypot(c.x - g.c.x, c.y - g.c.y) < 520 && begin(a) - g.end < 5) {
      g.items.push(a);
      g.end = finish(a);
      g.closed = navigates(a);
    } else {
      groups.push({ items: [a], url: a.step.url, c, start: begin(a), end: finish(a), closed: navigates(a) });
    }
  }
  const camera = [];
  let view = { z: 1, x: 0, y: 0 };
  let free = 0; // when the camera is free to move again
  const zooms = [];
  groups.forEach((g, gi) => {
    const x0 = Math.min(...g.items.map((a) => a.box.x)) * s;
    const y0 = Math.min(...g.items.map((a) => a.box.y)) * s;
    const x1 = Math.max(...g.items.map((a) => a.box.x + a.box.width)) * s;
    const y1 = Math.max(...g.items.map((a) => a.box.y + a.box.height)) * s;
    if ((x1 - x0) * (y1 - y0) > 0.3 * cw * ch) return;
    if (g.items.length === 1 && navigates(g.items[0]) && g.items[0].box.height >= 30) return;
    const z = Math.min(look.maxZoom, cw / (x1 - x0 + 260), ch / (y1 - y0 + 200));
    if (z < 1.2) return;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const target = { z: round(z, 3), x: round(clamp(cw / 2 - cx * z, cw - cw * z, 0), 1), y: round(clamp(ch / 2 - cy * z, ch - ch * z, 0), 1) };
    const tIn = Math.max(free, g.start - 0.2);
    camera.push({ t: T(tIn), dur: 0.8, from: view, to: target });
    view = target;
    zooms.push({ steps: g.items.map((a) => a.step.n), zoom: target.z });
    const next = groups[gi + 1];
    const tOut = g.end;
    free = tOut + 0.8;
    // Leave the zoom unless the next one starts right away (it then moves straight there).
    if (!next || next.start - 0.2 > tOut + 1.0) {
      camera.push({ t: T(tOut), dur: 0.8, from: view, to: { z: 1, x: 0, y: 0 } });
      view = { z: 1, x: 0, y: 0 };
    }
  });

  // Captions: each line in phrases of about 7 words, split at sentence ends and longer commas, without
  // leaving three words or fewer of a sentence on their own.
  const captions = [];
  for (const st of rec.steps) {
    const v = voice.steps[st.n - 1];
    if (!v?.audio || !st.audio) continue;
    const text = v.say.split(/\s+/).filter(Boolean);
    const timed = v.words || [];
    const times = timed.length === text.length
      ? timed.map((w) => [w.start, w.end])
      : text.map((_, k) => [(k / text.length) * v.duration, ((k + 1) / text.length) * v.duration]);
    let phrase = [];
    text.forEach((word, k) => {
      phrase.push(k);
      const endOfSentence = /[.!?]["')]?$/.test(word);
      const comma = /[,;:]$/.test(word) && phrase.length >= 4;
      const end = text.slice(k + 1).findIndex((w) => /[.!?]["')]?$/.test(w));
      const left = end >= 0 ? end + 1 : text.length - k - 1; // words still to come in this sentence
      const full = phrase.length >= 7 && left > 3;
      if (endOfSentence || comma || full || phrase.length >= 10 || k === text.length - 1) {
        captions.push({ text: phrase.map((j) => text[j]).join(' '), t0: T(st.audio.at + times[phrase[0]][0]), t1: T(st.audio.at + times[phrase.at(-1)][1] + 0.2) });
        phrase = [];
      }
    });
  }
  // Hold each caption until the next one if the gap is short, so they don't flicker.
  captions.forEach((c, k) => {
    const next = captions[k + 1];
    if (next && next.t0 - c.t1 < 0.6) c.t1 = next.t0;
  });

  // The address bar follows navigations.
  const urls = [{ t: 0, url: rec.start_url }];
  for (const st of rec.steps) {
    if (st.url_after && st.url_after !== urls.at(-1).url) urls.push({ t: round((st.action?.at ?? st.start) + 0.15, 3), url: st.url_after });
  }

  // Narration clips, copied next to the composition.
  const audio = [];
  for (const st of rec.steps) {
    if (!st.audio) continue;
    const name = `audio/${String(st.n).padStart(2, '0')}.wav`;
    link(path.join(tutorials, st.audio.file), path.join(out, name));
    audio.push({ src: name, t: T(st.audio.at), d: st.audio.duration });
  }

  const upNext = nextTitle(plan, id);
  const appName = cfg.app?.name || '';
  const data = { introEnd: INTRO, mainEnd: round(INTRO + R, 3), total: round(total, 3), cursor: { x: P(start.x), y: P(start.y) }, moves, presses, rings, camera };
  const timed = (cls, t0, t1, inner, extra = '') => `<div ${extra}class="${cls} clip" data-start="${round(t0, 3)}" data-duration="${round(Math.max(0.05, t1 - t0), 3)}">${inner}</div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${W}, height=${H}">
<title>${esc(tour.title || id)}</title>
<script src="gsap.min.js"></script>
<style>
:root { --accent: ${brand.color}; --ground: ${brand.background}; --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--ground); font-family: var(--font); }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden;
  background: radial-gradient(1200px 700px at 20% 0%, color-mix(in srgb, var(--accent) 35%, transparent), transparent 70%),
              radial-gradient(1000px 600px at 100% 100%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%), var(--ground); }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 200px; color: #fff; }
.card .eyebrow { font-size: 28px; font-weight: 600; letter-spacing: .02em; color: color-mix(in srgb, var(--accent) 45%, #fff); margin-bottom: 22px; }
.card h1 { font-size: 88px; line-height: 1.05; font-weight: 700; letter-spacing: -.025em; max-width: 1400px; }
.card .rule { width: 96px; height: 6px; border-radius: 3px; background: var(--accent); margin-top: 40px; }
#outro { opacity: 0; }
#outro .eyebrow { color: rgba(255,255,255,.65); }
#outro h1 { font-size: 72px; }
#main { position: absolute; inset: 0; opacity: 0; }
#window { position: absolute; left: ${winX}px; top: ${winY}px; width: ${cw}px; height: ${ch + BAR}px; border-radius: 14px; overflow: hidden; background: #fff;
  box-shadow: 0 40px 90px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08); }
#bar { position: absolute; left: 0; top: 0; right: 0; height: ${BAR}px; background: #eceef2; border-bottom: 1px solid #d9dce3; }
#bar .dots { position: absolute; left: 16px; top: 14px; display: flex; gap: 8px; }
#bar .dots i { width: 12px; height: 12px; border-radius: 6px; display: block; }
#address { position: absolute; left: 50%; top: 7px; width: 620px; height: 26px; margin-left: -310px; border-radius: 7px; background: #fff; border: 1px solid #d9dce3; }
.url { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #4a5160; white-space: nowrap; overflow: hidden; }
#view { position: absolute; left: 0; top: ${BAR}px; width: ${cw}px; height: ${ch}px; overflow: hidden; background: #fff; }
#camera { position: absolute; left: 0; top: 0; width: ${cw}px; height: ${ch}px; transform-origin: 0 0; }
#recording { position: absolute; left: 0; top: 0; width: ${cw}px; height: ${ch}px; }
.ring { position: absolute; border-radius: 9px; border: 3px solid var(--accent); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 22%, transparent); opacity: 0; }
.ripple { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 55%, transparent); opacity: 0; }
#cursor { position: absolute; left: 0; top: 0; width: ${round(26 * s, 1)}px; height: ${round(34 * s, 1)}px; margin: ${round(-2 * s, 1)}px 0 0 ${round(-2 * s, 1)}px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
.caption { position: absolute; left: 0; right: 0; top: ${winY + BAR + ch + 26}px; display: flex; justify-content: center; }
.caption span { max-width: 1500px; padding: 10px 22px; border-radius: 10px; background: rgba(8,10,20,.72); color: #fff; font-size: 30px; font-weight: 500; line-height: 1.3; text-align: center; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${round(total, 3)}" data-width="${W}" data-height="${H}" data-fps="${FPS}">
  <div id="intro" class="card">
    ${appName ? `<div class="eyebrow">${esc(appName)}</div>` : ''}
    <h1>${esc(tour.title || id)}</h1>
    <div class="rule"></div>
  </div>
  <div id="main">
    <div id="window">
      <div id="bar">
        <div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
        <div id="address">
${urls.map((u, k) => '          ' + timed('url', k === 0 ? 0 : T(u.t), k + 1 < urls.length ? T(urls[k + 1].t) : total, esc(displayUrl(cfg, u.url)), `id="url-${k + 1}" `)).join('\n')}
        </div>
      </div>
      <div id="view">
        <div id="camera">
          <video id="recording" class="clip" src="recording.mp4" muted playsinline data-start="${INTRO}" data-duration="${round(R, 3)}" data-media-start="0"></video>
${rings.map((r) => `          <div id="${r.id}" class="ring" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`).join('\n')}
${presses.map((p, k) => `          <div id="ripple-${k}" class="ripple" style="left:${p.x}px;top:${p.y}px"></div>`).join('\n')}
          <svg id="cursor" viewBox="0 0 26 34"><path d="M2 2 L2 27 L8.5 21 L13 31.5 L17.5 29.5 L13 19.5 L22 19.5 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>
        </div>
      </div>
    </div>
${(look.captions ? captions : []).map((c, k) => '    ' + timed('caption', c.t0, c.t1, `<span>${esc(c.text)}</span>`, `id="caption-${k + 1}" `)).join('\n')}
  </div>
  <div id="outro" class="card">
    ${upNext ? '<div class="eyebrow">Up next</div>' : appName ? `<div class="eyebrow">${esc(appName)}</div>` : ''}
    <h1>${esc(upNext || tour.title || id)}</h1>
    <div class="rule"></div>
  </div>
${audio.map((a, k) => `  <audio id="voice-${k + 1}" src="${a.src}" data-start="${a.t}" data-duration="${a.d}" data-volume="1"></audio>`).join('\n')}
</div>
<script id="timeline-data" type="application/json">${JSON.stringify(data)}</script>
<script>
  const D = JSON.parse(document.getElementById('timeline-data').textContent);
  const tl = gsap.timeline({ paused: true });
  // Title card, then the browser window, then the closing card.
  tl.fromTo('#intro .eyebrow', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, 0.15);
  tl.fromTo('#intro h1', { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' }, 0.3);
  tl.fromTo('#intro .rule', { scaleX: 0, transformOrigin: '0 50%' }, { scaleX: 1, duration: 0.6, ease: 'power2.out' }, 0.55);
  tl.to('#intro', { opacity: 0, y: -20, duration: 0.5, ease: 'power2.in' }, D.introEnd - 0.55);
  tl.fromTo('#main', { opacity: 0, scale: 0.965 }, { opacity: 1, scale: 1, duration: 0.7, ease: 'power2.out' }, D.introEnd - 0.4);
  tl.to('#main', { opacity: 0, scale: 0.98, duration: 0.6, ease: 'power2.in' }, D.mainEnd);
  tl.fromTo('#outro', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' }, D.mainEnd + 0.3);
  // Pointer: glide to each target, dip on each press, with a ripple.
  tl.set('#cursor', { x: D.cursor.x, y: D.cursor.y, scale: 1 }, 0);
  for (const m of D.moves) tl.fromTo('#cursor', { x: m.x0, y: m.y0 }, { x: m.x1, y: m.y1, duration: m.t1 - m.t0, ease: 'power2.inOut', immediateRender: false }, m.t0);
  D.presses.forEach((p, k) => {
    tl.fromTo('#cursor', { scale: 1 }, { scale: 0.82, duration: 0.08, ease: 'power1.out', immediateRender: false }, p.t);
    tl.fromTo('#cursor', { scale: 0.82 }, { scale: 1, duration: 0.18, ease: 'power1.out', immediateRender: false }, p.t + 0.08);
    tl.fromTo('#ripple-' + k, { opacity: 0.6, scale: 0.2 }, { opacity: 0, scale: 1.7, duration: 0.6, ease: 'power2.out', immediateRender: false }, p.t);
  });
  // Rings around targets.
  for (const r of D.rings) {
    tl.fromTo('#' + r.id, { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.25, ease: 'power2.out', immediateRender: false }, r.t0);
    tl.fromTo('#' + r.id, { opacity: 1 }, { opacity: 0, duration: r.fade, ease: 'power1.in', immediateRender: false }, r.t1);
  }
  // Zoom: move the camera between views.
  for (const c of D.camera) tl.fromTo('#camera', { scale: c.from.z, x: c.from.x, y: c.from.y }, { scale: c.to.z, x: c.to.x, y: c.to.y, duration: c.dur, ease: 'power2.inOut', immediateRender: false }, c.t);
  window.__timelines = window.__timelines || {};
  window.__timelines['main'] = tl;
  tl.seek(0);
</script>
</body>
</html>
`;
  const steps = rec.steps.map((st) => ({ n: st.n, say: voice.steps[st.n - 1]?.say ?? null, start: T(st.start), end: T(st.end), action_at: st.action?.at != null ? T(st.action.at) : null }));
  return { html, total, zooms, captionList: captions, steps };
}

function vtt(captions) {
  const stamp = (t) => {
    const ms = Math.round(t * 1000);
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
    const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${sec}.${String(ms % 1000).padStart(3, '0')}`;
  };
  return `WEBVTT\n\n${captions.map((c, k) => `${k + 1}\n${stamp(c.t0)} --> ${stamp(c.t1)}\n${c.text}\n`).join('\n')}`;
}

// The stretches of a video where someone is speaking, from ffmpeg's silence detection.
function speechSegments(file, total) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
  const quiet = [];
  for (const m of String(r.stderr).matchAll(/silence_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') quiet.push([Number(m[2]), total]);
    else if (quiet.length) quiet.at(-1)[1] = Number(m[2]);
  }
  const speech = [];
  let t = 0;
  for (const [a, b] of quiet) {
    if (a > t) speech.push([t, a]);
    t = b;
  }
  if (t < total) speech.push([t, total]);
  return speech;
}

// Frames at every action and the narration timing, on one page, with anything that looks wrong.
function review({ id, tour, prod, comp, rec, speech }) {
  const dir = path.join(prod, 'review');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(prod, 'video.mp4');
  const problems = [];
  const rows = comp.steps.map((st) => {
    const t = st.action_at != null ? st.action_at + 0.1 : (st.start + st.end) / 2;
    const frame = `review/${String(st.n).padStart(2, '0')}.jpg`;
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', '-q:v', '3', path.join(prod, frame)]);
    const flags = [];
    let offset = null;
    if (st.say) {
      const onset = speech.find(([a]) => a >= st.start - 0.25 && a <= st.start + 0.8);
      if (onset) offset = round(onset[0] - st.start, 2);
      else flags.push(speech.some(([a, b]) => a < st.start && b > st.start + 0.3) ? 'The line starts while the one before is still being spoken' : 'No speech found where this line should start');
    }
    const diff = (rec.differences || []).find((d) => d.step === st.n);
    if (diff) flags.push(`The page differed from the approved storyboard. ${diff.added.length ? `Extra: ${diff.added.map((x) => `“${x}”`).join(', ')}. ` : ''}${diff.removed.length ? `Missing: ${diff.removed.map((x) => `“${x}”`).join(', ')}.` : ''}`.trim());
    for (const f of flags) problems.push(`step ${st.n}: ${f}`);
    return { ...st, frame, t, offset, flags };
  });
  const file = path.join(prod, 'review.html');
  const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  fs.writeFileSync(file, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tour.title || id)} review</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1c2027;--muted:#5d6471;--line:#e1e4ea;--ok:#2b8a3e;--bad:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#131519;--card:#1c1f25;--text:#e7e9ed;--muted:#9aa1ad;--line:#2b2f37;--ok:#69db7c;--bad:#ff8787}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}.muted{color:var(--muted)}
video{width:100%;max-width:960px;border-radius:10px;display:block;margin:16px 0}
.status{padding:10px 14px;border-radius:8px;margin:0 0 20px;font-weight:600;border:1px solid}.ok{color:var(--ok)}.bad{color:var(--bad)}
.step{display:grid;grid-template-columns:280px 1fr;gap:20px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
.step img{width:100%;border-radius:6px;border:1px solid var(--line);display:block}.say{font-size:17px;margin:6px 0}
ul{margin:6px 0 0;padding-left:18px}li{color:var(--bad)}
@media (max-width:760px){.step{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${esc(tour.title || id)}</h1>
<p class="muted">${clock(comp.total)} · ${comp.steps.length} steps · frames are taken just after each action, or midway through narration-only steps</p>
<video src="video.mp4" controls preload="metadata"></video>
<p class="status ${problems.length ? 'bad' : 'ok'}">${problems.length ? `${problems.length} thing${problems.length > 1 ? 's' : ''} to look at` : 'The narration lands where it should, and every page matched the storyboard.'}</p>
${rows.map((r) => `<section class="step"><div><strong>${r.n}</strong> <span class="muted">at ${clock(r.t)}${r.offset != null ? ` · voice ${r.offset >= 0 ? '+' : ''}${r.offset}s after the step starts` : ''}</span>
<p class="say">${esc(r.say || '(no narration)')}</p>${r.flags.length ? `<ul>${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>
<a href="${r.frame}" target="_blank"><img src="${r.frame}" alt="Step ${r.n}" loading="lazy"></a></section>`).join('\n')}
</main></body></html>
`);
  return { file, problems };
}

function link(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round(n, d = 3) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function tail(text, lines = 15) {
  return String(text || '').trim().split('\n').slice(-lines).join('\n');
}

function rel(p) {
  return path.relative(process.cwd(), p);
}
