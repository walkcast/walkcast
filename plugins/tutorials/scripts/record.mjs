#!/usr/bin/env node
// Record each tour the way the narrator performs it, for render.mjs to turn into the final video.
// Usage: node record.mjs [<tutorial-id> ...] [--config tutorials/config.yaml] [--keep-frames] [--unapproved]
//
// Needs tutorials/<id>/produce/voice.json from voice.mjs, and a tour approved as it stands
// (storyboard.mjs --approve); --unapproved skips that check. Each step lasts as long as its narration
// line, and the pointer reaches the target and acts as the narrator finishes naming it (its cue, if
// the step has one). The viewport is captured continuously at twice its size, then encoded at 30 fps.
// Writes to tutorials/<id>/produce/:
//   recording.mp4    the app's viewport at 2x, 30 fps, no pointer (render.mjs draws it)
//   recording.json   when each step and narration line starts and ends, every action with its time,
//                    the target's box and the pointer's path in viewport pixels, and where the page's
//                    text differed from the approved storyboard
// Tours change the app's data, so config's app.reset command, if set, runs before each tour. A step
// whose expect_text isn't on the page afterwards fails the recording.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { absUrl, authFile, done, fail, launchBrowser, loadConfig, lock, parseArgs, readYaml, resetApp, tourIds, writeJson } from './lib/common.mjs';
import { resolve } from './lib/locate.mjs';
import { recordingInputs } from './lib/produce.mjs';
import { actionError, approvalProblem, expectList, missingText, needsScroll, textDiff, tourHash, visibleText, words } from './lib/tour.mjs';

// Pacing, in seconds.
const LEAD_IN = 0.6; // screen before the first line
const GAP = 0.45; // pause after each line
const TRAVEL = 0.75; // longest pointer move
const MIN_TRAVEL = 0.35;
const TYPE_DELAY = 0.055; // per character
const TAIL = 1.2; // screen after the last step
const FPS = 30;

// Words that announce an action, so the pointer can act as the narrator finishes that phrase.
const VERBS = {
  click: ['click', 'open', 'press', 'choose', 'select', 'pick'],
  check: ['tick', 'check', 'mark', 'untick', 'uncheck'],
  type: ['type', 'enter', 'give', 'add', 'fill', 'write', 'name'],
  select: ['choose', 'pick', 'select', 'set'],
  hover: ['hover', 'point'],
};
const CLAUSE_END = new Set(['to', 'and', 'so', 'then', 'which', 'when', 'because']);

const args = parseArgs();
const { cfg, root, tutorials } = loadConfig(args.config);
const viewport = cfg.crawl.viewport || { width: 1440, height: 900 };
const ids = tourIds(tutorials, args._, { videos: true });

const browser = await launchBrowser({ headless: true });
const results = [];
try {
  for (const id of ids) results.push(await recordTour(id));
} finally {
  await browser.close();
}
const ok = results.every((r) => r.ok);
done({ ok, tours: results }, ok ? 0 : 1);

async function recordTour(id) {
  const dir = path.join(tutorials, id);
  const outDir = path.join(dir, 'produce');
  const tourFile = path.join(dir, 'tour.yaml');
  const voiceFile = path.join(outDir, 'voice.json');
  if (!fs.existsSync(tourFile)) return { id, ok: false, error: `No ${rel(tourFile)}` };
  const tour = readYaml(tourFile);
  if (!args.unapproved) {
    const problem = approvalProblem(tour);
    if (problem) return { id, ok: false, error: `Not recording: ${problem}. Storyboard it, show it to the user, and approve it with storyboard.mjs --approve.` };
  }
  if (!fs.existsSync(voiceFile)) return { id, ok: false, error: `No ${rel(voiceFile)}. Run voice.mjs first.` };
  const voice = JSON.parse(fs.readFileSync(voiceFile, 'utf8'));
  const steps = tour.steps || [];
  if (voice.steps.length !== steps.length || voice.steps.some((v, i) => (v.say || null) !== (String(steps[i]?.say ?? '').trim() || null))) {
    return { id, ok: false, error: 'voice.json is out of date with tour.yaml. Run voice.mjs again.' };
  }
  const role = tour.role ? cfg.roles.find((r) => r.id === tour.role) : cfg.roles[0];
  if (!role) return { id, ok: false, error: `Role "${tour.role}" isn't in tutorials/config.yaml` };
  const session = authFile(tutorials, role.id);
  if (role.login && !fs.existsSync(session)) return { id, ok: false, error: `No saved session for role ${role.id}. Run login.mjs --role ${role.id} first.` };

  // The approved storyboard's text at each step, to notice when the app's data differs from it.
  const sbFile = path.join(dir, 'storyboard', 'steps.json');
  const sb = fs.existsSync(sbFile) ? JSON.parse(fs.readFileSync(sbFile, 'utf8')) : null;
  const reference = sb?.ok && sb.tour_hash === tourHash(tour) ? new Map(sb.steps.map((st) => [st.n, st.text || []])) : null;
  const inputs = recordingInputs(tour, fs.readFileSync(voiceFile, 'utf8'));

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffmpeg.error || ffmpeg.status !== 0) fail('Recording needs ffmpeg. Install it with "brew install ffmpeg" (macOS) or your package manager, then run this again.');
  const held = lock(outDir, 'record');
  if (held.error) return { id, ok: false, error: held.error };
  try {
    return await recordLocked({ id, tour, voice, steps, role, session, outDir, reference, inputs });
  } finally {
    held.release();
  }
}

