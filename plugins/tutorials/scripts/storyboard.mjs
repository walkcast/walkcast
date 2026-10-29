#!/usr/bin/env node
// Replay each tour, find the element behind every step's target, and screenshot each step for review.
// Usage: node storyboard.mjs [<tutorial-id> ...] [--wait 5] [--config tutorials/config.yaml]
//        node storyboard.mjs --approve [<tutorial-id> ...]
//
// With no ids it runs every item in tutorials/plan.yaml that has a tour.yaml. Before each tour it runs
// config's app.reset, if set. For each tour it writes:
//   <id>/storyboard/NN-before.jpg, NN-after.jpg   the screen before and after step NN
//   <id>/storyboard/steps.json                     per step: element, locator, box, URL, visible text, notes
//   <id>/storyboard.html                           each narration line next to its screenshots
// and saves every resolved locator back into tour.yaml. A step whose target can't be found, or whose
// expect_text isn't on the page afterwards, stops its tour; the result says why, with a screenshot and
// the page's accessibility snapshot.
//
// --approve marks tours approved once the user has seen their storyboards: it sets approved_at and
// approved_hash, a fingerprint of the tour that record.mjs checks. A tour needs a clean storyboard of
// exactly its current steps to be approved.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { absUrl, authFile, done, launchBrowser, loadConfig, lock, parseArgs, resetApp, today, tourIds, writeJson } from './lib/common.mjs';
import { resolve } from './lib/locate.mjs';
import { ACTIONS, actionError, expectList, hasTarget, missingText, needsScroll, tourHash, visibleText } from './lib/tour.mjs';

const args = parseArgs();
const { cfg, root, tutorials } = loadConfig(args.config);
const viewport = cfg.crawl.viewport || { width: 1440, height: 900 };
const origin = new URL(cfg.app.url).origin;
const waitMs = Number(args.wait || 5) * 1000;

const ids = tourIds(tutorials, args._);
const rel = (p) => path.relative(process.cwd(), p);
const firstLine = (e) => String(e?.message || e).split('\n')[0];
if (args.approve) approve();

const browser = await launchBrowser({ headless: true });
const tours = [];
try {
  for (const id of ids) tours.push(await runTour(id));
} finally {
  await browser.close();
}
const ok = tours.every((t) => t.ok);
done({ ok, tours }, ok ? 0 : 1);

