#!/usr/bin/env node
// Validate the files the skills write. Usage:
//   node check.mjs features [tutorials/features.yaml]
//   node check.mjs plan     [tutorials/plan.yaml]
//   node check.mjs tours    [<tutorial-id> ...]   (default: every tutorials/<id>/tour.yaml)
// Prints errors (must fix) and warnings (worth a look). Exits 1 when there are errors.
import fs from 'node:fs';
import path from 'node:path';
import { done, fail, parseArgs, projectDir, readYaml } from './lib/common.mjs';
import { ACTIONS, approvalProblem, changesData, expectList, words } from './lib/tour.mjs';

const args = parseArgs();
const kind = args._[0];
const tutorials = path.join(projectDir(), 'tutorials');
const errors = [];
const warnings = [];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function need(obj, field, where) {
  const v = obj?.[field];
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) errors.push(`${where}: missing ${field}`);
  return v;
}
function oneOf(value, allowed, where, field) {
  if (value !== undefined && !allowed.includes(value)) errors.push(`${where}: ${field} must be one of ${allowed.join(', ')} (got "${value}")`);
}
function uniqueIds(list, where) {
  const seen = new Set();
  for (const item of list) {
    if (!item?.id) continue;
    if (!KEBAB.test(item.id)) errors.push(`${where} "${item.id}": id must be lowercase-with-dashes`);
    if (seen.has(item.id)) errors.push(`${where} "${item.id}": duplicate id`);
    seen.add(item.id);
  }
  return seen;
}

function checkFeatures(file) {
  const doc = readYaml(file);
  need(doc, 'app', 'features.yaml');
  const features = need(doc, 'features', 'features.yaml') || [];
  const areas = new Set((doc.areas || []).map((a) => a.id));
  uniqueIds(features, 'feature');
  for (const f of features) {
    const w = `feature "${f.id || f.name || '?'}"`;
    ['id', 'name', 'summary', 'area', 'roles', 'entry', 'importance', 'status'].forEach((k) => need(f, k, w));
    oneOf(f.importance, ['core', 'common', 'advanced', 'admin'], w, 'importance');
    oneOf(f.status, ['live', 'flagged', 'unfinished', 'internal'], w, 'status');
    oneOf(f.reach, ['link', 'interaction'], w, 'reach');
    if (areas.size && f.area && !areas.has(f.area)) errors.push(`${w}: area "${f.area}" is not listed under areas`);
    const ev = f.evidence || {};
    if (!(ev.code?.length || ev.screens?.length)) warnings.push(`${w}: no evidence (code paths or screenshots)`);
    for (const s of ev.screens || []) if (!fs.existsSync(path.join(path.dirname(file), s))) warnings.push(`${w}: screenshot not found: ${s}`);
  }
  if (!features.some((f) => f.importance === 'core')) warnings.push('no feature is marked core');
  return { features: features.length, by_importance: count(features, 'importance'), by_area: count(features, 'area') };
}

