#!/usr/bin/env node
// Try the forms and buttons on each crawled page and record what they really do, so discover can tell
// working features from ones that only look finished.
// Usage: node probe.mjs [--role <id>] [--config tutorials/config.yaml] [--no-reset]
//
// Needs tutorials/discovery/<role>/pages.json from crawl.mjs. Probing submits forms, so it needs
// config's app.reset to put the demo data back before each try; --no-reset probes without it, leaving
// whatever the forms create. Text fields get a marker ("Probe 3"); after submitting, the marker showing
// up on the page and again after a reload means the form saved. Buttons outside forms are clicked to
// see whether anything happens. Anything that sounds destructive (delete, remove, log out, ...) is
// skipped. Writes tutorials/discovery/<role>/probe.json.
import fs from 'node:fs';
import path from 'node:path';
import { authFile, done, fail, launchBrowser, loadConfig, parseArgs, pickRole, resetApp, writeJson } from './lib/common.mjs';
import { textDiff, visibleText } from './lib/tour.mjs';

const DESTRUCTIVE = /\b(delete|remove|archive|destroy|erase|deactivate|disable|revoke|log ?out|sign ?out|unsubscribe|cancel (my )?(account|subscription|plan)|reset|leave|discard)\b/i;
const MAX_FORMS = 6; // per page
const MAX_BUTTONS = 10; // per page

const args = parseArgs();
const { cfg, root, tutorials } = loadConfig(args.config);
const role = pickRole(cfg, args.role);
const pagesFile = path.join(tutorials, 'discovery', role.id, 'pages.json');
if (!fs.existsSync(pagesFile)) fail(`No ${path.relative(process.cwd(), pagesFile)}. Run crawl.mjs --role ${role.id} first.`);
if (!cfg.app.reset && !args['no-reset']) fail('probe.mjs submits forms, so it needs app.reset in config.yaml to put the demo data back (see formats.md). Pass --no-reset if leaving the changes is fine.');
const session = authFile(tutorials, role.id);
const viewport = cfg.crawl.viewport || { width: 1440, height: 900 };

// One page per route pattern is enough: /projects/1 and /projects/2 have the same controls.
const seen = new Set();
const pages = JSON.parse(fs.readFileSync(pagesFile, 'utf8')).pages.filter((p) => !seen.has(p.pattern) && seen.add(p.pattern));

const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({ viewport, acceptDownloads: true, storageState: fs.existsSync(session) ? session : undefined });
context.setDefaultTimeout(8000);
const controls = [];
const triedButtons = new Set(); // a button in the header shows up on every page; try it once
let marker = 0;
try {
  for (const pg of pages) {
    const page = await fresh(pg.url);
    const forms = await page.locator('form').count();
    const buttons = await page.getByRole('button').filter({ visible: true }).evaluateAll((els) => els.map((b) => ({ name: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim(), inForm: Boolean(b.closest('form')) })));
    await page.close();
    for (let k = 0; k < Math.min(forms, MAX_FORMS); k++) controls.push(await probeForm(pg, k));
    for (const b of buttons.filter((x) => !x.inForm && x.name && !triedButtons.has(x.name)).slice(0, MAX_BUTTONS)) {
      triedButtons.add(b.name);
      controls.push(await probeButton(pg, b.name));
    }
  }
} finally {
  await context.close();
  await browser.close();
  if (cfg.app.reset && !args['no-reset']) await resetApp(cfg, root);
}

const found = controls.filter(Boolean);
writeJson(path.join(tutorials, 'discovery', role.id, 'probe.json'), { role: role.id, probed_at: new Date().toISOString(), controls: found });
done({
  ok: true,
  role: role.id,
  controls: found.length,
  saved: found.filter((c) => c.result === 'saved' || c.result === 'changed the page and saved it').map(label),
  not_saved: found.filter((c) => c.kind === 'form' && c.result !== 'saved' && c.result !== 'skipped').map(label),
  no_effect: found.filter((c) => c.result === 'nothing happened').map(label),
  skipped: found.filter((c) => c.result === 'skipped').map(label),
  output: path.relative(process.cwd(), path.join(tutorials, 'discovery', role.id, 'probe.json')),
});

function label(c) {
  return `${c.page} › ${c.label}`;
}

// A page in its starting state: data reset, freshly loaded.
async function fresh(url) {
  if (cfg.app.reset && !args['no-reset']) {
    const error = await resetApp(cfg, root);
    if (error) fail(error);
  }
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await settle(page);
  return page;
}

async function settle(page) {
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(200);
}

