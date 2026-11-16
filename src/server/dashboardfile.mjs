// <stateDir>/dashboard.json: where the running dashboard really listens ({ pid, proc, host, port, at }; proc: its
// identity, procid.mjs). Written when it starts listening and removed when it stops, so `hoprig pair --json`,
// `hoprig link` and setup find the real port even when the dashboard was started with --port and the config says
// something else.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { filedProcess, system } from '../procid.mjs';

export const dashboardFile = () => path.join(stateDir(), 'dashboard.json');

export function writeDashboardFile({ host, port }) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${dashboardFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, proc: system.self(), host, port, at: Date.now() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, dashboardFile());
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
    return filedProcess(dashboardFile(), d) !== false ? { pid: d.pid, host: d.host, port: d.port } : null;
  } catch {
    return null;
  }
}