function checkPlan(file) {
  const doc = readYaml(file);
  oneOf(need(doc, 'status', 'plan.yaml'), ['proposed', 'approved'], 'plan.yaml', 'status');
  const items = need(doc, 'items', 'plan.yaml') || [];
  uniqueIds(items, 'item');
  let featureIds = null;
  let notLive = new Map();
  const featuresFile = path.join(path.dirname(file), 'features.yaml');
  if (fs.existsSync(featuresFile)) {
    const features = readYaml(featuresFile).features || [];
    featureIds = new Set(features.map((f) => f.id));
    notLive = new Map(features.filter((f) => f.status && f.status !== 'live').map((f) => [f.id, f.status]));
  }
  let seconds = 0;
  for (const it of items) {
    const w = `item "${it.id || it.title || '?'}"`;
    ['id', 'kind', 'title', 'audience', 'goal', 'features', 'steps'].forEach((k) => need(it, k, w));
    oneOf(it.kind, ['video', 'sop', 'both'], w, 'kind');
    if (it.kind !== 'sop') {
      if (typeof it.duration_sec !== 'number') errors.push(`${w}: videos need duration_sec as a number`);
      else { seconds += it.duration_sec; if (it.duration_sec > 240) warnings.push(`${w}: ${it.duration_sec}s is long; consider splitting`); }
    }
    if (Array.isArray(it.steps) && it.steps.length < 2) errors.push(`${w}: needs at least 2 steps`);
    if (Array.isArray(it.steps) && it.steps.length > 14) warnings.push(`${w}: ${it.steps.length} steps; consider splitting`);
    for (const fid of it.features || []) {
      if (featureIds && !featureIds.has(fid)) errors.push(`${w}: unknown feature "${fid}"`);
      if (notLive.has(fid)) warnings.push(`${w}: feature "${fid}" is ${notLive.get(fid)}; leave it out unless the user asked for it`);
    }
  }
  if (featureIds) {
    const covered = new Set(items.flatMap((i) => i.features || []));
    const core = (readYaml(featuresFile).features || []).filter((f) => f.importance === 'core' && f.status === 'live');
    for (const f of core) if (!covered.has(f.id)) warnings.push(`core feature "${f.id}" is not covered by any item`);
  }
  return { items: items.length, by_kind: count(items, 'kind'), total_video_seconds: seconds };
}


function checkLocator(loc, where) {
  if (!loc || typeof loc !== 'object' || Array.isArray(loc)) return errors.push(`${where}: locator must be a map`);
  if (['role', 'label', 'text', 'css'].filter((k) => loc[k] !== undefined).length !== 1) errors.push(`${where}: locator needs exactly one of role, label, text or css`);
  if (loc.exact !== undefined && typeof loc.exact !== 'boolean') errors.push(`${where}: locator exact must be true or false`);
  if (loc.nth !== undefined && !(Number.isInteger(loc.nth) && loc.nth >= 0)) errors.push(`${where}: locator nth must be a whole number from 0`);
  if (loc.within !== undefined) checkLocator(loc.within, `${where} (within)`);
}

