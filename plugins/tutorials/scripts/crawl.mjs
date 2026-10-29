#!/usr/bin/env node
// Visit the app's pages as a role and record what's on each one.
// Usage: node crawl.mjs [--role admin] [--max-pages 40] [--config tutorials/config.yaml]
//
// Writes to tutorials/discovery/<role>/:
//   pages.json         one entry per page: title, headings, navigation, buttons, fields, links
//   screens/<slug>.jpg viewport screenshot of the page
//   snapshots/<slug>.yaml accessibility tree (roles and visible labels) of the page
// Only follows links; it never clicks buttons or submits forms.
import fs from 'node:fs';
import path from 'node:path';
import { absUrl, authFile, done, launchBrowser, loadConfig, parseArgs, pickRole, routePattern, slugFor, writeJson } from './lib/common.mjs';

const args = parseArgs();
const { cfg, tutorials } = loadConfig(args.config);
const role = pickRole(cfg, args.role);
const crawl = cfg.crawl;
const maxPages = Number(args['max-pages'] || crawl.max_pages || 40);
const perPattern = Number(crawl.per_pattern || 2);
const viewport = crawl.viewport || { width: 1440, height: 900 };
const exclude = (crawl.exclude || []).map((p) => new RegExp(p));
const origin = new URL(cfg.app.url).origin;
const outDir = path.join(tutorials, 'discovery', role.id);
const session = authFile(tutorials, role.id);
const loginPath = role.login ? new URL(absUrl(cfg.app.url, role.login.url || '/login')).pathname : null;

const SKIP_TEXT = /\b(log ?out|sign ?out)\b/i;
const SKIP_EXT = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|mp3|ics|json|xml)$/i;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'screens'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'snapshots'), { recursive: true });

const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({
  viewport,
  storageState: fs.existsSync(session) ? session : undefined,
});
const page = await context.newPage();

const starts = (crawl.start?.length ? crawl.start : ['/']).map((p) => absUrl(cfg.app.url, p));
const queue = [...starts];
const seen = new Set();
const patternCount = new Map();
const pages = [];
const errors = [];
let redirectedToLogin = 0;

function normalize(href) {
  try {
    const u = new URL(href, origin);
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

while (queue.length && pages.length < maxPages) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);
  const pattern = routePattern(new URL(url).pathname);
  if ((patternCount.get(pattern) || 0) >= perPattern) continue;

  let status = null;
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = res?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    errors.push({ url, error: String(e.message || e).split('\n')[0] });
    continue;
  }

  const finalUrl = normalize(page.url());
  if (loginPath && new URL(finalUrl).pathname === loginPath && new URL(url).pathname !== loginPath) {
    redirectedToLogin++;
    errors.push({ url, error: 'redirected to the login page (session missing or expired)' });
    continue;
  }
  if (finalUrl !== url) {
    if (seen.has(finalUrl)) continue;
    seen.add(finalUrl);
  }
  const finalPattern = routePattern(new URL(finalUrl).pathname);
  if ((patternCount.get(finalPattern) || 0) >= perPattern) continue;
  patternCount.set(finalPattern, (patternCount.get(finalPattern) || 0) + 1);

  const info = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const labelOf = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return clean(l.textContent);
      }
      const wrap = el.closest('label');
      if (wrap) return clean(wrap.textContent);
      return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'));
    };
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const links = [...document.querySelectorAll('a[href]')].filter(visible).map((a) => ({ text: clean(a.textContent || a.getAttribute('aria-label')), href: a.href }));
    // A <header> is often just a page's title bar with its buttons; count it as navigation only when it holds several links.
    const navRoots = [...document.querySelectorAll('nav, [role="navigation"], aside, header')]
      .filter((n) => n.tagName !== 'HEADER' || n.querySelectorAll('a[href]').length >= 3);
    const nav = uniq(navRoots.flatMap((n) => [...n.querySelectorAll('a[href], button')].filter(visible).map((a) => clean(a.textContent || a.getAttribute('aria-label')))));
    const buttons = uniq([...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .filter(visible).map((b) => clean(b.textContent || b.value || b.getAttribute('aria-label') || b.getAttribute('title'))));
    const fields = uniq([...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')]
      .filter(visible).map((f) => `${labelOf(f) || '(no label)'} [${f.tagName === 'INPUT' ? f.type : f.tagName.toLowerCase()}]`));
    const headings = uniq([...document.querySelectorAll('h1, h2, h3')].filter(visible).map((h) => `${h.tagName.toLowerCase()}: ${clean(h.textContent)}`)).slice(0, 20);
    const dialogs = document.querySelectorAll('dialog[open], [role="dialog"]').length;
    return { title: document.title, headings, nav: nav.slice(0, 40), buttons: buttons.slice(0, 60), fields: fields.slice(0, 60), links, dialogs, scroll_height: document.documentElement.scrollHeight };
  });

  const slug = slugFor(finalUrl);
  const shot = path.join(outDir, 'screens', `${slug}.jpg`);
  await page.screenshot({ path: shot, type: 'jpeg', quality: 70 });
  let snapshotFile = null;
  try {
    let snap = await page.locator('body').ariaSnapshot({ timeout: 10000 });
    if (snap.length > 60000) snap = snap.slice(0, 60000) + '\n# ...truncated';
    snapshotFile = path.join(outDir, 'snapshots', `${slug}.yaml`);
    fs.writeFileSync(snapshotFile, snap);
  } catch {}

  const linksOut = [];
  for (const l of info.links) {
    const n = normalize(l.href);
    if (!n || !n.startsWith(origin)) continue;
    if (SKIP_TEXT.test(l.text) || SKIP_TEXT.test(new URL(n).pathname.replace(/[-_/]/g, ' '))) continue;
    if (SKIP_EXT.test(new URL(n).pathname)) { linksOut.push({ text: l.text, href: n, kind: 'download' }); continue; }
    if (exclude.some((re) => re.test(new URL(n).pathname))) continue;
    linksOut.push({ text: l.text, href: n });
    if (!seen.has(n)) queue.push(n);
  }

  pages.push({
    url: finalUrl,
    path: new URL(finalUrl).pathname,
    pattern: finalPattern,
    status,
    title: info.title,
    headings: info.headings,
    nav: info.nav,
    buttons: info.buttons,
    fields: info.fields,
    dialogs_open: info.dialogs,
    scroll_height: info.scroll_height,
    links: linksOut.slice(0, 80),
    screenshot: path.relative(tutorials, shot),
    snapshot: snapshotFile ? path.relative(tutorials, snapshotFile) : null,
  });
}

await browser.close();

writeJson(path.join(outDir, 'pages.json'), {
  app: cfg.app.name || cfg.app.url,
  role: role.id,
  crawled_at: new Date().toISOString(),
  pages,
  errors,
  unvisited: queue.filter((u) => !seen.has(u)).slice(0, 100),
});

done({
  ok: pages.length > 0,
  role: role.id,
  pages: pages.length,
  patterns: [...new Set(pages.map((p) => p.pattern))],
  errors: errors.length,
  hint: redirectedToLogin ? `Some pages redirected to login. Run login.mjs --role ${role.id} and crawl again.` : undefined,
  output: path.relative(process.cwd(), path.join(outDir, 'pages.json')),
}, pages.length ? 0 : 1);
