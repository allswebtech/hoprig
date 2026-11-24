// Sessions Hoprig did not start: the coding tool's own records (Claude Code's transcripts in its projects folder, and
// each agent's in <session>/subagents/agent-<id>.jsonl) read so that a provider stop of such a session, or of an agent
// in it, makes the same Operator items as one of Hoprig's own. Read only: nothing is written, and nothing but the
// error lines is kept (who stopped, when, the table's name and the tool's line, cleaned and cut by the table).
//
// Incremental, inside the look's time limit: only files changed since the last look, only their new bytes, at most a
// fixed number of files and bytes per look. A line cut at the end is read whole on the next look; a file rewritten from
// the start (smaller than what was read, another file under the same name, or first bytes that are not the ones read,
// also with the same inode, size and time) is read again; a file seen for the first
// time is read from near its end (a stop older than a day is no item). A line longer than LIMITS.line is passed over
// unread: an error line is short, and a whole picture in a line costs nothing.
//
// A session Hoprig started is left out by its id: the hook's record wins. Its run record goes when the process ends (a
// chat's after its idle time), but its transcript stays and is read for a day: so the ids Hoprig ran are kept as long
// (ownConversations), also past a restart of the dashboard, or every such stop would come back as a session Hoprig
// did not start.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, stateDir } from '../paths.mjs';
import { classify } from './table.mjs';

export const LIMITS = Object.freeze({ files: 64, bytes: 2 * 1024 * 1024, perFile: 512 * 1024, tail: 256 * 1024, line: 1024 * 1024, stats: 4000, ms: 300 });
const DAY = 24 * 3600_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_FILE = /^agent-([\w-]{1,80})\.jsonl$/;
const NL = 0x0a;

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join(' ') : '');
const statOf = (f) => {
  try {
    return fs.statSync(f);
  } catch {
    return null;
  }
};

// A file rewritten from the start may keep its name, its inode (written in place, or a freed inode the file system
// gives the new file at once, as ext4 does), its size and, within one tick of a coarse clock, its time. So its first
// bytes are kept as a short digest and compared. HEAD: how many; CLOCK_MS: for this long after a file's time, a write
// may leave that time as it was, so a file that looks the same is looked at again (its first bytes only).
const HEAD = 4096;
const CLOCK_MS = 2000;
const digest = (b) => crypto.createHash('sha1').update(b).digest('base64');
const headOf = (file, size) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(Math.min(size, HEAD));
    return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};
// Whether `start` (a file's first bytes now) begins as the file did when it was read (`k.head`).
const sameStart = (k, start) => !!start && start.length >= k.head.len && digest(start.subarray(0, k.head.len)) === k.head.sum;

const OWN_MAX = 2000;
// How old a kept time may be on disk before it is written again: a session that runs for days stays kept after a
// restart of the dashboard, and the file is still not written on every look.
const OWN_STEP = 3600_000;

/**
 * The conversation ids Hoprig ran in the last day (state/operator/conversations.json: { id: last seen }). `note(ids)`
 * adds those seen now and returns every id kept; the file is written when an id is new, or when the time it holds for
 * an id seen now is OWN_STEP old (else a restart reads the time the id was first seen and drops it a day after that).
 */
