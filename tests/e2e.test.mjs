// End-to-end test of the plugin's scripts on the two sample apps.
// From the repo root:
//   node --test tests/e2e.test.mjs                discover, probe, storyboard, approval and checks (about a minute)
//   E2E_FULL=1 node --test tests/e2e.test.mjs     also voice, record, render and bundle one video per app (a few minutes;
//                                                 needs ffmpeg and uv, and downloads the voice engine the first time)
// Each app runs on a free port from a temporary copy of its tutorials/ folder, so nothing in the repo changes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const scripts = path.join(repo, 'plugins', 'tutorials', 'scripts');
const full = process.env.E2E_FULL === '1';
const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
const GENERATED = /[\\/](\.auth|discovery|\.cache|storyboard|produce|dist)([\\/]|$)|storyboard\.html$/;

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A temporary project with a copy of an example's tutorials/ folder, and the example app running for it.
async function project(example, env = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tutorials-${example}-`));
  const tutorials = path.join(dir, 'tutorials');
  fs.cpSync(path.join(repo, 'examples', example, 'tutorials'), tutorials, { recursive: true, filter: (src) => !GENERATED.test(src) });
  const cfgFile = path.join(tutorials, 'config.yaml');
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace(/localhost:\d+/g, `localhost:${port}`));
  for (const [k, v] of Object.entries(env)) fs.appendFileSync(path.join(tutorials, '.env'), `${k}=${v}\n`);
  const server = spawn(process.execPath, [path.join(repo, 'examples', example, 'server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://localhost:${port}/`, { redirect: 'manual' });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const run = (script, ...args) => {
    const r = spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd: dir, encoding: 'utf8', timeout: 600000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    let out;
    try { out = JSON.parse(r.stdout); } catch { out = { ok: false, unparsed: r.stdout, stderr: r.stderr }; }
    return out;
  };
  const tour = (id) => path.join(tutorials, id, 'tour.yaml');
  return { dir, tutorials, run, tour, stop: () => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe('sample app (server-rendered, with a login)', () => {
  let p;
  before(async () => { p = await project('sample-app', { ACME_EMAIL: 'demo@example.com', ACME_PASSWORD: 'demo1234' }); });
  after(() => p.stop());

  test('logs in and crawls every page', () => {
    assert.equal(p.run('login.mjs', '--role', 'owner').ok, true);
    const crawl = p.run('crawl.mjs', '--role', 'owner');
    assert.equal(crawl.ok, true);
    assert.equal(crawl.pages, 9);
  });

  test('probe tells working forms from buttons that do nothing', () => {
    const probe = p.run('probe.mjs', '--role', 'owner');
    assert.equal(probe.ok, true);
    assert.ok(probe.saved.includes('/projects/new › Create project'), JSON.stringify(probe));
    assert.ok(probe.saved.includes('/settings/members › Send invite'));
    assert.ok(probe.no_effect.includes('/projects/:id › Share'));
    assert.ok(probe.no_effect.includes('/settings/billing › Change plan'));
  });

  test('reads the brand color from the app', () => {
    const look = p.run('look.mjs', '--role', 'owner');
    assert.equal(look.ok, true, JSON.stringify(look));
    assert.equal(look.suggest.brand.color, '#3b5bdb');
  });

  test('the example files pass their checks', () => {
    for (const kind of ['features', 'plan', 'tours']) {
      const r = p.run('check.mjs', kind);
      assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r.errors)}`);
      assert.deepEqual(r.warnings, [], kind);
    }
  });

  test('every tour storyboards and can be approved', () => {
    const sb = p.run('storyboard.mjs');
    assert.equal(sb.ok, true, JSON.stringify(sb.tours.filter((t) => !t.ok)));
    const approve = p.run('storyboard.mjs', '--approve');
    assert.equal(approve.ok, true);
    assert.equal(approve.approved.length, 5);
    // Ids after a flag are ids, not the flag's value.
    assert.deepEqual(p.run('storyboard.mjs', '--approve', 'invite-a-teammate').approved, ['invite-a-teammate']);
    // With every storyboard approved, the next step is making the four videos.
    const status = p.run('status.mjs');
    assert.equal(status.next.stage, 'produce', JSON.stringify(status.next));
    assert.equal(status.next.ids.length, 4);
  });

  test('bundles the SOPs with their screenshots, and leaves out videos not produced yet', async () => {
    const b = p.run('bundle.mjs');
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.sops, 2);
    assert.equal(b.videos, 0);
    assert.equal(b.complete, false);
    assert.ok(b.not_included.some((x) => x.id === 'invite-a-teammate' && x.what === 'video' && /hasn't been produced/.test(x.reason)));
    const dist = path.join(p.tutorials, 'dist');
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'tutorials.json'), 'utf8'));
    assert.deepEqual(manifest.items.map((it) => it.id), ['invite-a-teammate', 'find-and-check-billing']);
    for (const it of manifest.items) {
      assert.ok(fs.statSync(path.join(dist, it.sop.pdf)).size > 20000, it.sop.pdf);
      assert.ok(it.sop.images.length >= 3 && it.sop.images.every((img) => fs.existsSync(path.join(dist, img))), it.id);
      assert.ok(fs.existsSync(path.join(dist, it.thumbnail)));
      assert.doesNotMatch(fs.readFileSync(path.join(dist, it.sop.markdown), 'utf8'), /\(step:/);
    }
    // The page has to run, not just contain the right text: a stray escape once left it blank.
    const page = await openPage(path.join(dist, 'index.html'));
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.cards, ['Invite a teammate', 'Check your plan and invoices']);
    // It never replaces a folder it didn't make.
    const other = path.join(p.dir, 'public');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
    assert.equal(p.run('bundle.mjs', '--out', other).ok, false);
    assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
  });

  test('a tour edited after approval is caught', () => {
    const file = p.tour('invite-a-teammate');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('Then click Members.', 'Now click Members.'));
    try {
      assert.ok(p.run('check.mjs', 'tours').warnings.some((w) => w.includes('changed after its storyboard was approved')));
      const rec = p.run('record.mjs', 'invite-a-teammate');
      assert.equal(rec.ok, false);
      assert.match(rec.tours[0].error, /changed after its storyboard was approved/);
      assert.equal(p.run('storyboard.mjs', '--approve', 'invite-a-teammate').ok, false);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  test('a page that lacks the expected text stops the storyboard', () => {
    const file = p.tour('find-and-check-billing');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('expect_text: Team plan', 'expect_text: Enterprise plan'));
    try {
      const sb = p.run('storyboard.mjs', 'find-and-check-billing');
      assert.equal(sb.ok, false);
      assert.match(sb.tours[0].failed.reason, /should show "Enterprise plan"/);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  test('tours that change data without app.reset are flagged', () => {
    const cfgFile = path.join(p.tutorials, 'config.yaml');
    const original = fs.readFileSync(cfgFile, 'utf8');
    fs.writeFileSync(cfgFile, original.replace(/^\s*reset:.*$/m, ''));
    try {
      assert.ok(p.run('check.mjs', 'tours').warnings.some((w) => w.includes('no app.reset')));
    } finally {
      fs.writeFileSync(cfgFile, original);
    }
  });

  test('produces a video that matches its storyboard', { skip: !full && 'set E2E_FULL=1' }, () => {
    const id = 'find-a-project-and-tick-off-tasks';
    const sb = p.run('storyboard.mjs', id);
    assert.equal(sb.ok, true, JSON.stringify(sb));
    const approve = p.run('storyboard.mjs', '--approve', id);
    assert.deepEqual(approve.approved, [id], JSON.stringify(approve));
    // Ming is the default narrator on Apple Silicon, Kokoro elsewhere; the helpdesk pins Kokoro.
    const voice = p.run('voice.mjs', id);
    assert.equal(voice.ok, true, JSON.stringify(voice));
    assert.equal(voice.engine, appleSilicon ? 'ming' : 'kokoro');
    assert.deepEqual(voice.tours[0].without_word_timings, []);
    const rec = p.run('record.mjs', id);
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.deepEqual(rec.tours[0].differences, []);
    const render = p.run('render.mjs', id);
    assert.equal(render.ok, true, JSON.stringify(render));
    assert.deepEqual(render.tours[0].problems, []);
    assert.ok(fs.statSync(path.join(p.tutorials, id, 'produce', 'video.mp4')).size > 500000);
    assert.equal(p.run('render.mjs', id).tours[0].up_to_date, true);
    bundled(p, id);
  });

  test('describes a new narrator, keeps a take, and narrates with it', { skip: (!full && 'set E2E_FULL=1') || (!appleSilicon && 'Ming needs Apple Silicon') }, () => {
    const takes = p.run('voice.mjs', '--samples', '--describe', 'A calm, friendly man in his forties, unhurried and reassuring.', '--takes', '1');
    assert.equal(takes.voices?.length, 1, JSON.stringify(takes));
    assert.equal(p.run('voice.mjs', '--keep', '1').ok, true);
    const voice = p.run('voice.mjs', 'invite-a-teammate');
    assert.equal(voice.voice, 'assets/voice/narrator.wav', JSON.stringify(voice));
    assert.deepEqual(voice.tours[0].without_word_timings, []);
  });
});

test('status sends a new project to discover', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorials-empty-'));
  try {
    const r = spawnSync(process.execPath, [path.join(scripts, 'status.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(JSON.parse(r.stdout).next.stage, 'discover');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('helpdesk app (single-page, no login)', () => {
  let p;
  before(async () => { p = await project('spa-app'); });
  after(() => p.stop());

  test('reads the brand color and language from the app', () => {
    const look = p.run('look.mjs');
    assert.equal(look.suggest.brand.color, '#2f6fed');
    assert.equal(look.lang, 'en');
  });

  test('crawls the client-side routes', () => {
    const crawl = p.run('crawl.mjs');
    assert.equal(crawl.ok, true);
    assert.deepEqual([...crawl.patterns].sort(), ['/', '/settings', '/tickets/:id']);
  });

  test('probe finds the dialog, the saved change and the form that saves nothing', () => {
    const probe = p.run('probe.mjs');
    assert.equal(probe.ok, true);
    assert.ok(probe.not_saved.includes('/settings › Send feedback'), JSON.stringify(probe));
    assert.ok(probe.saved.includes('/tickets/:id › Mark as solved'));
    const controls = JSON.parse(fs.readFileSync(path.join(p.tutorials, 'discovery', 'default', 'probe.json'), 'utf8')).controls;
    assert.equal(controls.find((c) => c.label === 'New ticket').result, 'opened a dialog');
  });

  test('storyboards a modal, a custom menu, a toast and a long list', () => {
    const sb = p.run('storyboard.mjs');
    assert.equal(sb.ok, true, JSON.stringify(sb.tours.filter((t) => !t.ok)));
    assert.equal(p.run('storyboard.mjs', '--approve').ok, true);
  });

  test('produces a video that matches its storyboard', { skip: !full && 'set E2E_FULL=1' }, () => {
    const id = 'create-a-ticket';
    const samples = p.run('voice.mjs', '--samples', '--voices', 'af_heart,bm_george');
    assert.deepEqual(samples.voices?.map((v) => v.voice), ['af_heart', 'bm_george'], JSON.stringify(samples));
    assert.ok(fs.existsSync(path.join(p.tutorials, '.cache', 'voice', 'samples.html')));
    // Music from incompetech, credited on the closing card and in the bundle.
    assert.ok(p.run('music.mjs', 'search', '--limit', '3').tracks.length > 0);
    const music = p.run('music.mjs', 'pick', 'Somewhere Sunny (ver 2)');
    assert.equal(music.ok, true, JSON.stringify(music));
    assert.equal(p.run('voice.mjs', id).ok, true);
    const rec = p.run('record.mjs', id);
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.deepEqual(rec.tours[0].differences, []);
    const render = p.run('render.mjs', id);
    assert.equal(render.ok, true, JSON.stringify(render));
    assert.deepEqual(render.tours[0].problems, []);
    assert.match(fs.readFileSync(path.join(p.tutorials, id, 'produce', 'render', 'index.html'), 'utf8'), /class="credit">&quot;Somewhere Sunny/);
    bundled(p, id);
    assert.match(JSON.parse(fs.readFileSync(path.join(p.tutorials, 'dist', 'tutorials.json'), 'utf8')).music_credit, /Kevin MacLeod/);
  });
});

// Open a page in Chromium and report its script errors and the tutorial cards it shows.
async function openPage(file) {
  const { chromium } = await import(path.join(repo, 'plugins', 'tutorials', 'node_modules', 'playwright', 'index.mjs'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`file://${file}`);
    await page.waitForTimeout(300);
    return { errors, cards: await page.locator('.card h2').allTextContents() };
  } finally {
    await browser.close();
  }
}

// The bundle has the video with a chapter per step inside, its captions and chapters files, and a thumbnail.
function bundled(p, id) {
  const b = p.run('bundle.mjs', id);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.videos, 1, JSON.stringify(b));
  const dir = path.join(p.tutorials, 'dist', id);
  const steps = JSON.parse(fs.readFileSync(path.join(p.tutorials, id, 'produce', 'video.json'), 'utf8')).steps.length;
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', path.join(dir, `${id}.mp4`)], { encoding: 'utf8' });
  assert.equal(JSON.parse(probe.stdout).chapters.length, steps);
  for (const f of [`${id}.vtt`, `${id}.chapters.vtt`, `${id}.jpg`]) assert.ok(fs.existsSync(path.join(dir, f)), f);
}
