#!/usr/bin/env node
// Gather the finished videos and SOPs into one folder to publish or share, with a page that shows them all.
// Usage: node bundle.mjs [<tutorial-id> ...] [--config tutorials/config.yaml] [--out tutorials/dist]
//
// For each item in plan.yaml, in plan order, writes <out>/<id>/:
//   <id>.mp4            the video, with its title and chapters inside, and its captions unless they're burned in
//   <id>.vtt            its captions
//   <id>.chapters.vtt   a chapter per step, named by its narration
//   <id>.jpg            a thumbnail: how the tour ends, from its storyboard, framed like the video
//   <id>.md, <id>.pdf   the SOP (sop and both items), with the step screenshots sop.md asks for in images/
// plus <out>/index.html, a page that plays each video beside its steps and shows each SOP, and
// <out>/tutorials.json, the same as data. index.html works opened from disk or from any web host.
// A video that isn't produced, or doesn't match its approved tour, is left out and listed in not_included.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { done, fail, launchBrowser, loadConfig, lock, musicOf, parseArgs, readYaml, today, writeJson } from './lib/common.mjs';
import { displayUrl, videoProblem } from './lib/produce.mjs';
import { approvalProblem } from './lib/tour.mjs';

let marked;
try {
  ({ marked } = await import('marked'));
} catch {
  fail('The plugin dependencies are not installed. Run: npm install --prefix "<plugin folder>"');
}

// The narrator's language, from the first letter of the Kokoro voice.
const LANGS = {
  a: { code: 'en-US', iso3: 'eng', label: 'English' }, b: { code: 'en-GB', iso3: 'eng', label: 'English' },
  e: { code: 'es', iso3: 'spa', label: 'Español' }, f: { code: 'fr', iso3: 'fra', label: 'Français' },
  h: { code: 'hi', iso3: 'hin', label: 'हिन्दी' }, i: { code: 'it', iso3: 'ita', label: 'Italiano' },
  j: { code: 'ja', iso3: 'jpn', label: '日本語' }, p: { code: 'pt-BR', iso3: 'por', label: 'Português' },
  z: { code: 'zh', iso3: 'zho', label: '中文' },
};
// ![Alt](step:3) is step 3's screenshot as the step starts, with its target ringed; step:3:after is its result.
const STEP_IMAGE = /(?<=\])\(step:(\d+)(?::(after))?\)/g;

const args = parseArgs();
const { cfg, tutorials } = loadConfig(args.config);
const planFile = path.join(tutorials, 'plan.yaml');
if (!fs.existsSync(planFile)) fail('No tutorials/plan.yaml yet. Run /tutorials:plan first.');
const plan = readYaml(planFile);
const unknown = args._.filter((id) => !(plan.items || []).some((it) => it.id === id));
if (unknown.length) fail(`Not in plan.yaml: ${unknown.join(', ')}`);
const items = (plan.items || []).filter((it) => !args._.length || args._.includes(it.id));
if (spawnSync('ffmpeg', ['-version']).status !== 0) fail('Bundling needs ffmpeg. Install it with "brew install ffmpeg" (macOS) or your package manager.');

const out = path.resolve(args.out || path.join(tutorials, 'dist'));
// Only ever replace a folder this script made, so --out can't wipe anything else.
if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'tutorials.json'))) {
  fail(`${rel(out)} already has files that bundle.mjs didn't make. Choose a new or empty folder with --out.`);
}
const appName = cfg.app?.name || '';
const brand = { color: cfg.brand?.color || '#4c6ef5', background: cfg.brand?.background || '#141a2e' };
const lang = LANGS[String(cfg.voice?.voice || 'a')[0]] || LANGS.a;
const paper = String(cfg.bundle?.paper || 'a4').toLowerCase() === 'letter' ? 'Letter' : 'A4';
const burnedIn = cfg.video?.captions !== false;
const musicCredit = musicOf(cfg)?.credit || null;

