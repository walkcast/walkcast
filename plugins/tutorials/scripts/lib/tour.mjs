// What a tour step can do, and helpers for the scripts that read, replay and check tours.
import crypto from 'node:crypto';

// Each action, the field it needs besides its target, and whether it acts on an element.
export const ACTIONS = {
  goto: { field: 'path', target: 'none' },
  click: { target: 'required' },
  type: { field: 'text', target: 'required' },
  select: { field: 'option', target: 'required' },
  check: { target: 'required' },
  hover: { target: 'required' },
  show: { target: 'required' }, // ring and zoom on an element while the line is spoken, without touching it
  press: { field: 'key', target: 'optional' },
  scroll: { target: 'optional' },
  wait: { target: 'none' },
};

// Whether a step acts on an element (and so needs one found on the page).
export function hasTarget(step) {
  const spec = ACTIONS[step?.do];
  return Boolean(spec && spec.target !== 'none' && (step.target != null || step.locator));
}

// Steps that probably change the app's data, so replaying the tour needs the data put back first.
export function changesData(step) {
  return ['type', 'select', 'check'].includes(step?.do) || (step?.do === 'click' && step?.locator?.role === 'button');
}

// A fingerprint of everything in a tour that changes what the video shows or says. Approval stores it,
// so a tour edited after approval is noticed.
const HASHED = ['do', 'target', 'locator', 'say', 'cue', 'text', 'option', 'key', 'path', 'seconds', 'expect_text'];
export function tourHash(tour) {
  const steps = (tour.steps || []).map((s) => Object.fromEntries(HASHED.filter((k) => s?.[k] !== undefined).map((k) => [k, s[k]])));
  return crypto.createHash('sha256').update(JSON.stringify({ role: tour.role ?? null, start: tour.start ?? null, steps })).digest('hex').slice(0, 16);
}

// Why a tour can't be produced yet, or null when it's approved as it stands.
export function approvalProblem(tour) {
  if (!tour.approved_at || !tour.approved_hash) return 'its storyboard hasn\'t been approved';
  if (tour.approved_hash !== tourHash(tour)) return 'it changed after its storyboard was approved';
  return null;
}

// Whether an element's box needs scrolling into view. One taller than the viewport counts as visible
// once its top is on screen, so pointing out a long list doesn't scroll to its middle.
export function needsScroll(box, viewport) {
  if (!box) return true;
  if (box.x < 0 || box.x + box.width > viewport.width) return true;
  if (box.y < 0 || box.y > viewport.height - 40) return true;
  return box.height <= viewport.height && box.y + box.height > viewport.height;
}

// A short reason for a failed action. Playwright's first line only says it timed out; when another
// element was in the way, its log names it, which is what the user needs to know.
export function actionError(e) {
  const text = String(e?.message || e).replace(/\u001b\[[0-9;]*m/g, ''); // without the log's terminal colours
  const covered = text.match(/^\s*-\s*(<.*?>).*intercepts pointer events/m);
  const first = text.split('\n')[0].replace(/^\w+\.\w+: /, '');
  return covered ? `${first} Another element covers it: ${covered[1].slice(0, 160)}` : first;
}

export function expectList(step) {
  const e = step?.expect_text;
  return e == null ? [] : (Array.isArray(e) ? e : [e]).map(String);
}

// The words of a sentence, lowercased, for matching narration against labels and cues.
export function words(s) {
  return String(s ?? '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
}

// The page's visible text as lines, to compare what a recording shows with its storyboard.
export async function visibleText(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Lines that b has and a doesn't, and the other way round, counting repeated lines.
export function textDiff(a, b) {
  const count = (list) => list.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const added = [];
  const removed = [];
  for (const [l, n] of cb) for (let k = ca.get(l) || 0; k < n; k++) added.push(l);
  for (const [l, n] of ca) for (let k = cb.get(l) || 0; k < n; k++) removed.push(l);
  return { added, removed };
}

// Which expected strings aren't visible on the page, waiting up to waitMs for them to appear.
export async function missingText(page, list, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const missing = [];
    for (const s of list) {
      const n = await page.getByText(s, { exact: false }).filter({ visible: true }).count().catch(() => 0);
      if (!n) missing.push(s);
    }
    if (!missing.length || Date.now() > deadline) return missing;
    await page.waitForTimeout(200);
  }
}
