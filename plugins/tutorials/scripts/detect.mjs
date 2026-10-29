#!/usr/bin/env node
// Guess how to run the app in a project folder: framework, start command and local URL.
// Usage: node detect.mjs [projectDir]
import fs from 'node:fs';
import path from 'node:path';
import { done, parseArgs, projectDir, readYaml } from './lib/common.mjs';

const args = parseArgs();
const root = path.resolve(args._[0] || projectDir());

const FRAMEWORKS = [
  ['next', 'Next.js', 3000],
  ['nuxt', 'Nuxt', 3000],
  ['@remix-run/dev', 'Remix', 3000],
  ['@react-router/dev', 'React Router', 5173],
  ['@sveltejs/kit', 'SvelteKit', 5173],
  ['astro', 'Astro', 4321],
  ['@angular/core', 'Angular', 4200],
  ['gatsby', 'Gatsby', 8000],
  ['react-scripts', 'Create React App', 3000],
  ['vite', 'Vite', 5173],
  ['@nestjs/core', 'NestJS', 3000],
  ['express', 'Express', 3000],
  ['fastify', 'Fastify', 3000],
  ['hono', 'Hono', 3000],
];

const SUBDIRS = ['.', 'web', 'app', 'frontend', 'client', 'apps/web', 'apps/app', 'apps/frontend', 'packages/web'];
const candidates = [];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function envPort(dir) {
  for (const f of ['.env.local', '.env.development', '.env']) {
    try {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^\s*PORT\s*=\s*"?(\d+)/m);
      if (m) return Number(m[1]);
    } catch {}
  }
  return null;
}

// For scripts like "node server.js", look for a default port in the entry file.
function portInEntry(dir, script = '') {
  const entry = script.match(/\b(?:node|tsx|ts-node|bun)\s+(?:--\S+\s+)*([\w./-]+\.(?:m?[jt]s|cjs))/)?.[1];
  if (!entry) return null;
  try {
    const src = fs.readFileSync(path.join(dir, entry), 'utf8');
    const m = src.match(/PORT\s*\)?\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/) || src.match(/\.listen\(\s*(\d{2,5})/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function pm(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

for (const sub of SUBDIRS) {
  const dir = path.join(root, sub);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) continue;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = FRAMEWORKS.find(([name]) => deps[name]);
  const scripts = pkg.scripts || {};
  const script = ['dev', 'start:dev', 'serve', 'start'].find((s) => scripts[s]);
  if (!fw && !script) continue;
  const portFromScript = Number((scripts[script] || '').match(/(?:--port|-p|PORT=)\s*=?\s*(\d{2,5})/)?.[1]) || null;
  const port = portFromScript || envPort(dir) || portInEntry(dir, scripts[script]) || fw?.[2] || 3000;
  const runner = pm(dir);
  candidates.push({
    dir: sub,
    kind: fw?.[1] || 'Node',
    start: script ? (runner === 'npm' ? `npm run ${script}` : `${runner} ${script}`) : null,
    url: `http://localhost:${port}`,
    why: [fw && `depends on ${fw[0]}`, script && `has a "${script}" script: ${scripts[script]}`].filter(Boolean).join('; '),
  });
}

const exists = (f) => fs.existsSync(path.join(root, f));
const text = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };

if (exists('manage.py')) candidates.push({ dir: '.', kind: 'Django', start: 'python manage.py runserver', url: 'http://localhost:8000', why: 'has manage.py' });
if (/fastapi|uvicorn/i.test(text('pyproject.toml') + text('requirements.txt'))) candidates.push({ dir: '.', kind: 'FastAPI', start: 'uvicorn main:app --reload', url: 'http://localhost:8000', why: 'depends on fastapi/uvicorn (check the app module path)' });
if (/flask/i.test(text('pyproject.toml') + text('requirements.txt'))) candidates.push({ dir: '.', kind: 'Flask', start: 'flask run', url: 'http://localhost:5000', why: 'depends on flask' });
if (/\brails\b/.test(text('Gemfile'))) candidates.push({ dir: '.', kind: 'Rails', start: exists('bin/dev') ? 'bin/dev' : 'bin/rails server', url: 'http://localhost:3000', why: 'Gemfile includes rails' });
if (exists('artisan')) candidates.push({ dir: '.', kind: 'Laravel', start: 'php artisan serve', url: 'http://localhost:8000', why: 'has artisan' });

for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
  if (!exists(f)) continue;
  try {
    const compose = readYaml(path.join(root, f));
    for (const [name, svc] of Object.entries(compose.services || {})) {
      const port = (svc.ports || []).map((p) => String(p).split(':')[0]).find((p) => /^\d+$/.test(p));
      if (port) candidates.push({ dir: '.', kind: `Docker Compose (${name})`, start: 'docker compose up', url: `http://localhost:${port}`, why: `${f} publishes port ${port} for ${name}` });
    }
  } catch {}
}

done({
  ok: true,
  project: root,
  has_config: exists('tutorials/config.yaml'),
  candidates,
  hint: candidates.length ? 'Confirm the start command and URL with the README before writing config.yaml.' : 'Nothing detected. Read the README or ask the user how they run the app locally.',
});