function checkTours(ids) {
  const cfgFile = path.join(tutorials, 'config.yaml');
  const cfg = fs.existsSync(cfgFile) ? readYaml(cfgFile) : {};
  const roles = new Set((cfg.roles || []).map((r) => r.id));
  const planFile = path.join(tutorials, 'plan.yaml');
  const kinds = new Map(fs.existsSync(planFile) ? (readYaml(planFile).items || []).map((it) => [it.id, it.kind]) : []);
  if (!ids.length && fs.existsSync(tutorials)) {
    ids = fs.readdirSync(tutorials, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(tutorials, d.name, 'tour.yaml'))).map((d) => d.name);
  }
  if (!ids.length) fail('No tour.yaml files under tutorials/. /tutorials:plan creates them when the plan is approved.');
  let steps = 0;
  for (const id of ids) {
    const w = `tour "${id}"`;
    const file = path.join(tutorials, id, 'tour.yaml');
    if (!fs.existsSync(file)) { errors.push(`${w}: no ${path.relative(process.cwd(), file)}`); continue; }
    const tour = readYaml(file);
    ['id', 'title', 'start', 'steps'].forEach((k) => need(tour, k, w));
    if (tour.id && tour.id !== id) errors.push(`${w}: id "${tour.id}" doesn't match its folder`);
    if (tour.role && roles.size && !roles.has(tour.role)) errors.push(`${w}: role "${tour.role}" isn't in config.yaml`);
    const list = Array.isArray(tour.steps) ? tour.steps : [];
    steps += list.length;
    list.forEach((s, i) => {
      const sw = `${w} step ${i + 1}`;
      if (!s || typeof s !== 'object') return errors.push(`${sw}: must be a map`);
      if (!s.do && !s.say) errors.push(`${sw}: needs do or say`);
      const spec = ACTIONS[s.do];
      if (s.do !== undefined) {
        if (!spec) errors.push(`${sw}: do must be one of ${Object.keys(ACTIONS).join(', ')} (got "${s.do}")`);
        else if (spec.field && s[spec.field] === undefined) errors.push(`${sw}: ${s.do} needs ${spec.field}`);
        if (spec?.target === 'required' && s.target === undefined && s.locator === undefined) errors.push(`${sw}: ${s.do} needs a target`);
      }
      if (s.locator !== undefined) checkLocator(s.locator, sw);
      const count = String(s.say || '').split(/\s+/).filter(Boolean).length;
      if (count >= 25) warnings.push(`${sw}: say is ${count} words; keep it under 25`);
      if (s.cue !== undefined) {
        const cue = words(s.cue);
        const said = words(s.say).join(' ');
        if (!s.do || spec?.target === 'none') warnings.push(`${sw}: cue only matters on a step that acts on an element`);
        if (!cue.length || !` ${said} `.includes(` ${cue.join(' ')} `)) errors.push(`${sw}: cue "${s.cue}" must be words from its say line`);
      }
      if (s.expect_text !== undefined && !(typeof s.expect_text === 'string' || (Array.isArray(s.expect_text) && s.expect_text.every((t) => typeof t === 'string')))) {
        errors.push(`${sw}: expect_text must be a string or a list of strings`);
      }
      if (s.expect && !expectList(s).length && s.do === 'click') warnings.push(`${sw}: has expect but no expect_text, so nothing checks it automatically`);
    });
    if (tour.approved_hash) {
      const problem = approvalProblem(tour);
      if (problem) warnings.push(`${w}: ${problem}; storyboard it again and ask the user to approve`);
    }
    if (!cfg.app?.reset && list.some(changesData)) warnings.push(`${w}: changes the app's data, but config.yaml has no app.reset to put it back between runs`);
    // script.md has one numbered line per step, spoken during that step. SOP-only items don't need one.
    const script = path.join(tutorials, id, 'script.md');
    if (!fs.existsSync(script) && kinds.get(id) && kinds.get(id) !== 'sop') warnings.push(`${w}: no script.md`);
    if (fs.existsSync(script)) {
      const lines = fs.readFileSync(script, 'utf8').split('\n').filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s+/, '').trim());
      if (lines.length !== list.length) warnings.push(`${w}: script.md has ${lines.length} numbered lines for ${list.length} steps`);
      else list.forEach((s, i) => { if (s?.say && lines[i] !== String(s.say).trim()) warnings.push(`${w} step ${i + 1}: say differs from script.md line ${i + 1}`); });
    }
    // sop.md screenshots name tour steps: ![...](step:N) or step:N:after.
    const sop = path.join(tutorials, id, 'sop.md');
    if (fs.existsSync(sop)) {
      for (const [, n, after] of fs.readFileSync(sop, 'utf8').matchAll(/\]\(step:(\d+)(?::(after))?\)/g)) {
        const s = list[Number(n) - 1];
        if (!s) errors.push(`${w}: sop.md shows step ${n}, but the tour has ${list.length} steps`);
        else if (after && (!s.do || s.do === 'show')) errors.push(`${w}: sop.md shows step ${n}:after, but step ${n} doesn't act on the page, so it has no after screenshot`);
      }
    }
  }
  return { tours: ids.length, steps };
}

function count(list, key) {
  return list.reduce((acc, x) => { acc[x[key] ?? 'unset'] = (acc[x[key] ?? 'unset'] || 0) + 1; return acc; }, {});
}

if (kind === 'tours') {
  let summary;
  try {
    summary = checkTours(args._.slice(1));
  } catch (e) {
    fail(`Could not read a tour: ${e.message}`);
  }
  done({ ok: errors.length === 0, summary, errors, warnings }, errors.length ? 1 : 0);
}
const defaults = { features: 'features.yaml', plan: 'plan.yaml' };
if (!defaults[kind]) fail('Usage: node check.mjs features|plan [file], or node check.mjs tours [id ...]');
const file = path.resolve(args._[1] || path.join(tutorials, defaults[kind]));
if (!fs.existsSync(file)) fail(`Not found: ${file}`);
let summary;
try {
  summary = kind === 'features' ? checkFeatures(file) : checkPlan(file);
} catch (e) {
  fail(`Could not read ${file}: ${e.message}`);
}
done({ ok: errors.length === 0, file, summary, errors, warnings }, errors.length ? 1 : 0);
