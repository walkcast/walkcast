#!/usr/bin/env node
// Check that what the plugin needs is in place, and say how to fix what isn't.
// Usage: node doctor.mjs [--for discover|storyboard|produce] [--config tutorials/config.yaml]
//
// --for picks the stage to check for (default produce, which needs everything). Each check has ok,
// detail and, when it fails, fix. "ok" overall is false if any required check fails; warnings don't count.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { authFile, dataDir, done, launchBrowser, parseArgs, projectDir, readYaml } from './lib/common.mjs';
import { changesData } from './lib/tour.mjs';

const args = parseArgs();
const stage = args.for || 'produce';
const later = { discover: 0, storyboard: 1, produce: 2 }[stage];
if (later === undefined) done({ ok: false, error: 'Use --for discover, storyboard or produce.' }, 1);
const require = createRequire(import.meta.url);
const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checks = [];
const add = (name, ok, detail, fix, level = 'required') => checks.push({ name, ok, level, detail, ...(ok ? {} : { fix }) });

const major = Number(process.versions.node.split('.')[0]);
add('node', major >= 22, `Node ${process.versions.node}`, 'Install Node 22 or later (https://nodejs.org).', later >= 2 ? 'required' : 'warning');

const missing = ['playwright', 'yaml', 'marked', 'hyperframes/package.json', 'gsap/package.json'].filter((m) => { try { require.resolve(m); return false; } catch { return true; } });
add('dependencies', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : 'installed', `npm install --prefix "${plugin}"`);

let browserOk = false;
try {
  const b = await launchBrowser({ headless: true });
  await b.close();
  browserOk = true;
} catch {}
add('browser', browserOk, browserOk ? 'Chromium starts' : 'Chromium doesn\'t start', `cd "${plugin}" && npx playwright install chromium`);

// The project's config, app and sessions.
const cfgFile = path.resolve(args.config || path.join(projectDir(), 'tutorials', 'config.yaml'));
let cfg = null;
try { cfg = readYaml(cfgFile); } catch {}
add('config', Boolean(cfg?.app?.url), cfg ? (cfg.app?.url ? `app at ${cfg.app.url}` : 'no app.url') : `no ${path.relative(process.cwd(), cfgFile)}`, 'Run /tutorials:discover, which writes tutorials/config.yaml.', later ? 'required' : 'warning');
if (cfg?.app?.url) {
  let up = false;
  try { await fetch(cfg.app.url, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); up = true; } catch {}
  add('app', up, up ? `${cfg.app.url} answers` : `nothing answers at ${cfg.app.url}`, `node "${plugin}/scripts/app.mjs" start`);
  const tutorials = path.dirname(cfgFile);
  if (later >= 1) {
    for (const role of cfg.roles || []) {
      if (!role.login) continue;
      const has = fs.existsSync(authFile(tutorials, role.id));
      add(`session ${role.id}`, has, has ? 'saved' : 'not logged in yet', `node "${plugin}/scripts/login.mjs" --role ${role.id}`);
    }
    const tours = fs.existsSync(tutorials) ? fs.readdirSync(tutorials).filter((d) => fs.existsSync(path.join(tutorials, d, 'tour.yaml'))) : [];
    const changing = tours.filter((id) => (readYaml(path.join(tutorials, id, 'tour.yaml')).steps || []).some(changesData));
    add('reset', Boolean(cfg.app.reset) || !changing.length, cfg.app.reset ? 'app.reset is set' : changing.length ? `no app.reset, but ${changing.join(', ')} change data` : 'no tour changes data',
      'Add app.reset to config.yaml: a command that puts the demo data back, such as a seed script.', 'warning');
  }
}

if (later >= 2) {
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  add('ffmpeg', ff.status === 0 && /libx264/.test(ff.stdout), ff.status === 0 ? (/libx264/.test(ff.stdout) ? 'with libx264' : 'without libx264') : 'not found', 'brew install ffmpeg (macOS), or your package manager\'s ffmpeg with libx264');
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  add('uv', uv.status === 0, uv.status === 0 ? uv.stdout.trim() : 'not found', 'brew install uv, or curl -LsSf https://astral.sh/uv/install.sh | sh');
  // Kokoro is the default; config.yaml's voice.engine can choose Ming (MLX, Apple Silicon only).
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const engine = cfg?.voice?.engine || 'kokoro';
  if (engine === 'ming' && !appleSilicon) add('voice engine', false, 'ming runs only on Apple Silicon Macs', 'Set voice.engine to kokoro in tutorials/config.yaml.');
  else {
    const venv = path.join(dataDir(), 'voice', engine);
    const ready = fs.existsSync(path.join(venv, 'tutorials-plugin.json'));
    add('voice engine', true, ready ? `${engine}, installed in ${venv}` : `${engine}, not installed yet; voice.mjs installs it on first use (${engine === 'ming' ? 'about 4.5 GB' : 'about 1.2 GB'})`, null, 'info');
  }
  let hf = null;
  try { hf = spawnSync(process.execPath, [path.join(path.dirname(require.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs'), '--version'], { encoding: 'utf8', env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1' } }); } catch {}
  add('hyperframes', hf?.status === 0, hf?.status === 0 ? `version ${hf.stdout.trim().split('\n').pop()}` : 'doesn\'t run', `npm install --prefix "${plugin}"`);
}

const ok = checks.every((c) => c.ok || c.level !== 'required');
done({ ok, for: stage, checks }, ok ? 0 : 1);