export function ownConversations({ file = () => path.join(stateDir(), 'operator', 'conversations.json'), now = Date.now } = {}) {
  let kept = null;
  let disk = new Map(); // the times the file holds: a look sets the time in memory, the file gets it once per step
  const load = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return new Map(Object.entries(j && typeof j === 'object' && !Array.isArray(j) ? j : {}).filter(([id, at]) => ID.test(id) && Number.isFinite(at)));
    } catch {
      return new Map();
    }
  };
  return {
    note(ids) {
      const t = now();
      if (!kept) {
        kept = load();
        disk = new Map(kept);
      }
      let changed = false;
      for (const [id, at] of kept) if (t - at > DAY) { kept.delete(id); changed = true; }
      for (const id of ids) {
        if (!ID.test(String(id))) continue;
        if (!disk.has(id) || t - disk.get(id) >= OWN_STEP) changed = true;
        kept.set(id, t);
      }
      while (kept.size > OWN_MAX) kept.delete(kept.keys().next().value);
      if (changed) {
        try {
          fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
          const tmp = `${file()}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
          fs.renameSync(tmp, file());
          disk = new Map(kept);
        } catch { /* kept in memory: the next look writes it again */ }
      }
      return new Set(kept.keys());
    },
  };
}

/** A reader for one dashboard. `look({ skip })` reads what changed and returns the board's sessions of the tool's own. */
export function transcriptReader({ dir = () => path.join(claudeDir(), 'projects'), limits = LIMITS, now = Date.now } = {}) {
  const files = new Map(); // file → { ino, size, offset, carry: Buffer, skip, mtime }
  const sessions = new Map(); // session id → { id, cwd, stop, agents: Map(id → { id, label, stop }), at }

  const sessionOf = (id) => {
    if (!sessions.has(id)) sessions.set(id, { id, cwd: null, stop: null, agents: new Map(), at: 0 });
    return sessions.get(id);
  };

  function labelOf(file, id) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(file), `agent-${id}.meta.json`), 'utf8'));
      return String(meta.description || meta.agentType || '').slice(0, 80);
    } catch {
      return '';
    }
  }

  // One complete line of a transcript (`agent`: the agent's id when it is an agent's file).
  function line(text, sid, agent, file) {
    if (!text.includes('"type":"assistant"')) return;
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return;
    }
    if (!j || typeof j !== 'object' || j.type !== 'assistant') return;
    const s = sessionOf(sid);
    if (typeof j.cwd === 'string' && !s.cwd) s.cwd = j.cwd;
    const at = Date.parse(j.timestamp) || now();
    s.at = Math.max(s.at, at);
    if (!j.isApiErrorMessage) {
      // A later reply of the session itself: its last stop is over. An agent's stop stays for its day.
      if (!agent) s.stop = null;
      return;
    }
    const c = classify({ error: j.error, status: j.apiErrorStatus, type: j.apiErrorType, stop: j.message?.stop_reason, text: textOf(j.message?.content) });
    if (!c) return;
    const stop = { at: new Date(at).toISOString(), reason: c.reason, text: c.text };
    if (!agent) s.stop = stop;
    else s.agents.set(agent, { id: agent, label: labelOf(file, agent), stop });
  }

  // Reads the new bytes of one file, at most `budget`; returns how many were read.
  function read(file, st, sid, agent, budget, seen) {
    let k = files.get(file);
    const start = headOf(file, st.size);
    if (!start) return 0; // gone meanwhile
    if (k && (st.ino !== k.ino || st.size < k.offset || !sameStart(k, start))) k = null; // rewritten from the start: read again
    if (!k) {
      const from = st.size > limits.tail ? st.size - limits.tail : 0;
      k = { ino: st.ino, size: 0, offset: from, carry: Buffer.alloc(0), skip: from > 0 };
      files.set(file, k);
    }
    k.size = st.size;
    k.mtime = st.mtimeMs;
    k.seen = seen;
    k.head = { len: start.length, sum: digest(start) };
    const n = Math.min(st.size - k.offset, limits.perFile, budget);
    if (n <= 0) return 0;
    const chunk = Buffer.alloc(n);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, chunk, 0, n, k.offset);
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    k.offset += n;
    const buf = k.carry.length ? Buffer.concat([k.carry, chunk]) : chunk;
    const last = buf.lastIndexOf(NL);
    if (last < 0) {
      // No end of a line yet: kept for the next look, or passed over when it is too long to be an error line.
      if (k.skip || buf.length > limits.line) {
        k.skip = true;
        k.carry = Buffer.alloc(0);
      } else k.carry = buf;
      return n;
    }
    let lines = buf.subarray(0, last).toString('utf8').split('\n');
    if (k.skip) {
      lines = lines.slice(1); // the rest of a line read from its middle, or of one too long
      k.skip = false;
    }
    k.carry = Buffer.from(buf.subarray(last + 1));
    if (k.carry.length > limits.line) {
      k.carry = Buffer.alloc(0);
      k.skip = true;
    }
    for (const l of lines) if (l.length <= limits.line) line(l, sid, agent, file);
    return n;
  }

  // The files that may have changed: each session's transcript, and its agents' while the session was active in the
  // last day. At most limits.stats looked at per look; known files that did not change are left alone. A new session is
  // a new name in its project folder: each folder's last listing is kept, and in a folder that changed in the last day
  // the names it did not hold are walked first (with more files than the cap, a walk in name order spent the cap on old
  // files every time and never reached a new session listed late, also inside one big folder). Every other entry, of
  // recent folders and then of the older ones, is walked in turns, each look going on where the last one stopped, so a
  // session that goes on (its file grows, its folder's time does not change) is reached within a few looks.
  let turn = 0; // how many entries of this round of turns the walk has passed
  const listed = new Map(); // project folder → the names of its last listing
  function candidates(t) {
    const out = [];
    let stats = 0;
    let projects;
    try {
      projects = fs.readdirSync(dir(), { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return out;
    }
    const consider = (file, sid, agent) => {
      if (++stats > limits.stats) return false;
      const seen = Date.now(); // before the stat: what it says held at this time
      const st = statOf(file);
      if (!st || !st.isFile()) return true;
      const k = files.get(file);
      // A known file counts while bytes of it are still unread (a look reads a bounded part), or when it changed. One
      // that looks the same while its time is too recent to tell a later write is looked at by its first bytes.
      let changed = k ? k.offset < st.size || st.size !== k.size || st.ino !== k.ino || st.mtimeMs !== k.mtime : t - st.mtimeMs <= DAY;
      if (k && !changed && k.seen - k.mtime < CLOCK_MS) {
        if (sameStart(k, headOf(file, st.size))) k.seen = seen;
        else changed = true;
      }
      if (changed) out.push({ file, st, sid, agent, seen });
      return true;
    };
    // One entry of a project folder: a transcript, or a session's folder with its agents. False: the cap is reached.
    const entry = (pdir, e) => {
      if (e.isFile() && e.name.endsWith('.jsonl') && ID.test(e.name.slice(0, -6))) return consider(path.join(pdir, e.name), e.name.slice(0, -6), null);
      if (!e.isDirectory() || !ID.test(e.name)) return true;
      const sub = path.join(pdir, e.name, 'subagents');
      if (++stats > limits.stats) return false;
      const st = statOf(sub);
      if (!st || t - st.mtimeMs > DAY) return true;
      let agents;
      try {
        agents = fs.readdirSync(sub);
      } catch {
        return true;
      }
      for (const a of agents) {
        const m = AGENT_FILE.exec(a);
        if (m && !consider(path.join(sub, a), e.name, m[1])) return false;
      }
      return true;
    };
    const listOf = (pdir) => {
      try {
        return fs.readdirSync(pdir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
      } catch {
        return [];
      }
    };
    const recent = [];
    const older = [];
    const here = new Set();
    for (const p of projects) {
      const pdir = path.join(dir(), p.name);
      here.add(pdir);
      const st = statOf(pdir);
      if (st && t - st.mtimeMs <= DAY) recent.push({ pdir, at: st.mtimeMs });
      else older.push(pdir);
    }
    for (const pdir of listed.keys()) if (!here.has(pdir)) listed.delete(pdir);
    recent.sort((a, b) => b.at - a.at);
    older.sort();
    // New names first (a folder not listed before is new as a whole), each known once it was walked, so a look the cap
    // stops goes on with the rest of them; the known ones join the round of turns.
    // What the reader saw change in the last day (a transcript, or a session folder whose agents wrote): walked on every
    // look, before the round of turns, so a session that goes on is reached at once and not when the round comes by.
    const hot = new Set();
    for (const [f, k] of files) {
      if (!(t - k.mtime <= DAY)) continue;
      hot.add(f);
      if (path.basename(path.dirname(f)) === 'subagents') hot.add(path.dirname(path.dirname(f)));
    }
    const round = [];
    for (const { pdir } of recent) {
      const list = listOf(pdir);
      const names = new Set(list.map((e) => e.name));
      const known = new Set([...(listed.get(pdir) || [])].filter((n) => names.has(n)));
      listed.set(pdir, known);
      for (const e of list) {
        if (!known.has(e.name)) {
          if (entry(pdir, e)) known.add(e.name);
          else return out;
        } else if (!hot.has(path.join(pdir, e.name))) round.push([pdir, e]);
        else if (!entry(pdir, e)) return out;
      }
    }
    let passed = 0;
    const inTurn = (pdir, e) => {
      if (passed++ < turn) return true;
      if (entry(pdir, e)) return true;
      turn = passed - 1;
      return false;
    };
    for (const [pdir, e] of round) if (!inTurn(pdir, e)) return out;
    for (const pdir of older) {
      const list = listOf(pdir);
      // No name of it is new: the folder did not change in the last day.
      listed.set(pdir, new Set(list.map((e) => e.name)));
      for (const e of list) if (!inTurn(pdir, e)) return out;
    }
    turn = 0; // every entry was reached: the next look starts the round again
    return out;
  }

  function look({ skip = new Set() } = {}) {
    const t = now();
    const started = Date.now();
    let budget = limits.bytes;
    const list = candidates(t).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limits.files);
    for (const c of list) {
      if (budget <= 0 || Date.now() - started > limits.ms) break;
      budget -= read(c.file, c.st, c.sid, c.agent, budget, c.seen);
    }
    // What is a day old is forgotten.
    for (const [id, s] of sessions) if (t - s.at > DAY) sessions.delete(id);
    for (const [f, k] of files) if (t - k.mtime > 2 * DAY) files.delete(f);
    return cards(t, skip);
  }

  function cards(t, skip) {
    const out = [];
    for (const s of sessions.values()) {
      if (skip.has(s.id)) continue;
      const recent = (x) => x && t - (Date.parse(x.at) || 0) <= DAY;
      const stop = recent(s.stop) ? s.stop : null;
      const agents = [...s.agents.values()].filter((a) => recent(a.stop)).slice(-10)
        .map((a) => ({ ...a, limit: a.stop.reason === 'limit' ? { at: a.stop.at, text: a.stop.text.slice(0, 80), resetsAt: null } : null }));
      if (!stop && !agents.length) continue;
      out.push({
        name: s.id.slice(0, 8), outside: true, sessionId: s.id, folder: s.cwd ? path.basename(s.cwd).slice(0, 40) : null, tool: 'claude', provider: null,
        state: 'unknown', asks: [], agents, stop: stop && stop.reason !== 'limit' ? stop : null,
        limit: stop && stop.reason === 'limit' ? { at: stop.at, text: stop.text.slice(0, 80), resetsAt: null } : null,
        canSwitch: false, nextProvider: null,
      });
    }
    return out;
  }

  return { look };
}
