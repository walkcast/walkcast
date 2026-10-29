#!/usr/bin/env node
// Measure how the running app looks, so the videos and the bundle can match it: its brand color (from
// the buttons and links people actually see), the color behind the video's browser window, its language,
// its public address and its icons. Claude checks these against the code and asks the user to confirm.
// Usage: node look.mjs [--role <id>] [--config tutorials/config.yaml]
//
// Writes tutorials/discovery/look.json and prints it, with `suggest` holding values ready for config.yaml.
import fs from 'node:fs';
import path from 'node:path';
import { absUrl, authFile, done, launchBrowser, loadConfig, parseArgs, pickRole, writeJson } from './lib/common.mjs';

const args = parseArgs();
const { cfg, tutorials } = loadConfig(args.config);
const role = pickRole(cfg, args.role);
const session = authFile(tutorials, role.id);
const pages = (cfg.crawl.start?.length ? cfg.crawl.start : ['/']).slice(0, 3).map((p) => absUrl(cfg.app.url, p));

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: cfg.crawl.viewport || { width: 1440, height: 900 }, storageState: fs.existsSync(session) ? session : undefined });
const page = await context.newPage();
const seen = [];
let meta = null;
for (const url of pages) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch {
    continue;
  }
  const found = await page.evaluate(measure);
  meta = meta || found.meta;
  seen.push(...found.colors);
}
let manifest = null;
if (meta?.manifest) {
  try {
    manifest = await (await context.request.get(new URL(meta.manifest, page.url()).href)).json();
  } catch {}
}
await browser.close();
if (!meta) done({ ok: false, error: `Couldn't open ${pages.join(', ')}. Is the app running? Try app.mjs start.` }, 1);

// The brand color is the saturated color used most on buttons, then links, weighted by how much of it shows.
const tally = new Map();
for (const c of seen) {
  const rgb = parse(c.color);
  if (!rgb || saturation(rgb) < 0.3 || luminance(rgb) > 0.85 || luminance(rgb) < 0.02) continue;
  const key = hex(rgb);
  const t = tally.get(key) || { hex: key, buttons: 0, links: 0, area: 0 };
  t[c.kind === 'button' ? 'buttons' : 'links'] += 1;
  t.area += c.area;
  tally.set(key, t);
}
const ranked = [...tally.values()].sort((a, b) => b.buttons - a.buttons || b.area - a.area || b.links - a.links);
const themeColor = parse(meta.themeColor || manifest?.theme_color || '');
let color = ranked[0]?.hex || (themeColor && saturation(themeColor) >= 0.3 ? hex(themeColor) : null);
// Rings, ripples and buttons on the index page carry white text, so keep the color dark enough for it.
if (color) {
  let rgb = parse(color);
  while (contrast(rgb, [255, 255, 255]) < 3) rgb = rgb.map((v) => Math.round(v * 0.9));
  color = hex(rgb);
}
// Behind the window: the app's own dark sidebar or header if it has one, else a deep shade of the brand.
const dark = seen.filter((c) => c.kind === 'chrome').map((c) => parse(c.color)).find((rgb) => rgb && luminance(rgb) < 0.05);
const background = dark ? hex(dark.map((v) => Math.round(v * 0.8))) : color ? hex(mix(parse(color), [11, 14, 23], 0.85)) : null;
const lang = (meta.lang || '').toLowerCase();
const publicUrl = [meta.canonical, meta.ogUrl].map((u) => { try { return new URL(u); } catch { return null; } }).find((u) => u && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname));

const result = {
  ok: true,
  pages,
  title: meta.title,
  site_name: meta.siteName || manifest?.name || null,
  lang: lang || null,
  theme_color: meta.themeColor || manifest?.theme_color || null,
  public_url: publicUrl ? publicUrl.origin : null,
  icons: [...new Set([...meta.icons, ...(manifest?.icons || []).map((i) => i.src)])].map((u) => { try { return new URL(u, cfg.app.url).href; } catch { return u; } }).slice(0, 6),
  logos: meta.logos,
  colors: ranked.slice(0, 5),
  suggest: {
    brand: color ? { color, background } : null,
    display_url: publicUrl ? publicUrl.origin : null,
    voice: lang && !lang.startsWith('en') ? `The app is in "${lang}". Kokoro speaks es, fr, it, pt and hi; Ming (Apple Silicon) adds de, ko, ja and zh.` : lang.startsWith('en-gb') ? 'UK_Charlotte or UK_George' : null,
  },
};
writeJson(path.join(tutorials, 'discovery', 'look.json'), result);
done(result);

// Runs in the page: colors of what people click, the app's chrome, and the page's metadata.
function measure() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && Number(s.opacity) > 0.1;
  };
  const area = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width * r.height); };
  const colors = [];
  for (const el of document.querySelectorAll('button, [role=button], input[type=submit], a')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const filled = s.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
    if (filled) colors.push({ kind: 'button', color: s.backgroundColor, area: area(el) });
    else if (el.tagName === 'A') colors.push({ kind: 'link', color: s.color, area: area(el) });
  }
  for (const el of document.querySelectorAll('nav, aside, header, [role=navigation], [role=banner]')) {
    if (visible(el)) colors.push({ kind: 'chrome', color: getComputedStyle(el).backgroundColor, area: area(el) });
  }
  const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;
  const logos = [...document.querySelectorAll('img, svg')]
    .filter((el) => visible(el) && /logo|brand/i.test(`${el.getAttribute('alt') || ''} ${el.getAttribute('class') || ''} ${el.id} ${el.getAttribute('aria-label') || ''}`))
    .map((el) => el.tagName === 'IMG' ? el.currentSrc || el.src : 'inline svg')
    .slice(0, 3);
  return {
    colors,
    meta: {
      title: document.title,
      siteName: attr('meta[property="og:site_name"]', 'content'),
      lang: document.documentElement.lang,
      themeColor: attr('meta[name="theme-color"]', 'content'),
      canonical: attr('link[rel="canonical"]', 'href'),
      ogUrl: attr('meta[property="og:url"]', 'content'),
      manifest: attr('link[rel="manifest"]', 'href'),
      icons: [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => l.href),
      logos,
    },
  };
}

function parse(c) {
  const s = String(c || '').trim();
  let m = s.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+([\d.]+%?))?\)$/);
  if (m) return m[4] !== undefined && parseFloat(m[4]) < (m[4].endsWith('%') ? 50 : 0.5) ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function hex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a, b, t) {
  return a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
}

function saturation([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
