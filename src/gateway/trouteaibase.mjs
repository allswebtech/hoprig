// What TRouteAI's management needs to know before it sends any credential: where the gateway keeps its data (its own
// rule, bin/cli/data-dir.mjs of the gateway), whether the program on its port is this user's own, and its command
// token. Nothing here sends anything or writes anything.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../setup/system.mjs';

/**
 * The gateway's data folder by the gateway's own rule: DATA_DIR; else ~/.trouteai when that folder exists; else on
 * Windows %APPDATA%\trouteai; else $XDG_CONFIG_HOME/trouteai; else ~/.trouteai.
 */
export function dataFolder(env = process.env, home = os.homedir(), platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const given = (v) => (typeof v === 'string' && v.trim() ? p.resolve(v.trim()) : null);
  const set = given(env.DATA_DIR);
  if (set) return set;
  const legacy = p.join(home, '.trouteai');
  try {
    if (fs.statSync(legacy).isDirectory()) return legacy;
  } catch {
    // no such folder: the platform's own place
  }
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'trouteai');
  const xdg = given(env.XDG_CONFIG_HOME);
  return xdg ? p.join(xdg, 'trouteai') : legacy;
}

/**
 * The command token in `<folder>/cli-token`, or null when the file is missing, not a plain file, readable by others,
 * another user's, or not a token. Read fresh at every call.
 */
export function commandToken(folder, { platform = process.platform, uid = process.getuid ? process.getuid() : null } = {}) {
  const file = path.join(folder, 'cli-token');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    if (platform !== 'win32' && ((st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid))) return null;
    const text = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** The uids of the sockets that listen on `port` in the text of /proc/net/tcp or tcp6. */
export function listenerUids(text, port) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[3] !== '0A') continue; // 0A: LISTEN
    if (parseInt((f[1].split(':')[1] || ''), 16) !== port) continue;
    out.push(Number(f[7]));
  }
  return out;
}

const readFile = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const anyoneAnswers = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => {
    s.destroy();
    resolve(v);
  };
  s.setTimeout(1500, () => done(true)); // silent but there: not ours to say it is empty
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/**
 * Who listens on `port` of this computer: 'own' (every listener runs as this user), 'none', or 'foreign' (someone
 * else, or an owner that cannot be told). `deps` are for tests.
 */
export async function sameUserListener(port, deps = {}) {
  const platform = deps.platform || process.platform;
  const uid = 'uid' in deps ? deps.uid : process.getuid ? process.getuid() : null;
  const run = deps.run || ((argv) => capture(argv, { timeout: 8000 }));
  const answers = deps.answers || anyoneAnswers;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'foreign';
  try {
    if (platform === 'linux') {
      const read = deps.readNet || readFile;
      const uids = [...listenerUids(read('/proc/net/tcp'), p), ...listenerUids(read('/proc/net/tcp6'), p)];
      if (uids.length) return uid !== null && uids.every((u) => u === uid) ? 'own' : 'foreign';
      return (await answers(p)) ? 'foreign' : 'none';
    }
    if (platform === 'win32') {
      const r = await run(['netstat', '-ano', '-p', 'TCP']);
      const m = (r.stdout || '').split('\n').filter((l) => /LISTENING/i.test(l) && new RegExp(`:${p}\\s`).test(l));
      if (!m.length) return (await answers(p)) ? 'foreign' : 'none';
      const me = String(deps.user || os.userInfo().username).toLowerCase();
      for (const l of m) {
        const pid = l.trim().split(/\s+/).pop();
        const t = await run(['tasklist', '/v', '/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`]);
        const cols = (t.stdout || '').split('","');
        const who = (cols[6] || '').replace(/"/g, '').split('\\').pop().trim().toLowerCase();
        if (!who || who !== me) return 'foreign';
      }
      return 'own';
    }
    // macOS and the rest: lsof shows its own processes only (unless root): nothing shown while something answers is foreign.
    const r = await run(['lsof', '-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-F', 'pu']);
    const us = (r.stdout || '').split('\n').filter((l) => l.startsWith('u')).map((l) => Number(l.slice(1)));
    if (us.length) return uid !== null && us.every((u) => u === uid) ? 'own' : 'foreign';
    return (await answers(p)) ? 'foreign' : 'none';
  } catch {
    return 'foreign';
  }
}