// What changed between two moments on a page, in words.
async function observe(page, before, extra) {
  const url = page.url();
  const text = await visibleText(page);
  const diff = textDiff(before.text, text);
  const dialogs = await page.locator('[role="dialog"], dialog[open]').filter({ visible: true }).count();
  if (extra.error) return { result: 'error', details: extra.error };
  if (extra.download) return { result: 'started a download', details: extra.download };
  if (extra.popup) return { result: 'opened a new tab' };
  if (dialogs > before.dialogs) return { result: 'opened a dialog' };
  if (url !== before.url) return { result: `went to ${new URL(url).pathname}` };
  if (diff.added.length || diff.removed.length) return { result: 'changed the page', details: { added: diff.added.slice(0, 5), removed: diff.removed.slice(0, 5) } };
  return { result: 'nothing happened' };
}

function watch(page, extra) {
  page.on('response', (r) => { if (r.request().resourceType() === 'document' && r.status() >= 400) extra.error = `HTTP ${r.status()} from ${new URL(r.url()).pathname}`; });
  page.on('download', (d) => { extra.download = d.suggestedFilename(); });
  page.on('popup', () => { extra.popup = true; });
}

async function probeForm(pg, k) {
  const page = await fresh(pg.url);
  try {
    const form = page.locator('form').nth(k);
    if (!(await form.isVisible().catch(() => false))) return null;
    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    const name = ((await submit.innerText().catch(() => '')) || (await submit.getAttribute('value').catch(() => '')) || 'Submit').trim();
    const base = { kind: 'form', page: pg.pattern, label: name };
    if (DESTRUCTIVE.test(name)) return { ...base, result: 'skipped', details: 'sounds destructive' };
    if (await form.locator('input[type="password"]').count()) return { ...base, result: 'skipped', details: 'a sign-in form' };
    const n = ++marker;
    const value = `Probe ${n}`;
    const filled = [];
    for (const field of await form.locator('input, textarea, select').all()) {
      if (!(await field.isVisible().catch(() => false)) || !(await field.isEditable().catch(() => false))) continue;
      const tag = await field.evaluate((e) => e.tagName.toLowerCase());
      const type = (await field.getAttribute('type')) || 'text';
      const fieldName = (await field.evaluate((e) => (e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.name || e.id || '').trim())) || type;
      if (tag === 'select') {
        const options = await field.locator('option').count();
        if (options > 1) { await field.selectOption({ index: 1 }); filled.push(fieldName); }
      } else if (tag === 'textarea' || ['text', 'search', ''].includes(type)) { await field.fill(value); filled.push(fieldName); }
      else if (type === 'email') { await field.fill(`probe${n}@example.com`); filled.push(fieldName); }
      else if (type === 'url') { await field.fill(`https://example.com/probe-${n}`); filled.push(fieldName); }
      else if (type === 'number') { await field.fill('1'); filled.push(fieldName); }
      else if (type === 'tel') { await field.fill('555 0100'); filled.push(fieldName); }
      else if (type === 'date') { await field.fill('2026-01-15'); filled.push(fieldName); }
    }
    const marks = [value, `probe${n}@example.com`];
    const before = { url: page.url(), text: await visibleText(page), dialogs: 0 };
    const extra = {};
    watch(page, extra);
    if (await submit.count()) await submit.click();
    else await form.evaluate((f) => f.requestSubmit());
    await settle(page);
    const seen = await observe(page, before, extra);
    // Saved means the marker is still there after a reload, on the page the form led to or the one it was on.
    const shows = async () => (await visibleText(page)).some((l) => marks.some((m) => l.includes(m)));
    let saved = false;
    if (!extra.error) {
      await page.reload();
      await settle(page);
      saved = await shows();
      if (!saved && page.url() !== pg.url) {
        await page.goto(pg.url);
        await settle(page);
        saved = await shows();
      }
    }
    const result = extra.error ? 'error' : saved ? 'saved' : seen.result === 'nothing happened' ? 'nothing happened' : `${seen.result}, but nothing was saved`;
    return { ...base, fields: filled, result, after: seen.result, ...(seen.details ? { details: seen.details } : {}) };
  } finally {
    await page.close();
  }
}

async function probeButton(pg, name) {
  const base = { kind: 'button', page: pg.pattern, label: name };
  if (DESTRUCTIVE.test(name)) return { ...base, result: 'skipped', details: 'sounds destructive' };
  const page = await fresh(pg.url);
  try {
    const button = page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
    if (!(await button.count())) return null;
    const before = { url: page.url(), text: await visibleText(page), dialogs: await page.locator('[role="dialog"], dialog[open]').filter({ visible: true }).count() };
    const extra = {};
    watch(page, extra);
    await button.click();
    await page.waitForTimeout(500);
    await settle(page);
    const seen = await observe(page, before, extra);
    // A change that's still there after a reload was saved; one that isn't only lived in the page.
    if (seen.result === 'changed the page' && seen.details?.added.length) {
      await page.reload();
      await settle(page);
      const after = await visibleText(page);
      const kept = seen.details.added.some((line) => after.includes(line) && !before.text.includes(line));
      seen.result = kept ? 'changed the page and saved it' : 'changed the page, but not after a reload';
    }
    return { ...base, ...seen };
  } finally {
    await page.close();
  }
}
