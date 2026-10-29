#!/usr/bin/env node
// Find background music for the videos in Kevin MacLeod's incompetech catalog, which is free to use
// under Creative Commons Attribution 4.0 as long as the track is credited, and set it in config.yaml.
// Usage:
//   node music.mjs search [--feel Bright,Relaxed] [--q "piano"] [--limit 6]
//       Tracks that suit narration (calm or bright, no vocals), best first, with a page to listen to them:
//       tutorials/.cache/music/choices.html
//   node music.mjs pick "<title>"
//       Downloads the track to tutorials/assets/music/ and sets music in config.yaml, with its credit.
//       The credit goes into each video file's metadata and onto the bundle page's footer, not on screen.
//
// The catalog is incompetech's own machine-readable list (see incompetech.com/llms.txt), cached for a week.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { dataDir, done, fail, loadConfig, parseArgs } from './lib/common.mjs';

const CATALOG = 'https://incompetech.com/music/royalty-free/pieces.json';
const FILES = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
// Moods that sit well under a voice explaining software, and moods that fight it.
const GOOD = ['Bright', 'Relaxed', 'Calming', 'Uplifting', 'Grooving', 'Bouncy'];
const BAD = ['Dark', 'Eerie', 'Unnerving', 'Aggressive', 'Intense', 'Somber', 'Suspenseful', 'Mysterious', 'Epic', 'Action', 'Humorous'];

const args = parseArgs();
const { cfgFile, tutorials } = loadConfig(args.config);
const [command, ...rest] = args._;
const catalog = await loadCatalog();

if (command === 'search') search();
else if (command === 'pick') await pick(rest.join(' ') || args.title);
else fail('Use: music.mjs search [--feel Bright,Relaxed] [--q words] [--limit 6], or music.mjs pick "<title>"');

function search() {
  const feel = args.feel ? String(args.feel).split(',').map((f) => f.trim().toLowerCase()) : null;
  const words = args.q ? String(args.q).toLowerCase().split(/\s+/).filter(Boolean) : [];
  const limit = Number(args.limit || 6);
  const found = catalog
    .map((t) => ({ t, feels: feelsOf(t) }))
    .filter(({ t, feels }) =>
      seconds(t.length) >= 90 &&
      !/vocal|voice|choir/i.test(t.instruments || '') &&
      !feels.some((f) => BAD.includes(f)) &&
      (feel ? feel.some((f) => feels.map((x) => x.toLowerCase()).includes(f)) : feels.some((f) => GOOD.includes(f))) &&
      words.every((w) => `${t.title} ${t.description} ${t.instruments} ${t.feel}`.toLowerCase().includes(w)))
    // Calm, steady tracks with suitable moods first, then the newest recordings.
    .sort((a, b) => fit(b) - fit(a) || String(b.t.uploaded).localeCompare(String(a.t.uploaded)))
    .slice(0, limit)
    .map(({ t, feels }) => ({ title: t.title, feel: feels.join(', '), bpm: t.bpm ? Number(t.bpm) : null, length: t.length?.replace(/^00:/, ''), instruments: t.instruments, about: firstSentence(t.description), listen: FILES + encodeURIComponent(t.filename) }));
  if (!found.length) fail('No tracks match. Try fewer words or another feel.', { feels: GOOD });
  const page = path.join(tutorials, '.cache', 'music', 'choices.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, choicesPage(found));
  done({ ok: true, page: path.relative(process.cwd(), page), tracks: found, license: 'Creative Commons Attribution 4.0: free with a credit. walkcast keeps it in the video files and the bundle page; anywhere else the videos are posted, put it in the description' });
}

async function pick(title) {
  if (!title) fail('Name the track: music.mjs pick "<title>"');
  const t = catalog.find((x) => x.title.toLowerCase() === String(title).toLowerCase());
  if (!t) fail(`No track called "${title}" in the catalog.`, { similar: catalog.filter((x) => x.title.toLowerCase().includes(String(title).toLowerCase().slice(0, 5))).slice(0, 5).map((x) => x.title) });
  const name = `${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.mp3`;
  const file = path.join(tutorials, 'assets', 'music', name);
  if (!fs.existsSync(file)) {
    const res = await fetch(FILES + encodeURIComponent(t.filename)).catch((e) => ({ ok: false, statusText: e.message }));
    if (!res.ok) fail(`Couldn't download "${t.title}": ${res.status || ''} ${res.statusText}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  // The credit incompetech asks for, word for word.
  const credit = `"${t.title}" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/`;
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.set('music', doc.createNode({ file: path.relative(tutorials, file).split(path.sep).join('/'), credit, isrc: t.isrc || undefined }));
  fs.writeFileSync(cfgFile, doc.toString());
  done({ ok: true, title: t.title, file: path.relative(process.cwd(), file), credit, note: 'Every video with this music needs rendering again; render.mjs notices by itself.' });
}

async function loadCatalog() {
  const file = path.join(dataDir(), 'music', 'incompetech.json');
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 86400000;
  if (!fresh) {
    try {
      const res = await fetch(CATALOG, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      JSON.parse(text);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    } catch (e) {
      if (!fs.existsSync(file)) fail(`Couldn't load the incompetech catalog: ${e.message}. Check the internet connection and try again.`);
    }
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).filter((t) => t.title && t.filename);
}

// How well a track sits under narration: suitable moods, calm ones most, and nothing busy or fast.
function fit({ t, feels }) {
  let score = feels.filter((f) => GOOD.includes(f)).length;
  if (feels.includes('Relaxed') || feels.includes('Calming')) score += 1;
  if (/trumpet|trombone|brass|horn|drum kit|distort/i.test(t.instruments || '')) score -= 1;
  if (Number(t.bpm) > 140) score -= 1;
  return score;
}

function feelsOf(t) {
  return String(t.feel || '').split(',').map((f) => f.trim()).filter(Boolean);
}

function seconds(hms) {
  return String(hms || '0').split(':').reduce((s, p) => s * 60 + Number(p || 0), 0);
}

function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^.{20,200}?[.!?](\s|$)/);
  return (m ? m[0] : s.slice(0, 200)).trim();
}

function choicesPage(tracks) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Music choices</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f27;--muted:#5f6673;--line:#e3e6eb;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#e8eaee;--muted:#9aa1ad;--line:#2a2e37;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 56px}h1{font-size:26px;margin:0 0 6px}p.lede{color:var(--muted);margin:0 0 24px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px}
h2{font-size:18px;margin:0 0 2px}.meta{color:var(--muted);font-size:14px;margin:0 0 8px}audio{width:100%;margin-top:8px}
</style></head><body><main>
<h1>Music choices</h1>
<p class="lede">Each plays quietly under the narration, so listen for something that doesn't pull attention. All are by Kevin MacLeod, free to use with a credit, which walkcast keeps out of the picture: it goes in the video files' details and the bundle page. Tell Claude which one you'd like, or ask for something different.</p>
${tracks.map((t) => `<section><h2>${esc(t.title)}</h2><p class="meta">${esc(t.feel)}${t.bpm ? ` · ${t.bpm} bpm` : ''} · ${esc(t.length)} · ${esc(t.instruments)}</p><p>${esc(t.about)}</p><audio controls preload="none" src="${esc(t.listen)}"></audio></section>`).join('\n')}
</main></body></html>
`;
}