async function recordLocked({ id, tour, voice, steps, role, session, outDir, reference, inputs }) {
  const resetError = await resetApp(cfg, root);
  if (resetError) return { id, ok: false, error: resetError };

  // Frames go in a folder of this run's own, so nothing else can delete them mid-recording.
  const framesDir = path.join(outDir, `frames-${process.pid}`);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, acceptDownloads: true, storageState: fs.existsSync(session) ? session : undefined });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const notes = [];
  page.on('popup', () => notes.push('A step opened a new tab, which the recording doesn\'t follow'));

  const startUrl = absUrl(cfg.app.url, tour.start || '/');
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await settle(page);
  if (role.login && new URL(page.url()).pathname === new URL(absUrl(cfg.app.url, role.login.url || '/login')).pathname) {
    await context.close();
    return { id, ok: false, error: `The start page redirected to the login page, so the ${role.id} session has expired. Run login.mjs --role ${role.id} and try again.` };
  }

  // Capture the viewport continuously at 2x, about 20 frames a second. A frame identical to the one before
  // isn't kept: the earlier one lasts longer. (page.screenshot copes with navigations better than raw CDP.)
  const T0 = performance.now();
  const now = () => (performance.now() - T0) / 1000;
  const frames = [];
  const writes = [];
  let capturing = true;
  const capture = (async () => {
    let last = null;
    while (capturing) {
      const t0 = now();
      let shot;
      try {
        // A capture that is in flight as a navigation commits never returns. Give up on it quickly and
        // take the next one, so the new page shows up within about 0.3 s. A normal capture takes ~50 ms.
        shot = await page.screenshot({ type: 'jpeg', quality: 95, caret: 'initial', timeout: 300 });
      } catch {
        continue;
      }
      if (last && shot.equals(last)) continue;
      last = shot;
      const file = path.join(framesDir, `${String(frames.length + 1).padStart(6, '0')}.jpg`);
      frames.push({ file, t: (t0 + now()) / 2 });
      writes.push(fs.promises.writeFile(file, shot));
    }
  })();

  const timeline = [];
  const differences = [];
  let cursor = { x: Math.round(viewport.width * 0.62), y: Math.round(viewport.height * 0.58) };
  let error = null;
  await sleepUntil(now, LEAD_IN);
  for (let i = 0; i < steps.length && !error; i++) {
    const step = steps[i] || {};
    const v = voice.steps[i];
    if (reference?.has(i + 1)) {
      const d = textDiff(reference.get(i + 1), await visibleText(page));
      if (d.added.length || d.removed.length) differences.push({ step: i + 1, added: d.added.slice(0, 8), removed: d.removed.slice(0, 8) });
    }
    const start = now();
    process.stderr.write(`${id}: step ${i + 1}/${steps.length} at ${start.toFixed(1)}s\n`);
    const entry = { n: i + 1, start: r3(start), url: page.url() };
    if (v.audio) entry.audio = { file: v.audio, at: r3(start), duration: v.duration };
    try {
      if (step.do) {
        const action = await perform(page, step, v, start, cursor, now);
        entry.action = action;
        if (action.x != null) cursor = { x: action.x, y: action.y };
      }
    } catch (e) {
      error = `Step ${i + 1} (${step.do} "${step.target ?? step.path ?? ''}") failed: ${actionError(e)}`;
    }
    await settle(page);
    const expected = expectList(step);
    if (!error && expected.length) {
      const missing = await missingText(page, expected, 2000);
      if (missing.length) error = `After step ${i + 1} the page should show ${missing.map((m) => `"${m}"`).join(' and ')}, but it doesn't.`;
    }
    await sleepUntil(now, Math.max(start + (v.duration || 0) + GAP, now() + (step.do ? 0.25 : 0)));
    entry.end = r3(now());
    entry.url_after = page.url();
    timeline.push(entry);
  }
  await sleepUntil(now, now() + TAIL);
  capturing = false;
  await capture;
  await Promise.all(writes);
  const duration = r3(now());
  await context.close();
  if (error || !frames.length) {
    if (!args['keep-frames']) fs.rmSync(framesDir, { recursive: true, force: true });
    return error
      ? { id, ok: false, error, differences, hint: 'Run the storyboard for this tour to see what changed. If the page shows different data, check app.reset.' }
      : { id, ok: false, error: 'No frames were captured.' };
  }

  // Encode at a constant 30 fps: each frame lasts until the next one, the first from 0, the last to the end.
  const list = frames.map((f, k) => {
    const from = k === 0 ? 0 : f.t;
    const to = k + 1 < frames.length ? frames[k + 1].t : duration;
    return `file '${path.basename(f.file)}'\nduration ${Math.max(to - from, 0.001).toFixed(4)}`;
  });
  list.push(`file '${path.basename(frames.at(-1).file)}'`);
  fs.writeFileSync(path.join(framesDir, 'frames.txt'), `ffconcat version 1.0\n${list.join('\n')}\n`);
  const video = path.join(outDir, 'recording.mp4');
  const temp = path.join(outDir, `recording.tmp-${process.pid}.mp4`);
  const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(framesDir, 'frames.txt'),
    '-vf', `fps=${FPS}`, '-t', String(duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv444p', '-movflags', '+faststart', temp], { encoding: 'utf8' });
  if (!args['keep-frames']) fs.rmSync(framesDir, { recursive: true, force: true });
  if (enc.status !== 0) {
    fs.rmSync(temp, { force: true });
    return { id, ok: false, error: `ffmpeg couldn't encode the recording: ${(enc.stderr || '').trim().split('\n').slice(-3).join(' ')}` };
  }
  fs.renameSync(temp, video);

  writeJson(path.join(outDir, 'recording.json'), {
    id,
    title: tour.title,
    inputs,
    viewport,
    scale: 2,
    fps: FPS,
    duration,
    start_url: startUrl,
    frames_captured: frames.length,
    differences,
    steps: timeline,
  });
  if (differences.length) notes.push(`The page's text differed from the approved storyboard at step${differences.length > 1 ? 's' : ''} ${differences.map((d) => d.step).join(', ')}; see differences`);
  return { id, ok: true, seconds: duration, frames: frames.length, video: rel(video), notes, differences };
}

