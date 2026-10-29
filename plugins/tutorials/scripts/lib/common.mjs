// Shared helpers for the tutorials plugin scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// Flags that are on or off, so the word after one is a tutorial id, not the flag's value.
const SWITCHES = new Set(['approve', 'manual', 'keep-frames', 'draft', 'force', 'html-only', 'unapproved', 'no-reset', 'samples']);

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (SWITCHES.has(key) || next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// Print a JSON result for Claude to read, and exit.
export function done(result, code = 0) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
}

export function fail(message, extra = {}) {
  done({ ok: false, error: message, ...extra }, 1);
}

// Load tutorials/config.yaml. The project root is the folder that contains tutorials/.
export function loadConfig(file) {
  const cfgFile = path.resolve(file || path.join(projectDir(), 'tutorials', 'config.yaml'));
  if (!fs.existsSync(cfgFile)) fail(`No config at ${cfgFile}. Create tutorials/config.yaml first (see references/formats.md).`);
  const cfg = readYaml(cfgFile);
  if (!cfg.app?.url) fail('tutorials/config.yaml needs app.url');
  const root = path.dirname(path.dirname(cfgFile));
  loadEnvFile(path.join(root, 'tutorials', '.env'));
  cfg.roles = Array.isArray(cfg.roles) && cfg.roles.length ? cfg.roles : [{ id: 'default' }];
  cfg.crawl = cfg.crawl || {};
  return { cfg, cfgFile, root, tutorials: path.join(root, 'tutorials') };
}

// Read KEY=VALUE lines from tutorials/.env (gitignored) without overriding the real environment.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// The tours to work on: the ids given, or every item in plan.yaml that has a tour.yaml.
// With { videos: true }, only items that become videos (kind video or both).
export function tourIds(tutorials, ids = [], { videos = false } = {}) {
  if (ids.length) return ids;
  const planFile = path.join(tutorials, 'plan.yaml');
  if (!fs.existsSync(planFile)) fail('No tutorials/plan.yaml yet. Run /tutorials:plan first.');
  const found = (readYaml(planFile).items || [])
    .filter((it) => !videos || it.kind !== 'sop')
    .map((it) => it.id)
    .filter((id) => fs.existsSync(path.join(tutorials, id, 'tour.yaml')));
  if (!found.length) fail(videos ? 'No video items with a tour.yaml in the plan.' : 'No tour.yaml files yet. /tutorials:plan creates them when the plan is approved.');
  return found;
}

// Put the app's demo data back before a tour, with config's app.reset command, then wait until the app
// answers again (the command may restart it). Returns an error message, or null.
export async function resetApp(cfg, root) {
  if (!cfg.app.reset) return null;
  const r = spawnSync(cfg.app.reset, { shell: true, cwd: path.resolve(root, cfg.app.cwd || '.'), encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) return `app.reset failed: ${String(r.stderr || r.stdout || r.error || '').trim().split('\n').slice(-3).join(' ')}`;
  const deadline = Date.now() + Number(cfg.app.ready_timeout || 60) * 1000;
  while (Date.now() < deadline) {
    try {
      await fetch(cfg.app.url, { redirect: 'manual' });
      return null;
    } catch {
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  return `The app didn't answer at ${cfg.app.url} after app.reset.`;
}

// Let one run at a time work on a tour's output, so two runs can't delete each other's files.
// Returns { release } or { error }. A lock left by a process that has exited is taken over.
export function lock(dir, what) {
  const file = path.join(dir, `.${what}.lock`);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && pid !== process.pid) return { error: `Another ${what} run (process ${pid}) is working on ${path.relative(process.cwd(), dir) || '.'}. Wait for it to finish, or stop it.` };
  }
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    heldLocks.delete(release);
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file);
    } catch {}
  };
  heldLocks.add(release);
  return { release };
}
const heldLocks = new Set();
process.on('exit', () => { for (const release of [...heldLocks]) release(); });

// Today's date as YYYY-MM-DD, for approved_at.
export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Where the plugin keeps what outlives a project, such as the voice engine's Python environment and model.
export function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'app-tutorials');
}

// config's music: a file relative to tutorials/, or { file, credit }; false or none means no music.
export function musicOf(cfg) {
  const m = cfg.music;
  if (!m || m === 'none') return null;
  return typeof m === 'string' ? { file: m, credit: null } : { file: m.file, credit: m.credit ? String(m.credit).trim() : null };
}

export function pickRole(cfg, id) {
  if (!id) return cfg.roles[0];
  const role = cfg.roles.find((r) => r.id === id);
  if (!role) fail(`No role "${id}" in config. Roles: ${cfg.roles.map((r) => r.id).join(', ')}`);
  return role;
}

export function authFile(tutorials, roleId) {
  return path.join(tutorials, '.auth', `${roleId}.json`);
}

// Replace ${VAR} with the environment variable's value. Missing variables are reported.
export function resolveEnv(value, label) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
    if (process.env[name] === undefined) fail(`Set the environment variable ${name} (used for ${label}).`);
    return process.env[name];
  });
}

export function absUrl(base, p) {
  return new URL(p || '/', base).toString();
}

// Launch Chromium. Falls back to an installed Chrome, then explains how to install a browser.
export async function launchBrowser(options = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fail('The plugin dependencies are not installed. Run: npm install --prefix "<plugin folder>"');
  }
  try {
    return await chromium.launch(options);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Executable doesn't exist|install/i.test(msg)) {
      try { return await chromium.launch({ ...options, channel: 'chrome' }); } catch {}
      fail('No browser found for Playwright. Run: cd "<plugin folder>" && npx playwright install chromium');
    }
    throw e;
  }
}

// Turn a path into a route pattern: /projects/123/tasks/9f1c... -> /projects/:id/tasks/:id
export function routePattern(pathname) {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg)) return ':id';
      return seg;
    })
    .join('/') || '/';
}

export function slugFor(url) {
  const u = new URL(url);
  const base = (u.pathname === '/' ? 'root' : u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'root';
  if (!u.search) return base.slice(0, 80);
  let h = 0;
  for (const ch of u.search) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${base.slice(0, 70)}-${h.toString(36)}`;
}
