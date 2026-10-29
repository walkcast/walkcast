// What a finished video is made from, so record, render and bundle agree on when one is out of date.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readYaml } from './common.mjs';
import { approvalProblem, tourHash } from './tour.mjs';

export const RENDER_VERSION = 4; // bump when the composition changes, so finished videos are rendered again

export function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// record.mjs stores this: the tour and the narration it recorded.
export function recordingInputs(tour, voiceRaw) {
  return sha(tourHash(tour) + voiceRaw);
}

// render.mjs stores this: everything the finished video is made from.
export function renderInputs({ cfg, plan, id, recRaw, voiceRaw }) {
  return sha(JSON.stringify([RENDER_VERSION, recRaw, voiceRaw, cfg.app?.name, cfg.app?.display_url, cfg.brand, cfg.video, cfg.music, nextTitle(plan, id)]));
}

// The title of the next video in the plan, for the closing card.
export function nextTitle(plan, id) {
  const videos = (plan?.items || []).filter((it) => it.kind !== 'sop');
  const pos = videos.findIndex((it) => it.id === id);
  return pos >= 0 ? videos[pos + 1]?.title || null : null;
}

// Why a tour's video doesn't match the tour as it stands, or null when it does.
export function videoProblem({ cfg, plan, tutorials, id }) {
  const dir = path.join(tutorials, id);
  const prod = path.join(dir, 'produce');
  if (!fs.existsSync(path.join(dir, 'tour.yaml'))) return 'it has no tour.yaml';
  const tour = readYaml(path.join(dir, 'tour.yaml'));
  const approval = approvalProblem(tour);
  if (approval) return approval;
  const [voice, rec, info, video] = ['voice.json', 'recording.json', 'video.json', 'video.mp4'].map((f) => path.join(prod, f));
  if (![voice, rec, info, video].every((f) => fs.existsSync(f))) return "it hasn't been produced yet";
  const voiceRaw = fs.readFileSync(voice, 'utf8');
  const recRaw = fs.readFileSync(rec, 'utf8');
  if (JSON.parse(recRaw).inputs !== recordingInputs(tour, voiceRaw)) return 'it was recorded before the tour or its narration last changed';
  if (JSON.parse(fs.readFileSync(info, 'utf8')).inputs !== renderInputs({ cfg, plan, id, recRaw, voiceRaw })) return 'it was rendered before its recording or the video settings last changed';
  return null;
}

// The address shown for a page: config's app.display_url replaces the local address, so nothing shows localhost.
export function displayUrl(cfg, url) {
  const shown = cfg.app?.display_url ? new URL(cfg.app.display_url) : null;
  const x = new URL(url);
  const host = shown ? shown.host : x.host;
  const base = shown ? shown.pathname.replace(/\/$/, '') : '';
  const p = `${base}${x.pathname}`;
  return `${host}${p === '/' ? '' : p}${x.search}`;
}
