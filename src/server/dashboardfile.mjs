// <stateDir>/dashboard.json: where the running dashboard really listens ({ pid, proc, host, port, at, state, key,
// version }; proc: its identity, procid.mjs; state, key: below). Written when it starts listening and removed when it stops, so `hoprig pair --json`,
// `hoprig link` and setup find the real port even when the dashboard was started with --port and the config says
// something else.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { binFile, stateDir } from '../paths.mjs';
import { filedProcess, freshAfter, system } from '../procid.mjs';
import { replaceFile } from '../replacefile.mjs';

export const dashboardFile = () => path.join(stateDir(), 'dashboard.json');

/**
 * Which state folder a record belongs to: a hash of the folder's real path. A record copied into another state folder
 * (a restored or copied folder, a test home built from a copy) names a dashboard that is not this folder's.
 */
export function stateKey(dir = stateDir()) {
  let real = path.resolve(dir);
  try {
    real = fs.realpathSync(dir);
  } catch {
    /* not made yet: its path as it is */
  }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
}

// The key a command of this user sends to ask the running dashboard about itself (GET /api/local/facts): only who
// can read this file (mode 0600) knows it. A new one at every start. A start that finds its port held asks the same
// route whether the program there is the recorded dashboard of this state folder (src/server/takeover.mjs).
const KEY = crypto.randomBytes(32).toString('base64url');
export const localKey = () => KEY;

/** This install's version, for the record (a newer start may take over from an older one). */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(binFile()), '..', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
})();
export const ownVersion = () => VERSION;

export function writeDashboardFile({ host, port }) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${dashboardFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, proc: system.self(), host, port, at: Date.now(), state: stateKey(), key: KEY, version: VERSION }) + '\n', { mode: 0o600 });
    replaceFile(tmp, dashboardFile());
  } catch {
    /* only a hint for other commands; the dashboard runs without it */
  }
}

/** Remove the file, but only when it is this process's (another dashboard may have started since). */
export function removeDashboardFile() {
  try {
    const d = JSON.parse(fs.readFileSync(dashboardFile(), 'utf8'));
    if (d.pid === process.pid) fs.unlinkSync(dashboardFile());
  } catch {
    /* nothing to remove */
  }
}

/**
 * { pid, host, port } of the dashboard running now, or null (no file, or its process is gone: a dashboard that died
 * hard leaves the file, and after a restart of the computer its pid may be another program's).
 */
export function runningDashboard() {
  try {
    const d = JSON.parse(fs.readFileSync(dashboardFile(), 'utf8'));
    if (!Number.isInteger(d.pid) || !Number.isInteger(d.port) || typeof d.host !== 'string') return null;
    return filedProcess(dashboardFile(), d, { after: freshAfter() }) !== false ? // a fresh identity (procid.mjs freshAfter)
      { pid: d.pid, host: d.host, port: d.port } : null;
  } catch {
    return null;
  }
}

/** The key of the dashboard running now (runningDashboard's), for GET /api/local/facts; null when none runs. */
export function runningKey() {
  if (!runningDashboard()) return null;
  try {
    const k = JSON.parse(fs.readFileSync(dashboardFile(), 'utf8')).key;
    return typeof k === 'string' ? k : null;
  } catch {
    return null;
  }
}