const held = lock(tutorials, 'bundle');
if (held.error) fail(held.error);
const tmp = `${out}.tmp-${process.pid}`;
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const entries = [];
const notIncluded = [];
const problems = [];
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  for (const item of items) {
    const r = await bundleItem(page, item);
    notIncluded.push(...r.left);
    if (r.entry) entries.push(r.entry);
    if (r.entry?.video?.problems.length) problems.push({ id: item.id, problems: r.entry.video.problems });
  }
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fail(`Bundling stopped: ${String(e?.message || e).split('\n')[0]}`);
} finally {
  await browser?.close();
}
if (!entries.length) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fail('Nothing is ready to bundle yet.', { not_included: notIncluded });
}

const generated = today();
const manifest = {
  app: appName || null,
  generated,
  music_credit: musicCredit,
  items: entries.map(({ sop, video, ...e }) => ({
    ...e,
    video: video ? { file: video.file, captions: video.captions, chapters_file: video.chapters_file, duration: video.duration, chapters: video.chapters } : null,
    sop: sop ? { markdown: sop.markdown, pdf: sop.pdf, images: sop.images } : null,
  })),
};
writeJson(path.join(tmp, 'tutorials.json'), manifest);
fs.writeFileSync(path.join(tmp, 'index.html'), indexPage(entries, generated));

// Swap the new bundle in.
const old = `${out}.old-${process.pid}`;
if (fs.existsSync(out)) fs.renameSync(out, old);
fs.renameSync(tmp, out);
fs.rmSync(old, { recursive: true, force: true });
held.release();

done({
  ok: true,
  out: rel(out),
  index: rel(path.join(out, 'index.html')),
  videos: entries.filter((e) => e.video).length,
  sops: entries.filter((e) => e.sop).length,
  items: entries.map((e) => ({ id: e.id, video: e.video?.file || null, sop: e.sop?.pdf || null, thumbnail: e.thumbnail })),
  not_included: notIncluded,
  problems,
  complete: !notIncluded.length,
});

async function bundleItem(page, item) {
  const id = item.id;
  const src = path.join(tutorials, id);
  const dest = path.join(tmp, id);
  const tourFile = path.join(src, 'tour.yaml');
  const tour = fs.existsSync(tourFile) ? readYaml(tourFile) : null;
  const sb = storyboardOf(tour, src);
  const kind = item.kind || 'video';
  const entry = { id, title: item.title || tour?.title || id, kind, audience: item.audience || null, goal: item.goal || null, thumbnail: null };
  const left = [];
  fs.mkdirSync(dest, { recursive: true });

  if (kind !== 'sop') {
    const problem = videoProblem({ cfg, plan, tutorials, id });
    const video = problem ? { error: problem } : writeVideo(id, entry.title, src, dest);
    if (video.error) left.push({ id, what: 'video', reason: video.error });
    else entry.video = video;
  }
  if (kind !== 'video') {
    const sop = await writeSop(page, id, entry.title, src, dest, sb);
    if (sop.error) left.push({ id, what: 'sop', reason: sop.error });
    else entry.sop = sop;
  }
  if (!entry.video && !entry.sop) {
    fs.rmSync(dest, { recursive: true, force: true });
    return { entry: null, left };
  }
  entry.thumbnail = await writeThumbnail(page, id, src, dest, sb, entry.video);
  return { entry, left };
}

// The storyboard's steps, if its screenshots show the tour as approved.
function storyboardOf(tour, dir) {
  const file = path.join(dir, 'storyboard', 'steps.json');
  if (!tour || approvalProblem(tour) || !fs.existsSync(file)) return null;
  const sb = JSON.parse(fs.readFileSync(file, 'utf8'));
  return sb.ok && sb.tour_hash === tour.approved_hash ? sb : null;
}