// Move the pointer to the step's target and act as the narrator finishes naming it.
async function perform(page, step, v, start, from, now) {
  const at = anchor(step, v);
  if (step.do === 'goto') {
    await sleepUntil(now, start + at);
    const t = now();
    await page.goto(absUrl(cfg.app.url, step.path), { waitUntil: 'domcontentloaded' });
    return { do: 'goto', at: r3(t), path: step.path };
  }
  if (step.do === 'wait') {
    await sleep(Number(step.seconds ?? 1) * 1000);
    return { do: 'wait', at: r3(start) };
  }
  if (step.do === 'press' && step.target == null && !step.locator) {
    await sleepUntil(now, start + at);
    const t = now();
    await page.keyboard.press(step.key);
    return { do: 'press', at: r3(t), key: step.key };
  }
  if (step.do === 'scroll' && step.target == null && !step.locator) {
    await sleepUntil(now, start + at);
    const t = now();
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'smooth' }), Math.round(viewport.height * 0.8));
    await sleep(700);
    return { do: 'scroll', at: r3(t) };
  }

  const found = await resolve(page, step, { waitMs: 5000 });
  if (!found.el) throw new Error(found.reason || 'target not found');
  const el = found.el;
  let box = await el.boundingBox();
  let scrolled = null;
  if (needsScroll(box, viewport)) {
    const t = now();
    const block = box && box.height > viewport.height * 0.8 ? 'start' : 'center';
    await el.evaluate((e, b) => e.scrollIntoView({ behavior: 'smooth', block: b }), block);
    await sleep(700);
    box = await el.boundingBox();
    scrolled = [r3(t), r3(now())];
  }
  if (!box) throw new Error('the target has no position on screen');
  if (step.do === 'show') {
    await sleepUntil(now, start + at);
    return { do: 'show', at: r3(now()), box: roundBox(box), element: found.element, ...(scrolled ? { scrolled } : {}) };
  }
  // Aim at the middle, or near the start of a text field, where the caret goes.
  const x = Math.round(step.do === 'type' ? box.x + Math.min(box.width / 2, 40) : box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const hit = Math.max(start + at, now() + MIN_TRAVEL);
  const travel = Math.abs(x - from.x) + Math.abs(y - from.y) < 4 ? 0 : Math.min(TRAVEL, Math.max(MIN_TRAVEL, hit - now()));
  const t0 = hit - travel;
  await sleepUntil(now, t0);
  // Move the real mouse along the same eased path render.mjs draws, so hover styles show up on time.
  while (travel && now() < hit) {
    const k = ease(Math.min(1, (now() - t0) / travel));
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
    await sleep(16);
  }
  await page.mouse.move(x, y);
  const at_ = now();
  const position = { x: x - box.x, y: y - box.y };
  const record = { do: step.do, at: r3(at_), x, y, box: roundBox(box), from, travel: [r3(t0), r3(hit)], element: found.element };
  if (scrolled) record.scrolled = scrolled;
  switch (step.do) {
    case 'click': await el.click({ position }); break;
    case 'check': await el.check({ position }); break;
    case 'hover': break;
    case 'select': await sleep(150); await el.selectOption(String(step.option)); break;
    case 'type': {
      await el.click({ position });
      if (await el.inputValue().catch(() => '')) await el.fill('');
      const typing = now();
      await el.pressSequentially(String(step.text ?? ''), { delay: TYPE_DELAY * 1000 });
      record.typing = [r3(typing), r3(now())];
      break;
    }
    case 'press': await el.press(step.key); break;
    case 'scroll': break;
  }
  // A menu item or dialog button that disappears once clicked shouldn't keep its ring.
  if (['click', 'check', 'select'].includes(step.do)) record.vanished = !(await el.isVisible().catch(() => false));
  return record;
}

