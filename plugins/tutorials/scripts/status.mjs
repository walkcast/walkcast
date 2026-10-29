#!/usr/bin/env node
// Where the tutorials for this app stand, and the next thing to do. /tutorials:start runs this.
// Usage: node status.mjs [--config tutorials/config.yaml]
//
// Reads tutorials/ without changing anything. For each plan item: whether its tour exists, its storyboard
// is current and approved, its video is current, and its SOP exists. Also the look settings, whether the
// bundle is current, and how many commits the app has had since the storyboards were made. `next` names
// the stage to run, the tutorial ids it's for, why, and whether it's waiting for the user.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { done, musicOf, parseArgs, projectDir, readYaml } from './lib/common.mjs';
import { videoProblem } from './lib/produce.mjs';
import { approvalProblem, tourHash } from './lib/tour.mjs';

const args = parseArgs();
const cfgFile = path.resolve(args.config || path.join(projectDir(), 'tutorials', 'config.yaml'));
const tutorials = path.dirname(cfgFile);
const root = path.dirname(tutorials);
const exists = (f) => fs.existsSync(path.join(tutorials, f));

if (!fs.existsSync(cfgFile)) finish({ next: next('discover', "There's no tutorials/config.yaml yet, so this is a fresh start.") });
const cfg = readYaml(cfgFile);
let appUp = false;
try { await fetch(cfg.app?.url, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); appUp = true; } catch {}
const music = musicOf(cfg);
const look = {
  brand: Boolean(cfg.brand?.color),
  display_url: cfg.app?.display_url || null,
  voice: cfg.voice?.voice || null,
  music: cfg.music === undefined ? 'not chosen' : music ? music.file : 'none',
  reset: Boolean(cfg.app?.reset),
};
// Settings worth offering once, when the stage that uses them comes up or when everything is done.
const suggestions = [];
if (!look.brand) suggestions.push("Brand colors aren't set, so the videos use a default blue. look.mjs reads them from the app.");
if (!look.display_url && /localhost|127\.0\.0\.1/.test(cfg.app?.url || '')) suggestions.push("The videos' address bar shows localhost. Set app.display_url to the app's public address.");
if (!look.voice) suggestions.push('The narrator is the default voice. voice.mjs --samples plays a few to choose from.');
if (look.music === 'not chosen') suggestions.push('No music is chosen. music.mjs search finds free tracks; set music: none to keep it quiet.');
const base = { app: { url: cfg.app?.url || null, running: appUp }, look, suggestions };

if (!exists('features.yaml')) finish({ ...base, next: next('discover', 'The app has a config, but its features haven\'t been mapped yet.') });
if (!exists('plan.yaml')) finish({ ...base, next: next('plan', 'The features are mapped; next is proposing the videos and SOPs.') });
const plan = readYaml(path.join(tutorials, 'plan.yaml'));
if (plan.status !== 'approved') finish({ ...base, plan: plan.status || 'proposed', next: next('plan', 'The plan is waiting for your approval (tutorials/plan.md).', [], true) });

const items = (plan.items || []).map((it) => {
  const kind = it.kind || 'video';
  const r = { id: it.id, kind, tour: false, storyboard: 'none', approved: false };
  const tourFile = path.join(tutorials, it.id, 'tour.yaml');
  if (!fs.existsSync(tourFile)) return r;
  const tour = readYaml(tourFile);
  r.tour = true;
  const sbFile = path.join(tutorials, it.id, 'storyboard', 'steps.json');
  if (fs.existsSync(sbFile)) {
    const sb = JSON.parse(fs.readFileSync(sbFile, 'utf8'));
    r.storyboard = !sb.ok ? 'failed' : sb.tour_hash === tourHash(tour) ? 'current' : 'out of date';
    r.storyboard_at = sb.ran_at;
  }
  r.approved = !approvalProblem(tour);
  if (kind !== 'sop') r.video = videoProblem({ cfg, plan, tutorials, id: it.id }) || 'current';
  if (kind !== 'video') r.sop = fs.existsSync(path.join(tutorials, it.id, 'sop.md'));
  return r;
});
const summary = {
  ...base,
  plan: 'approved',
  items,
  bundle: bundleState(items),
  app_commits_since_storyboard: commitsSince(items.map((i) => i.storyboard_at).filter(Boolean).sort()[0]),
};

const missingTours = items.filter((i) => !i.tour).map((i) => i.id);
const toStoryboard = items.filter((i) => i.tour && (i.storyboard !== 'current' || !i.approved));
const unreviewed = toStoryboard.filter((i) => i.storyboard === 'current' && !i.approved).map((i) => i.id);
const toProduce = items.filter((i) => i.video && i.video !== 'current');
if (missingTours.length) finish({ ...summary, next: next('plan', 'The plan is approved, but some items have no tour.yaml yet.', missingTours) });
if (toStoryboard.length) {
  const waiting = unreviewed.length === toStoryboard.length;
  finish({ ...summary, next: next('storyboard', waiting ? 'The storyboards are ready and waiting for your approval.' : 'Some tours need a storyboard, or changed since theirs was approved.', toStoryboard.map((i) => i.id), waiting) });
}
if (toProduce.length) finish({ ...summary, next: next('produce', `${toProduce.length} video${toProduce.length > 1 ? 's aren\'t' : ' isn\'t'} made yet, or ${toProduce.length > 1 ? 'are' : 'is'} out of date.`, toProduce.map((i) => i.id)) });
if (summary.bundle !== 'current') finish({ ...summary, next: next('bundle', summary.bundle === 'none' ? 'Everything is made; next is gathering it into one folder to share.' : 'Something changed since the last bundle.') });
const commits = summary.app_commits_since_storyboard;
finish({ ...summary, next: commits
  ? next('storyboard', `Everything is done, but the app has had ${commits} commit${commits > 1 ? 's' : ''} since the storyboards were made. Running them again shows whether any tutorial no longer matches the app.`)
  : next(null, 'Everything is done and up to date.') });

function next(stage, why, ids = [], waiting = false) {
  return { stage, command: stage ? `/tutorials:${stage}${ids.length ? ` ${ids.join(' ')}` : ''}` : null, ids, why, waiting_for_user: waiting };
}

function finish(result) {
  done({ ok: true, ...result });
}

// The bundle is current when nothing it's made from changed after it was built.
function bundleState(list) {
  const manifest = path.join(tutorials, 'dist', 'tutorials.json');
  if (!fs.existsSync(manifest)) return 'none';
  const built = fs.statSync(manifest).mtimeMs;
  const inputs = [cfgFile, path.join(tutorials, 'plan.yaml')];
  for (const i of list) {
    inputs.push(path.join(tutorials, i.id, 'produce', 'video.mp4'), path.join(tutorials, i.id, 'sop.md'), path.join(tutorials, i.id, 'storyboard', 'steps.json'));
  }
  return inputs.some((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > built) ? 'out of date' : 'current';
}

// Commits to the app (outside tutorials/) since a date, or null when it isn't a git repository.
function commitsSince(iso) {
  if (!iso) return null;
  const r = spawnSync('git', ['log', `--since=${iso}`, '--oneline', '--', '.', ':(exclude)tutorials'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean).length : null;
}