async function runTour(id) {
  const dir = path.join(tutorials, id);
  const tourFile = path.join(dir, 'tour.yaml');
  if (!fs.existsSync(tourFile)) return { id, ok: false, error: `No ${rel(tourFile)}` };
  const doc = YAML.parseDocument(fs.readFileSync(tourFile, 'utf8'));
  if (doc.errors.length) return { id, ok: false, error: `${rel(tourFile)} doesn't parse: ${doc.errors[0].message}` };
  const tour = doc.toJS() || {};
  const steps = Array.isArray(tour.steps) ? tour.steps : [];
  if (!steps.length) return { id, ok: false, error: `${rel(tourFile)} has no steps` };
  const role = tour.role ? cfg.roles.find((r) => r.id === tour.role) : cfg.roles[0];
  if (!role) return { id, ok: false, error: `Role "${tour.role}" isn't in tutorials/config.yaml` };
  const session = authFile(tutorials, role.id);
  if (role.login && !fs.existsSync(session)) return { id, ok: false, error: `No saved session for role ${role.id}. Run login.mjs --role ${role.id} first.` };
  const loginPath = role.login ? new URL(absUrl(cfg.app.url, role.login.url || '/login')).pathname : null;
  const startUrl = absUrl(cfg.app.url, tour.start || '/');

  const held = lock(dir, 'storyboard');
  if (held.error) return { id, ok: false, error: held.error };
  const resetError = await resetApp(cfg, root);
  if (resetError) {
    held.release();
    return { id, ok: false, error: resetError };
  }

  // Build the new storyboard beside the old one, and swap it in at the end.
  const outDir = path.join(dir, `storyboard.tmp-${process.pid}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const context = await browser.newContext({ viewport, acceptDownloads: true, storageState: fs.existsSync(session) ? session : undefined });
  context.setDefaultTimeout(10000);
  const notes = []; // what happened during the current step besides the action itself
  let page;
  const watch = (p) => {
    page = p;
    p.on('pageerror', (e) => notes.push(`Page error: ${firstLine(e)}`));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) notes.push(`Console error: ${m.text().slice(0, 200)}`); });
    p.on('response', (r) => {
      const u = new URL(r.url());
      if (r.status() >= 400 && u.origin === origin && u.pathname !== '/favicon.ico') notes.push(`HTTP ${r.status()} from ${u.pathname}`);
    });
    p.on('dialog', (d) => { notes.push(`A ${d.type()} dialog said "${d.message().slice(0, 200)}" and was accepted`); d.accept().catch(() => {}); });
    p.on('download', (d) => notes.push(`Downloaded ${d.suggestedFilename()}; a recording only shows the click`));
    p.on('popup', (np) => { notes.push('Opened a new tab; the tour continues there'); watch(np); });
  };
  watch(await context.newPage());

  const results = [];
  let failure = null;
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page);
    if (loginPath && new URL(page.url()).pathname === loginPath && new URL(startUrl).pathname !== loginPath) {
      failure = { step: 0, reason: `The start page redirected to the login page, so the ${role.id} session has expired. Run login.mjs --role ${role.id} and try again.`, url: page.url() };
    }
    for (let i = 0; !failure && i < steps.length; i++) {
      const step = steps[i] || {};
      const nn = String(i + 1).padStart(2, '0');
      if (i) notes.length = 0; // step 1 keeps anything that happened while the start page loaded
      const r = { n: i + 1, do: step.do || null, say: step.say ?? null, target: step.target ?? null, expect: step.expect ?? null, url: page.url() };
      if (step.do && !ACTIONS[step.do]) {
        failure = await failAt(page, outDir, i + 1, step, `Unknown action "${step.do}". Use one of: ${Object.keys(ACTIONS).join(', ')}.`);
        break;
      }
      r.text = await visibleText(page);
      let el = null;
      if (hasTarget(step)) {
        const found = await resolve(page, step, { waitMs });
        if (!found.el) {
          failure = await failAt(page, outDir, i + 1, step, `${found.reason}.`, found.candidates ? { candidates: found.candidates } : {});
          break;
        }
        ({ el } = found);
        r.element = found.element;
        r.locator = found.locator;
        if (found.note) notes.push(found.note);
      } else if (ACTIONS[step.do]?.target === 'required') {
        failure = await failAt(page, outDir, i + 1, step, `A ${step.do} step needs a target.`);
        break;
      }
      if (el) {
        if (needsScroll(await el.boundingBox(), viewport)) await el.scrollIntoViewIfNeeded().catch(() => {});
        r.box = await el.boundingBox();
      }
      r.before = await shot(page, outDir, `${nn}-before.jpg`);
      if (step.do && step.do !== 'show') {
        if (step.do === 'check' && (await el.isChecked().catch(() => false))) notes.push('It was already checked before this step, so the demo data may need resetting');
        try {
          await act(page, step, el);
        } catch (e) {
          failure = await failAt(page, outDir, i + 1, step, `The ${step.do} on ${r.element || `"${step.target ?? step.path ?? step.key}"`} failed: ${actionError(e)}`);
          break;
        }
        await settle(page);
        r.after = await shot(page, outDir, `${nn}-after.jpg`);
        r.url_after = page.url();
      }
      const expected = expectList(step);
      const missing = expected.length ? await missingText(page, expected) : [];
      if (missing.length) {
        failure = await failAt(page, outDir, i + 1, step, `After this step the page should show ${missing.map((m) => `"${m}"`).join(' and ')}, but it doesn't.`);
        break;
      }
      r.notes = [...notes];
      results.push(r);
    }
  } catch (e) {
    failure = failure || { step: results.length + 1, reason: firstLine(e), url: page?.url() };
  }
  await context.close();

  // Save each locator that's new or changed back into tour.yaml, keeping the file's comments and layout.
  let saved = 0;
  for (const r of results) {
    if (!r.locator || JSON.stringify(steps[r.n - 1].locator) === JSON.stringify(r.locator)) continue;
    doc.setIn(['steps', r.n - 1, 'locator'], doc.createNode(r.locator, { flow: true }));
    saved++;
  }
  if (saved) fs.writeFileSync(tourFile, doc.toString({ lineWidth: 0 }));

  const words = steps.reduce((sum, s) => sum + String(s?.say || '').split(/\s+/).filter(Boolean).length, 0);
  const estSeconds = Math.round(words / 2.5 + steps.filter((s) => s?.do).length);
  const finalHash = tourHash(doc.toJS() || {});
  writeJson(path.join(outDir, 'steps.json'), { id, title: tour.title, role: role.id, start: tour.start, ran_at: new Date().toISOString(), ok: !failure, tour_hash: finalHash, est_seconds: estSeconds, failure, steps: results });
  const final = path.join(dir, 'storyboard');
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(outDir, final);
  fs.writeFileSync(path.join(dir, 'storyboard.html'), renderHtml({ id, tour, role: role.id, results, failure, estSeconds, total: steps.length }));
  held.release();

  const inDir = (p) => (p ? rel(path.join(dir, p)) : undefined);
  return {
    id,
    ok: !failure,
    steps: `${results.length}/${steps.length}`,
    est_seconds: estSeconds,
    locators_saved: saved,
    notes: results.flatMap((r) => r.notes.map((n) => `step ${r.n}: ${n}`)),
    failed: failure ? { ...failure, screenshot: inDir(failure.screenshot), snapshot: inDir(failure.snapshot) } : undefined,
    storyboard: rel(path.join(dir, 'storyboard.html')),
  };
}