// The finished video with its title and chapters inside, so they travel with the file.
function writeVideo(id, title, src, dest) {
  const prod = path.join(src, 'produce');
  const info = JSON.parse(fs.readFileSync(path.join(prod, 'video.json'), 'utf8'));
  const steps = info.steps || [];
  const chapters = steps.map((st, k) => ({
    start: k === 0 ? 0 : st.start,
    end: k + 1 < steps.length ? steps[k + 1].start : info.duration,
    title: String(st.say || `Step ${st.n}`).trim(),
  }));
  const captions = path.join(prod, 'captions.vtt');
  fs.copyFileSync(captions, path.join(dest, `${id}.vtt`));
  fs.writeFileSync(path.join(dest, `${id}.chapters.vtt`), chaptersVtt(chapters));
  const meta = path.join(tmp, `.${id}.ffmeta`);
  const field = (s) => String(s).replace(/[=;#\\\n]/g, (c) => (c === '\n' ? ' ' : `\\${c}`));
  fs.writeFileSync(meta, [';FFMETADATA1', `title=${field(title)}`, ...(appName ? [`album=${field(appName)}`] : []), ...(musicCredit ? [`comment=${field(`Music: ${musicCredit.replace(/\n/g, ' · ')}`)}`] : []),
    ...chapters.flatMap((c) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(c.end * 1000)}`, `title=${field(c.title)}`])].join('\n') + '\n');
  // Captions go inside only when they aren't burned into the picture: MP4 players show the first caption track
  // by default, which would put them on screen twice.
  const subs = burnedIn ? [[], []] : [['-i', captions], ['-map', '2:s', '-c:s', 'mov_text', '-metadata:s:s:0', `language=${lang.iso3}`]];
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(prod, 'video.mp4'), '-f', 'ffmetadata', '-i', meta, ...subs[0],
    '-map', '0:v', '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'copy', '-c:a', 'copy', ...subs[1],
    '-movflags', '+faststart', path.join(dest, `${id}.mp4`)], { encoding: 'utf8' });
  fs.rmSync(meta, { force: true });
  if (r.status !== 0) return { error: `ffmpeg couldn't add the chapters and captions: ${String(r.stderr).trim().split('\n').pop()}` };
  return {
    file: `${id}/${id}.mp4`,
    captions: `${id}/${id}.vtt`,
    chapters_file: `${id}/${id}.chapters.vtt`,
    duration: info.duration,
    chapters: chapters.map((c) => ({ start: round(c.start), title: c.title })),
    problems: info.problems || [],
    vtt: fs.readFileSync(captions, 'utf8'),
  };
}

// The SOP as Markdown and PDF, with the storyboard screenshots it asks for.
async function writeSop(page, id, title, src, dest, sb) {
  const file = path.join(src, 'sop.md');
  if (!fs.existsSync(file)) return { error: 'it has no sop.md' };
  let md = fs.readFileSync(file, 'utf8');
  const refs = [...md.matchAll(STEP_IMAGE)];
  if (refs.length && !sb) return { error: "its screenshots come from the storyboard, which doesn't show the tour as approved. Run storyboard.mjs for it and approve it." };
  const images = new Map();
  for (const [, num, after] of refs) {
    const key = `${String(num).padStart(2, '0')}${after ? '-after' : ''}`;
    if (images.has(key)) continue;
    const st = sb.steps.find((s) => s.n === Number(num));
    const shot = after ? st?.after : st?.before;
    if (!shot) return { error: `sop.md shows step ${num}${after ? "'s result" : ''}, but the storyboard has no ${after ? 'after' : 'before'} screenshot for that step.` };
    fs.mkdirSync(path.join(dest, 'images'), { recursive: true });
    await stepImage(page, path.join(src, shot), after ? null : st.box, path.join(dest, 'images', `${key}.jpg`));
    images.set(key, `images/${key}.jpg`);
  }
  md = md.replace(STEP_IMAGE, (_, num, after) => `(${images.get(`${String(num).padStart(2, '0')}${after ? '-after' : ''}`)})`);
  fs.writeFileSync(path.join(dest, `${id}.md`), md);

  const html = marked.parse(md, { gfm: true, breaks: true, async: false });
  const printFile = path.join(dest, `.${id}.print.html`);
  fs.writeFileSync(printFile, printPage(title, html));
  await page.goto(pathToFileURL(printFile).href, { waitUntil: 'load' });
  const footer = `<div style="font:8px system-ui,-apple-system,sans-serif;color:#7b818c;width:100%;padding:0 16mm;display:flex;justify-content:space-between"><span>${esc([appName, title].filter(Boolean).join(' · '))}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  await page.pdf({ path: path.join(dest, `${id}.pdf`), format: paper, printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer, margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' } });
  fs.rmSync(printFile);
  // The page shows the title itself, so its copy of the SOP starts after the heading.
  const inPage = marked.parse(md.replace(/^\s*# [^\n]*\n+/, ''), { gfm: true, breaks: true, async: false }).replace(/(<img [^>]*src=")images\//g, `$1${id}/images/`);
  return { markdown: `${id}/${id}.md`, pdf: `${id}/${id}.pdf`, images: [...images.values()].map((p) => `${id}/${p}`), html: inPage };
}

// A storyboard screenshot with the step's target ringed and the rest dimmed, cropped around the target so
// its text stays readable on a page. A result shot (no target) keeps the whole screen.
async function stepImage(page, src, box, dest) {
  await page.setContent(`<body style="margin:0"><img id="shot" style="display:block" src="data:image/jpeg;base64,${fs.readFileSync(src).toString('base64')}">${box
    ? `<div style="position:absolute;left:${box.x - 8}px;top:${box.y - 8}px;width:${box.width + 16}px;height:${box.height + 16}px;border:5px solid ${brand.color};border-radius:9px;box-shadow:0 0 0 2px #fff,0 0 0 9999px rgba(10,12,20,.25)"></div>`
    : ''}</body>`, { waitUntil: 'load' });
  const size = await page.evaluate(() => ({ width: document.getElementById('shot').naturalWidth, height: document.getElementById('shot').naturalHeight }));
  await page.setViewportSize(size);
  let clip;
  if (box) {
    let width = Math.min(size.width, Math.max(Math.round(size.width * 0.65), box.width + 240));
    if (width > size.width * 0.85) width = size.width;
    const height = Math.min(size.height, Math.max(Math.round(width * 9 / 16), box.height + 160));
    // Centered on the target, but snapped to an edge of the screen when it's close, rather than cutting words.
    const snap = (start, length, total) => {
      const v = clamp(Math.round(start), 0, total - length);
      return v < length * 0.25 ? 0 : total - length - v < length * 0.25 ? total - length : v;
    };
    clip = { x: snap(box.x + box.width / 2 - width / 2, width, size.width), y: snap(box.y + box.height / 2 - height / 2, height, size.height), width, height };
  }
  await page.screenshot({ path: dest, type: 'jpeg', quality: 85, clip });
}

// A 1280x720 thumbnail: the tour's last screen, in a browser window on the brand background like the video.
// Without a storyboard, a video's title card stands in.
async function writeThumbnail(page, id, src, dest, sb, video) {
  const file = path.join(dest, `${id}.jpg`);
  const last = sb?.steps.at(-1);
  const shot = last && (last.after || last.before);
  if (shot && fs.existsSync(path.join(src, shot))) {
    const url = displayUrl(cfg, last.url_after || last.url);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setContent(`<!doctype html><html><head><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden}
body{display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:radial-gradient(800px 470px at 20% 0%,color-mix(in srgb,${brand.color} 35%,transparent),transparent 70%),
             radial-gradient(670px 400px at 100% 100%,color-mix(in srgb,${brand.color} 22%,transparent),transparent 70%),${brand.background}}
.win{border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 24px 60px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06)}
.bar{position:relative;height:27px;background:#eceef2;border-bottom:1px solid #d9dce3}
.dots{position:absolute;left:11px;top:9px;display:flex;gap:6px}.dots i{width:9px;height:9px;border-radius:50%;display:block}
.url{position:absolute;left:50%;top:5px;transform:translateX(-50%);width:46%;height:17px;border-radius:5px;background:#fff;border:1px solid #d9dce3;
  font-size:10px;line-height:17px;color:#5d6471;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
img{display:block;max-width:1000px;max-height:600px}
</style></head><body><div class="win"><div class="bar"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><div class="url">${esc(url)}</div></div>
<img src="data:image/jpeg;base64,${fs.readFileSync(path.join(src, shot)).toString('base64')}"></div></body></html>`, { waitUntil: 'load' });
    await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    return `${id}/${id}.jpg`;
  }
  if (!video) return null;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', '1.5', '-i', path.join(src, 'produce', 'video.mp4'), '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '3', file]);
  return r.status === 0 ? `${id}/${id}.jpg` : null;
}

function chaptersVtt(chapters) {
  return `WEBVTT\n\n${chapters.map((c, k) => `${k + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.title}\n`).join('\n')}`;
}

function stamp(t) {
  const ms = Math.round(t * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
}

function printPage(title, body) {
  return `<!doctype html>
<html lang="${lang.code}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{margin:0;color:#1b1f27;font:10.5pt/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif}
.app{font-size:9pt;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${brand.color};margin-bottom:4pt}
h1{font-size:21pt;line-height:1.2;margin:0 0 12pt;letter-spacing:-.01em}
h2{font-size:13pt;margin:18pt 0 6pt;padding-bottom:3pt;border-bottom:1px solid #e3e6eb;break-after:avoid}
h3{font-size:11pt;margin:12pt 0 4pt;break-after:avoid}
p{margin:0 0 7pt}ol,ul{margin:0 0 8pt;padding-left:18pt}li{margin:0 0 5pt}li::marker{font-weight:600}
strong{font-weight:650}code{font:9.5pt ui-monospace,Menlo,monospace;background:#f1f3f6;padding:1pt 3pt;border-radius:3pt}
img{display:block;max-width:100%;max-height:105mm;margin:5pt 0 9pt;border:1px solid #d5d9e0;border-radius:4pt;break-inside:avoid}
table{border-collapse:collapse;margin:0 0 9pt}th,td{border:1px solid #e3e6eb;padding:3pt 6pt;text-align:left}
</style></head><body>
${appName ? `<div class="app">${esc(appName)}</div>\n` : ''}${body}
</body></html>
`;
}

function indexPage(list, generated) {
  const total = list.reduce((s, e) => s + (e.video?.duration || 0), 0);
  const nVideos = list.filter((e) => e.video).length;
  const nSops = list.filter((e) => e.sop).length;
  const counts = [nVideos && `${nVideos} video${nVideos > 1 ? 's' : ''}`, nSops && `${nSops} step-by-step guide${nSops > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
  const title = appName ? `${appName} tutorials` : 'Tutorials';
  const data = {
    app: appName,
    title,
    credit: musicCredit,
    summary: `${counts}${total ? ` · ${Math.max(1, Math.round(total / 60))} min of video` : ''}`,
    generated,
    lang: lang.label,
    srclang: lang.code,
    burnedIn,
    items: list.map((e) => ({ ...e, video: e.video && { file: e.video.file, captions: e.video.captions, duration: e.video.duration, chapters: e.video.chapters, vtt: e.video.vtt }, sop: e.sop && { markdown: e.sop.markdown, pdf: e.sop.pdf, html: e.sop.html } })),
  };
  return `<!doctype html>
<html lang="${lang.code}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--accent:${brand.color};--bg:#f6f7f9;--card:#fff;--text:#1b1f27;--muted:#5f6673;--line:#e3e6eb;--chip:#eef0f4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#e8eaee;--muted:#9aa1ad;--line:#2a2e37;--chip:#242832;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding:40px 16px 72px}.wrap:focus{outline:none}
.eyebrow{font-size:14px;font-weight:600;color:var(--accent);margin:0}
h1{font-size:32px;line-height:1.2;letter-spacing:-.01em;margin:4px 0 8px}
.lede{color:var(--muted);margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:20px;list-style:none;margin:0;padding:0}
.card{display:flex;flex-direction:column;height:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;text-decoration:none;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(0,0,0,.09)}
.card:focus-visible,.steps button:focus-visible,.files a:focus-visible,.back:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.thumb{position:relative;aspect-ratio:16/9;background:var(--chip);display:grid;place-items:center;color:var(--accent)}
.thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.badge{position:absolute;right:10px;bottom:10px;padding:2px 8px;border-radius:6px;background:rgba(10,12,20,.8);color:#fff;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.card .body{padding:14px 16px 18px}
.kind{font-size:13px;color:var(--muted);margin:0}
.card h2{font-size:18px;line-height:1.3;margin:4px 0 6px}
.card p.goal{margin:0;color:var(--muted);font-size:15px}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--muted);text-decoration:none;font-size:15px;margin-bottom:18px;border-radius:6px}
.back:hover{color:var(--text)}
.meta{color:var(--muted);margin:0 0 4px;font-size:15px}
.player{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;margin:22px 0 16px}
video{display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px}
.steps{position:relative;background:var(--card);border:1px solid var(--line);border-radius:12px;min-height:200px}
.steps ol{position:absolute;inset:0;overflow:auto;list-style:none;margin:0;padding:6px}
.steps button{display:grid;grid-template-columns:42px 1fr;gap:6px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;font-size:15px;line-height:1.45;text-align:left;cursor:pointer}
.steps button:hover{background:var(--chip)}
.steps button.on{background:color-mix(in srgb,var(--accent) 15%,transparent)}
.steps time{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;padding-top:2px}
.files{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 32px;padding:0;list-style:none}
.files a{display:inline-block;padding:8px 14px;border:1px solid var(--line);border-radius:9px;background:var(--card);text-decoration:none;font-size:14px;font-weight:500}
.files a:hover{border-color:var(--accent)}
.files li:first-child a{background:var(--accent);border-color:var(--accent);color:#fff}
.guide{font-size:22px;margin:0 0 14px}
.sop{max-width:820px;padding:28px 32px;background:var(--card);border:1px solid var(--line);border-radius:14px}
.sop > :first-child{margin-top:0}
.sop h2{font-size:20px;margin:28px 0 10px}.sop li{margin:6px 0}.sop p{margin:0 0 10px}
.sop img{display:block;max-width:100%;height:auto;margin:10px 0 14px;border:1px solid var(--line);border-radius:8px}
.sop table{border-collapse:collapse}.sop th,.sop td{border:1px solid var(--line);padding:4px 8px;text-align:left}
.sop code{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:var(--chip);padding:1px 4px;border-radius:4px}
.pager{display:flex;justify-content:space-between;gap:16px;margin-top:40px;padding-top:20px;border-top:1px solid var(--line)}
.pager a{text-decoration:none;color:var(--muted);max-width:48%}.pager a:hover{color:var(--text)}.pager strong{display:block;color:var(--text);font-weight:600}
footer{margin-top:48px;color:var(--muted);font-size:13px}.credit{margin:6px 0 0}
@media (max-width:900px){.player{grid-template-columns:1fr}.steps ol{position:static;max-height:320px}}
@media (max-width:600px){h1{font-size:26px}.sop{padding:20px 18px}}
</style>
</head>
<body>
<main class="wrap" id="app" tabindex="-1"></main>
<script type="application/json" id="data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
const data = JSON.parse(document.getElementById('data').textContent);
const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const docIcon = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
const kindOf = (it) => it.video && it.sop ? 'Video and guide' : it.video ? 'Video' : 'Step-by-step guide';

function home() {
  document.title = data.title;
  app.innerHTML = (data.app ? '<p class="eyebrow">' + esc(data.app) + '</p>' : '') +
    '<h1>Tutorials</h1><p class="lede">' + esc(data.summary) + '</p><ol class="grid">' +
    data.items.map((it, i) => '<li><a class="card" href="#' + encodeURIComponent(it.id) + '"><div class="thumb">' +
      (it.thumbnail ? '<img src="' + esc(it.thumbnail) + '" alt="" loading="lazy">' : docIcon) +
      (it.video ? '<span class="badge">' + clock(it.video.duration) + '</span>' : '') +
      '</div><div class="body"><p class="kind">' + (i + 1) + ' · ' + kindOf(it) + '</p><h2>' + esc(it.title) + '</h2>' +
      (it.goal ? '<p class="goal">' + esc(it.goal) + '</p>' : '') + '</div></a></li>').join('') +
    '</ol><footer>Updated ' + esc(data.generated) + (data.credit ? '<p class="credit">Music: ' + esc(data.credit).replace(/\\n/g, '<br>') + '</p>' : '') + '</footer>';
}

function detail(it, i) {
  document.title = it.title + (data.app ? ' · ' + data.app : '');
  const files = [];
  if (it.video) files.push(['Download the video', it.video.file], ['Captions (VTT)', it.video.captions]);
  if (it.sop) files.push(['Guide as PDF', it.sop.pdf], ['Guide as Markdown', it.sop.markdown]);
  const prev = data.items[i - 1];
  const next = data.items[i + 1];
  app.innerHTML = '<a class="back" href="#">← All tutorials</a>' +
    '<p class="meta">' + (i + 1) + ' of ' + data.items.length + ' · ' + kindOf(it) + (it.video ? ' · ' + clock(it.video.duration) : '') + (it.audience ? ' · For ' + esc(it.audience.charAt(0).toLowerCase() + it.audience.slice(1)) : '') + '</p>' +
    '<h1>' + esc(it.title) + '</h1>' + (it.goal ? '<p class="lede">' + esc(it.goal) + '</p>' : '') +
    (it.video ? '<div class="player"><video controls preload="metadata" playsinline src="' + esc(it.video.file) + '"' + (it.thumbnail ? ' poster="' + esc(it.thumbnail) + '"' : '') + ' aria-label="' + esc(it.title) + '"></video>' +
      '<nav class="steps" aria-label="Steps"><ol>' + it.video.chapters.map((c, k) => '<li><button type="button" data-k="' + k + '"><time>' + clock(c.start) + '</time><span>' + esc(c.title) + '</span></button></li>').join('') + '</ol></nav></div>' : '') +
    '<ul class="files">' + files.map(([label, href]) => '<li><a href="' + esc(href) + '" download>' + label + '</a></li>').join('') + '</ul>' +
    (it.sop ? (it.video ? '<h2 class="guide">Step-by-step guide</h2>' : '') + '<article class="sop">' + it.sop.html + '</article>' : '') +
    '<nav class="pager" aria-label="More tutorials">' + (prev ? '<a href="#' + encodeURIComponent(prev.id) + '">← Previous<strong>' + esc(prev.title) + '</strong></a>' : '<span></span>') +
    (next ? '<a href="#' + encodeURIComponent(next.id) + '" style="text-align:right">Next →<strong>' + esc(next.title) + '</strong></a>' : '') + '</nav>';
  if (it.video) wire(it);
}

function wire(it) {
  const video = app.querySelector('video');
  // Captions as a track built from the page itself, so they load even when the page is opened from disk.
  const track = document.createElement('track');
  track.kind = 'captions';
  track.label = data.lang;
  track.srclang = data.srclang;
  track.src = URL.createObjectURL(new Blob([it.video.vtt], { type: 'text/vtt' }));
  if (!data.burnedIn) track.default = true;
  video.append(track);
  const list = app.querySelector('.steps ol');
  const buttons = [...list.querySelectorAll('button')];
  buttons.forEach((b) => b.addEventListener('click', () => {
    video.currentTime = it.video.chapters[Number(b.dataset.k)].start + 0.01;
    video.play().catch(() => {});
  }));
  let current = -1;
  video.addEventListener('timeupdate', () => {
    let k = 0;
    while (k + 1 < it.video.chapters.length && it.video.chapters[k + 1].start <= video.currentTime) k++;
    if (k === current) return;
    buttons[current]?.classList.remove('on');
    buttons[k].classList.add('on');
    // Keep the current step in view in the list, without scrolling the page.
    const b = buttons[k].getBoundingClientRect();
    const l = list.getBoundingClientRect();
    if (b.top < l.top || b.bottom > l.bottom) list.scrollTop += b.top - l.top - 6;
    current = k;
  });
}

function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  const i = data.items.findIndex((it) => it.id === id);
  if (i >= 0) detail(data.items[i], i);
  else home();
  window.scrollTo(0, 0);
  if (i >= 0) app.focus({ preventScroll: true });
}
addEventListener('hashchange', route);
route();
</script>
</body>
</html>
`;
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

function rel(p) {
  return path.relative(process.cwd(), p) || '.';
}