// When, in seconds from the start of the line, the action should land.
function anchor(step, v) {
  const d = v?.duration || 0;
  const timed = (v?.words || []).map((w) => ({ ...w, key: words(w.text)[0] || '' }));
  const label = words(step.target);
  const ends = (seq) => {
    for (let i = 0; seq.length && i + seq.length <= timed.length; i++) {
      if (seq.every((w, k) => timed[i + k].key === w)) return timed[i + seq.length - 1].end;
    }
    return null;
  };
  // 0. The tour names the words to act on.
  if (step.cue) {
    const t = ends(words(step.cue));
    if (t != null) return t;
  }
  // 1. The narrator says the target's label: act as the label ends.
  if (label.length) {
    for (let i = 0; i + label.length <= timed.length; i++) {
      if (label.every((w, k) => timed[i + k].key === w)) return timed[i + label.length - 1].end;
    }
  }
  // 2. The narrator names the action ("tick its box"): act at the end of that phrase.
  const verbs = VERBS[step.do] || [];
  const vi = timed.findIndex((w) => verbs.includes(w.key));
  if (vi >= 0) {
    let j = vi;
    while (j + 1 < timed.length && j - vi < 5 && !CLAUSE_END.has(timed[j + 1].key) && timed[j + 1].start - timed[j].end < 0.06) j++;
    return timed[j].end;
  }
  // 3. A distinctive word from the label.
  const hit = timed.find((w) => w.key.length > 3 && label.includes(w.key));
  if (hit) return hit.end;
  // A pointed-out element is ringed from early in the line; an action lands about halfway through it.
  if (step.do === 'show') return Math.min(0.4, d);
  return d ? Math.min(d * 0.5, 2.5) : 0.8;
}

function ease(k) {
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

async function settle(page) {
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}


async function sleepUntil(now, t) {
  const wait = (t - now()) * 1000;
  if (wait > 0) await sleep(wait);
}

function r3(n) {
  return Math.round(n * 1000) / 1000;
}

function roundBox(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

function rel(p) {
  return path.relative(process.cwd(), p);
}
