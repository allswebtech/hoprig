// The first start of a version with the one Public link switch (linkswitch.mjs): the older version kept a detached
// Temporary tunnel and a Custom address that could both run. migrate() reads that once; ours() tells whether a process
// number from such a record is still one of our tunnels (only then is it ended or taken as running).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, saveConfig } from '../config.mjs';
import { alive, fixedDir, fixedStateFile, linkRecordFile, quickStateFile, readFixed, readJsonFile, readQuick, restoreFor, writeAtomic } from './cloudflared.mjs';

const writeRecord = (patch) => writeAtomic(linkRecordFile(), JSON.stringify({ ...(readJsonFile(linkRecordFile()) || {}), ...patch }));

/**
 * The command line of `pid` with its words joined by spaces, or null when it cannot be read here. `wait`: false where
 * reading it would wait for another program (macOS: ps), as on the way of a dashboard's request.
 */
function commandLine(pid, wait = true) {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    if (process.platform === 'darwin' && wait) return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    /* gone, or not ours to read */
  }
  return null; // Windows and others: not checked, so never taken for ours
}

/**
 * Is `pid` a cloudflared tunnel of ours? Its command line must say so: after a restart of the computer the number in
 * an old record may belong to another program. Where the command line cannot be read, nothing is ours, so nothing is
 * ended or adopted on a number alone; `unread` is the answer then (null: "cannot tell", for procid.mjs filedProcess).
 * `port`: only a quick tunnel to that local port (the second temporary address's is not the switch's). `wait`: as for
 * commandLine.
 */
export function ours(pid, { unread = false, port, wait = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return false;
  const cmd = commandLine(pid, wait);
  if (cmd === null) return unread;
  const words = ` ${cmd} `;
  if (!/ tunnel /.test(words)) return false;
  return port === undefined ? cmd.includes(fixedDir()) || cmd.includes('--url http://127.0.0.1:') : words.includes(` --url http://127.0.0.1:${port} `);
}

/** ours() as the fact for procid.mjs filedProcess: null where the command line cannot be read (or not without waiting). */
export const tunnelFact = (pid, { port, wait = true } = {}) => ours(pid, { unread: null, port, wait });

/**
 * The first start of a version with this switch: the older one kept a detached Temporary tunnel and a Custom
 * address that could both run. Read once (only while publicLink is absent): Custom set up and running wins, else a
 * Temporary one that runs, else off. Their settings are put back, the old tunnel ends, and the switch starts what
 * was on again under its supervisor (a Temporary address is then new).
 */
export function migrate() {
  if (loadConfig().publicLink) return null;
  const fixed = readFixed();
  const quick = readQuick();
  if (!(fixed && fixed.mode) && !quick) return null;
  // The old tunnel counts as running only when its record says so AND that number is provably a tunnel of ours.
  const quickOn = !!(quick && !quick.restored && quick.url && ours(quick.pid));
  const fixedOn = !!(fixed && fixed.mode && fixed.enabled);
  // Each record holds the owner's own trustProxy (the second link took it from the first), and its own origin.
  for (const r of [quick && !quick.restored && quick.restore, fixed && fixed.enabled && !fixed.restored && fixed.restore]) {
    if (r) saveConfig(restoreFor(loadConfig().server, r));
  }
  if (quickOn) try { process.kill(quick.pid, 'SIGTERM'); } catch { /* gone */ }
  fs.rmSync(quickStateFile(), { force: true });
  if (fixed) {
    const { enabled, restore, restored, pid, openedBy, ...keep } = fixed;
    writeAtomic(fixedStateFile(), JSON.stringify(keep));
  }
  const choice = fixedOn ? { on: true, kind: 'custom' } : quickOn ? { on: true, kind: 'temporary' } : { on: false, kind: fixed && fixed.mode ? 'custom' : 'temporary' };
  saveConfig({ publicLink: choice });
  const opener = fixedOn ? fixed.openedBy : quickOn ? quick.openedBy : null;
  // A Custom link that ran before keeps running until the password is judged (cannotRun); a Temporary one gets a new
  // address anyway, so it is a new exposure and waits for a strong password like any turn-on.
  writeRecord({ openedBy: opener || null, migratedCustom: fixedOn });
  return choice;
}