async function settle(page) {
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function shot(page, outDir, name) {
  await page.screenshot({ path: path.join(outDir, name), type: 'jpeg', quality: 75 });
  return `storyboard/${name}`;
}

async function failAt(page, outDir, n, step, reason, extra = {}) {
  const nn = String(n).padStart(2, '0');
  const f = { step: n, do: step.do ?? null, target: step.target ?? null, reason, url: page.url(), ...extra };
  f.screenshot = await shot(page, outDir, `${nn}-failed.jpg`).catch(() => undefined);
  try {
    fs.writeFileSync(path.join(outDir, `${nn}-failed.aria.yaml`), await page.locator('body').ariaSnapshot({ timeout: 5000 }));
    f.snapshot = `storyboard/${nn}-failed.aria.yaml`;
  } catch {}
  return f;
}

async function act(page, step, el) {
  switch (step.do) {
    case 'goto': return page.goto(absUrl(cfg.app.url, step.path), { waitUntil: 'domcontentloaded' });
    case 'click': return el.click();
    case 'type': return el.fill(String(step.text ?? ''));
    case 'select': return el.selectOption(String(step.option));
    case 'check': return el.check();
    case 'hover': return el.hover();
    case 'show': return null;
    case 'press': return el ? el.press(step.key) : page.keyboard.press(step.key);
    case 'scroll': return el ? el.scrollIntoViewIfNeeded() : page.mouse.wheel(0, Math.round(viewport.height * 0.8));
    case 'wait': return page.waitForTimeout(Number(step.seconds ?? 1) * 1000);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function pct(n, of) {
  return `${((n / of) * 100).toFixed(2)}%`;
}

function actionText(r, step) {
  const el = r.element || `"${step.target}"`;
  switch (step.do) {
    case 'goto': return `Go to ${step.path}`;
    case 'click': return `Click ${el}`;
    case 'type': return `Type "${step.text}" into ${el}`;
    case 'select': return `Choose "${step.option}" in ${el}`;
    case 'check': return `Tick ${el}`;
    case 'hover': return `Hover over ${el}`;
    case 'show': return `Point out ${el}`;
    case 'press': return `Press ${step.key}${r.element ? ` in ${el}` : ''}`;
    case 'scroll': return r.element ? `Scroll to ${el}` : 'Scroll down';
    case 'wait': return `Wait ${step.seconds ?? 1} s`;
    default: return 'Narration only';
  }
}

function renderHtml({ id, tour, role, results, failure, estSeconds, total }) {
  const v = Date.now().toString(36);
  const figure = (src, caption, box) => `<figure><a class="frame" href="${src}?v=${v}" target="_blank"><img src="${src}?v=${v}" alt="${esc(caption)}" loading="lazy">${
    box ? `<span class="ring" style="left:${pct(box.x, viewport.width)};top:${pct(box.y, viewport.height)};width:${pct(box.width, viewport.width)};height:${pct(box.height, viewport.height)}"></span>` : ''
  }</a><figcaption>${esc(caption)}</figcaption></figure>`;
  const steps = tour.steps || [];
  const rows = results.map((r) => {
    const step = steps[r.n - 1] || {};
    // The next step's screenshot already shows this step's result, so an After shot is only worth
    // the space when there's an expectation to check, or no next step.
    const after = r.after && (r.expect || r.n === results.length);
    const shots = after ? figure(r.before, 'Before', r.box) + figure(r.after, 'After') : figure(r.before, '', r.box);
    return `<section class="step" id="step-${r.n}"><div class="text"><span class="num">${r.n}</span>
<p class="say">${esc(r.say) || '<span class="muted">(no narration)</span>'}</p>
<p class="action">${esc(actionText(r, step))}</p>
${r.expect ? `<p class="expect"><b>Expect:</b> ${esc(r.expect)}</p>` : ''}
${expectList(step).length ? `<p class="expect"><b>Checked on the page:</b> ${expectList(step).map((t) => `“${esc(t)}”`).join(', ')}</p>` : ''}
${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>
<div class="shots${after ? ' two' : ''}">${shots}</div></section>`;
  });
  if (failure) {
    const step = steps[failure.step - 1] || {};
    const cands = failure.candidates?.length
      ? `<table><tr><th>Element</th><th>Inside</th><th>Locator</th></tr>${failure.candidates.map((c) => `<tr><td>${esc(c.element)}</td><td>${esc(c.inside || '')}</td><td><code>${esc(JSON.stringify(c.locator))}</code></td></tr>`).join('')}</table>`
      : '';
    rows.push(`<section class="step failed" id="step-${failure.step}"><div class="text"><span class="num">${failure.step || '!'}</span>
${step.say ? `<p class="say">${esc(step.say)}</p>` : ''}
${step.do ? `<p class="action">${esc(actionText({}, step))}</p>` : ''}
<p class="reason">${esc(failure.reason)}</p>${cands}</div>
<div class="shots">${failure.screenshot ? figure(failure.screenshot, 'The page when the step failed') : ''}</div></section>`);
  }
  const status = failure
    ? `<p class="status bad">Stopped at step ${failure.step} of ${total}. ${esc(failure.reason)}</p>`
    : `<p class="status ok">All ${total} steps ran and every target was found.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tour.title || id)} storyboard</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1c2027;--muted:#5d6471;--line:#e1e4ea;--chip:#eef0f4;--ring:#f76707;--ok:#2b8a3e;--bad:#c92a2a;--warn:#a85d00}
@media (prefers-color-scheme:dark){:root{--bg:#131519;--card:#1c1f25;--text:#e7e9ed;--muted:#9aa1ad;--line:#2b2f37;--chip:#262a31;--ok:#69db7c;--bad:#ff8787;--warn:#ffc078}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1600px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}.meta,.muted{color:var(--muted)}.meta{margin:0 0 16px}
.status{padding:10px 14px;border-radius:8px;margin:0 0 8px;font-weight:600;border:1px solid}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.legend{margin:0 0 24px;color:var(--muted)}
.step{display:grid;grid-template-columns:300px 1fr;gap:24px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:14px}
.step.failed{border-color:var(--bad)}.num{display:inline-grid;place-items:center;min-width:28px;height:28px;border-radius:14px;background:var(--chip);font-weight:600;font-size:13px}
.say{font-size:18px;line-height:1.45;margin:10px 0 12px}.action{display:inline-block;margin:0 0 10px;padding:5px 8px;border-radius:6px;background:var(--chip);font:13px/1.4 ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.expect{margin:0 0 8px;color:var(--muted)}.notes{margin:8px 0 0;padding-left:18px;color:var(--warn)}.reason{color:var(--bad);font-weight:600}
table{border-collapse:collapse;font-size:13px;margin-top:8px}td,th{text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--line);vertical-align:top}code{font-size:12px;overflow-wrap:anywhere}
.shots{display:grid;gap:12px;align-items:start}.shots.two{grid-template-columns:1fr 1fr}figure{margin:0;min-width:0}
.frame{position:relative;display:block;overflow:hidden;border:1px solid var(--line);border-radius:6px}.frame img{display:block;width:100%;height:auto}
.ring{position:absolute;border-radius:4px;outline:3px solid var(--ring);outline-offset:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.12)}
figcaption{margin-top:4px;font-size:12px;color:var(--muted)}figcaption:empty{display:none}
@media (max-width:820px){.step{grid-template-columns:1fr}.shots.two{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${esc(tour.title || id)}</h1>
<p class="meta">Role: ${esc(role)} · Starts at ${esc(tour.start || '/')} · ${total} steps · about ${estSeconds} seconds · ${esc(new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
${status}
<p class="legend">Each screenshot shows the screen as the line starts, with the element the step acts on ringed in orange. Steps with an expectation also show the result. Click a screenshot to open it full size.</p>
${rows.join('\n')}
</main></body></html>
`;
}

// Mark tours approved, if each has a clean storyboard of its current steps.
function approve() {
  const approved = [];
  const refused = [];
  for (const id of ids) {
    const tourFile = path.join(tutorials, id, 'tour.yaml');
    const stepsFile = path.join(tutorials, id, 'storyboard', 'steps.json');
    if (!fs.existsSync(tourFile)) { refused.push({ id, reason: `No ${rel(tourFile)}` }); continue; }
    const doc = YAML.parseDocument(fs.readFileSync(tourFile, 'utf8'));
    const hash = tourHash(doc.toJS() || {});
    const sb = fs.existsSync(stepsFile) ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : null;
    if (!sb) { refused.push({ id, reason: 'It has no storyboard yet. Run storyboard.mjs first.' }); continue; }
    if (!sb.ok) { refused.push({ id, reason: 'Its last storyboard stopped at a failing step.' }); continue; }
    if (sb.tour_hash !== hash) { refused.push({ id, reason: 'The tour changed after its storyboard. Run storyboard.mjs again and show it to the user.' }); continue; }
    setBeforeSteps(doc, 'approved_at', today());
    setBeforeSteps(doc, 'approved_hash', hash);
    fs.writeFileSync(tourFile, doc.toString({ lineWidth: 0 }));
    approved.push(id);
  }
  done({ ok: refused.length === 0, approved, refused }, refused.length ? 1 : 0);
}

// Set a top-level field, adding it just above steps if it isn't there yet.
function setBeforeSteps(doc, key, value) {
  if (doc.has(key)) return doc.set(key, value);
  const items = doc.contents.items;
  const at = items.findIndex((pair) => pair.key?.value === 'steps');
  items.splice(at < 0 ? items.length : at, 0, doc.createPair(key, value));
}
