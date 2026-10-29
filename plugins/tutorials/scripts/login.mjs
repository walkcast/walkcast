#!/usr/bin/env node
// Log in as a role from tutorials/config.yaml and save the session to tutorials/.auth/<role>.json.
// Usage: node login.mjs [--role admin] [--manual] [--timeout 300] [--config tutorials/config.yaml]
//
// Automatic mode fills the username and password fields by their labels and submits.
// --manual (or login.manual: true) opens a visible browser so you can log in yourself,
// for single sign-on, one-time codes or anything else automatic mode can't handle.
import fs from 'node:fs';
import path from 'node:path';
import { absUrl, authFile, done, fail, launchBrowser, loadConfig, parseArgs, pickRole, resolveEnv } from './lib/common.mjs';

const args = parseArgs();
const { cfg, tutorials } = loadConfig(args.config);
const role = pickRole(cfg, args.role);
const login = role.login;
const out = authFile(tutorials, role.id);

if (!login) done({ ok: true, role: role.id, note: 'This role has no login settings, so no session is needed.' });

const loginUrl = absUrl(cfg.app.url, login.url || '/login');
const loginPath = new URL(loginUrl).pathname;
const manual = Boolean(args.manual || login.manual);
const timeoutMs = Number(args.timeout || (manual ? 300 : 30)) * 1000;
const viewport = cfg.crawl.viewport || { width: 1440, height: 900 };

function loggedIn(page) {
  const u = new URL(page.url());
  if (login.success) return u.pathname.startsWith(login.success) || page.url().startsWith(absUrl(cfg.app.url, login.success));
  return u.pathname !== loginPath;
}

async function passwordVisible(page) {
  return page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

async function firstVisible(candidates) {
  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

const browser = await launchBrowser({ headless: !manual });
const context = await browser.newContext({ viewport });
const page = await context.newPage();

try {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  if (manual) {
    console.error(`A browser window is open at ${loginUrl}. Log in there; the session saves automatically once you're in (waiting up to ${timeoutMs / 1000}s).`);
  } else {
    const username = resolveEnv(login.username, `role ${role.id} username`);
    const password = resolveEnv(login.password, `role ${role.id} password`);
    if (!username || !password) fail(`Role ${role.id} needs login.username and login.password, or set manual: true.`);

    const userLabel = login.username_field ? new RegExp(login.username_field, 'i') : /e-?mail|user ?name|login/i;
    const passLabel = login.password_field ? new RegExp(login.password_field, 'i') : /password/i;
    const userField = await firstVisible([
      page.getByLabel(userLabel),
      page.getByPlaceholder(userLabel),
      page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[autocomplete="username"]'),
    ]);
    if (!userField) fail('Could not find the username or email field. Set login.username_field to its label, or use --manual.');
    await userField.fill(username);

    let passField = await firstVisible([page.getByLabel(passLabel), page.locator('input[type="password"]')]);
    if (!passField) {
      // Two-step logins show the password field after the first submit.
      const next = await firstVisible([page.getByRole('button', { name: /next|continue/i })]);
      if (next) { await next.click(); await page.waitForTimeout(1500); }
      passField = await firstVisible([page.getByLabel(passLabel), page.locator('input[type="password"]')]);
    }
    if (!passField) fail('Could not find the password field. Set login.password_field to its label, or use --manual.');
    await passField.fill(password);

    const submitName = login.submit ? new RegExp(login.submit, 'i') : /sign ?in|log ?in|continue|submit/i;
    const submit = await firstVisible([page.getByRole('button', { name: submitName }), page.locator('button[type="submit"], input[type="submit"]')]);
    if (submit) await submit.click(); else await passField.press('Enter');
  }

  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    if (loggedIn(page) && !(await passwordVisible(page))) break;
    // In automatic mode, stop early when the login page shows an error message.
    if (!manual && Date.now() - started > 3000) {
      const alert = page.locator('[role="alert"], .error, .alert-danger, [aria-invalid="true"]').first();
      if (await alert.isVisible().catch(() => false)) {
        const text = (await alert.textContent().catch(() => '') || '').trim().slice(0, 200);
        fail(`Login was rejected${text ? `: "${text}"` : ''}. Check the credentials in tutorials/.env, or run with --manual.`, { url: page.url() });
      }
    }
    await page.waitForTimeout(1000);
  }
  if (!loggedIn(page) || (await passwordVisible(page))) {
    fail(manual ? 'Timed out waiting for the login to finish.' : 'Login did not succeed: still on the login page. Check the credentials, set the field labels in config, or run with --manual.', { url: page.url() });
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await context.storageState({ path: out });
  done({ ok: true, role: role.id, landed_on: page.url(), saved: path.relative(process.cwd(), out) });
} finally {
  await browser.close();
}
