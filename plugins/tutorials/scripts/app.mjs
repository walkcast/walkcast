#!/usr/bin/env node
// Start, stop, reset or check the app the tutorials are made from.
// Usage: node app.mjs start|stop|restart|reset|status [--config tutorials/config.yaml]
//
// start runs config's app.start in app.cwd in the background, with its output in tutorials/.cache/app.log,
// and waits until app.url answers. An app that already answers is left alone. stop only stops an app
// that start started. reset runs app.reset, which puts the demo data back. status says whether the app
// answers, and whether this script started it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { done, fail, loadConfig, parseArgs, resetApp } from './lib/common.mjs';

const args = parseArgs();
const { cfg, root, tutorials } = loadConfig(args.config);
const cache = path.join(tutorials, '.cache');
const pidFile = path.join(cache, 'app.pid');
const logFile = path.join(cache, 'app.log');
const url = cfg.app.url;

const commands = { start, stop, restart, reset, status };
const command = commands[args._[0]];
if (!command) fail(`Usage: node app.mjs ${Object.keys(commands).join('|')}`);
done(await command());

async function answers() {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

// The process start launched, if it's still running.
function ours() {
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.rmSync(pidFile, { force: true });
    return null;
  }
}

async function status() {
  return { ok: true, url, answering: await answers(), started_by_app_mjs: ours() };
}

async function start() {
  if (await answers()) return { ok: true, url, already_running: true, started_by_app_mjs: ours() };
  if (!cfg.app.start) fail(`Nothing answers at ${url}, and config.yaml has no app.start command to start it.`);
  fs.mkdirSync(cache, { recursive: true });
  const log = fs.openSync(logFile, 'w');
  const child = spawn(cfg.app.start, { shell: true, cwd: path.resolve(root, cfg.app.cwd || '.'), detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const deadline = Date.now() + Number(cfg.app.ready_timeout || 60) * 1000;
  while (Date.now() < deadline) {
    if (await answers()) return { ok: true, url, started: true, pid: child.pid, log: path.relative(process.cwd(), logFile) };
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-20).join('\n');
  if (exited === null) stopProcess(child.pid);
  fs.rmSync(pidFile, { force: true });
  fail(exited !== null ? `The app exited (code ${exited}) before answering at ${url}.` : `The app didn't answer at ${url} within ${cfg.app.ready_timeout || 60} seconds.`, { log: tail });
}

async function stop() {
  const pid = ours();
  if (!pid) return { ok: true, stopped: false, note: (await answers()) ? 'The app is running, but app.mjs didn\'t start it, so it was left alone.' : 'The app isn\'t running.' };
  stopProcess(pid);
  for (let i = 0; i < 20 && (await answers()); i++) await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(pidFile, { force: true });
  return { ok: true, stopped: true, pid };
}

async function restart() {
  await stop();
  return start();
}

async function reset() {
  if (!cfg.app.reset) return { ok: true, reset: false, note: 'config.yaml has no app.reset, so nothing was reset.' };
  const error = await resetApp(cfg, root);
  if (error) fail(error);
  return { ok: true, reset: true };
}

// Stop the start command and everything it launched (it runs in its own process group).
function stopProcess(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}
