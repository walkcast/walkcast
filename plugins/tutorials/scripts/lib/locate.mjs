// Find the element behind a tour step: a saved locator first, then the step's target label.
// Shared by storyboard.mjs, which resolves and saves locators, and record.mjs, which replays them.

const firstLine = (e) => String(e?.message || e).split('\n')[0];

const CLICKABLE = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'combobox', 'textbox', 'searchbox'];
const FIELDS = ['textbox', 'searchbox', 'combobox', 'spinbutton'];
// Roles a target can have, per action.
const ROLES = {
  click: CLICKABLE, hover: CLICKABLE, scroll: CLICKABLE,
  type: FIELDS, press: [...FIELDS, 'button', 'link'],
  select: ['combobox', 'listbox'],
  check: ['checkbox', 'radio', 'switch', 'menuitemcheckbox'],
};

// Turn a locator from tour.yaml into a Playwright locator over visible elements.
export function build(root, loc) {
  const base = loc.within ? build(root, loc.within) : root;
  const exact = loc.exact ?? true;
  let l;
  if (loc.role) l = base.getByRole(loc.role, loc.name == null ? {} : { name: String(loc.name), exact });
  else if (loc.label) l = base.getByLabel(String(loc.label), { exact });
  else if (loc.text) l = base.getByText(String(loc.text), { exact });
  else if (loc.css) l = base.locator(loc.css);
  else throw new Error(`A locator needs role, label, text or css (got ${JSON.stringify(loc)})`);
  l = l.filter({ visible: true });
  return loc.nth == null ? l : l.nth(Number(loc.nth));
}

// Find a step's element. A saved locator wins while it still matches exactly one element. Otherwise the
// target is tried as an accessible name (getByRole), then a field label (getByLabel), then visible text
// (getByText): exact matches first, then partial ones. Retries until the page shows it or time runs out.
export async function resolve(page, step, { waitMs = 5000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let found;
    if (step.locator) {
      try {
        const el = build(page, step.locator);
        if ((await el.count()) === 1) return { el, locator: step.locator, element: await describe(el) };
        found = { reason: `The saved locator ${JSON.stringify(step.locator)} matches ${await el.count()} elements` };
      } catch (e) {
        found = { reason: firstLine(e) };
      }
    }
    if (step.target != null) {
      found = await byLabel(page, step);
      if (found.el) {
        found.element = await describe(found.el);
        if (step.locator) found.note = `The saved locator stopped matching, so the step was re-resolved as ${found.element}`;
        if (found.locator.exact === false) found.note = `"${step.target}" only matched part of ${found.element}; use the exact label as the target`;
        return found;
      }
    }
    if (Date.now() > deadline) return found;
    await page.waitForTimeout(250);
  }
}

async function byLabel(page, step) {
  const name = String(step.target);
  const roles = ROLES[step.do] || CLICKABLE;
  for (const exact of [true, false]) {
    const opt = exact ? {} : { exact: false };
    const tiers = [roles.map((role) => ({ role, name, ...opt })), [{ label: name, ...opt }], [{ text: name, ...opt }]];
    for (const tier of tiers) {
      const hits = [];
      for (const loc of tier) {
        const count = await build(page, loc).count();
        if (count) hits.push({ loc, count });
      }
      const total = hits.reduce((sum, h) => sum + h.count, 0);
      if (total === 1) return { el: build(page, hits[0].loc), locator: hits[0].loc };
      if (total > 1) return { reason: `"${name}" matches ${total} elements`, candidates: await candidates(page, hits) };
    }
  }
  return { reason: `Nothing on the page is labelled "${name}"` };
}

async function candidates(page, hits) {
  const out = [];
  for (const { loc, count } of hits) {
    for (let k = 0; k < Math.min(count, 5); k++) {
      const el = build(page, { ...loc, nth: k });
      out.push({ locator: { ...loc, nth: k }, element: await describe(el), inside: await landmark(el), box: await el.boundingBox() });
    }
  }
  return out.slice(0, 10);
}

// The element's role and accessible name as Playwright sees them, e.g. link "New project".
export async function describe(el) {
  const snap = await el.ariaSnapshot({ timeout: 2000 }).catch(() => '');
  const line = snap.split('\n')[0].replace(/^- /, '').replace(/:$/, '').slice(0, 100);
  return line || el.evaluate((e) => e.tagName.toLowerCase()).catch(() => 'element');
}

async function landmark(el) {
  return el.evaluate((e) => {
    const l = e.parentElement?.closest('nav,aside,header,main,footer,form,dialog,table,section,[role]');
    if (!l) return null;
    const label = l.getAttribute('aria-label') || l.querySelector('h1,h2,h3,legend,caption')?.textContent?.trim();
    return `${l.getAttribute('role') || l.tagName.toLowerCase()}${label ? ` "${label.slice(0, 60)}"` : ''}`;
  }).catch(() => null);
}
