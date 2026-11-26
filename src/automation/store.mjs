// Where the automations keep what they remember between ticks and across restarts of the service:
// one small JSON file per automation in <stateDir>/automation/ (queues, last run of each schedule, the restore
// list, retry counters...), and one activity log, <stateDir>/automation.log, that the page shows.
//
// Every write goes to a temporary file first and is then renamed over the old one, so a crash or a full disk
// never leaves half a file behind. Files are mode 600 and the folder 700: queued messages can hold private text.
// Reads are cached in memory, so a tick that reads the same file several times costs one disk read.
import fs from 'node:fs';
import path from 'node:path';
import { replaceFile } from '../replacefile.mjs';

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Write `data` as JSON to `file` without ever leaving a partial file. */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
    replaceFile(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * A store of named JSON documents in `dir`. `read(name, fallback)` never throws: a missing or broken file gives
 * the fallback (a broken file is kept aside as <name>.json.broken, so nothing is lost silently).
 */
export function createStore(dir) {
  const cache = new Map();
  const fileOf = (name) => {
    if (!NAME_RE.test(name)) throw new Error(`bad store name "${name}"`);
    return path.join(dir, `${name}.json`);
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  function read(name, fallback) {
    if (cache.has(name)) return clone(cache.get(name));
    const file = fileOf(name);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(file, `${file}.broken`); } catch { /* leave it */ }
      }
    }
    cache.set(name, clone(value));
    return clone(value);
  }

  function write(name, value) {
    // Every tick saves what each automation remembers; most of the time nothing changed, and then the disk is
    // left alone.
    if (cache.has(name) && JSON.stringify(cache.get(name)) === JSON.stringify(value)) return;
    writeAtomic(fileOf(name), value);
    cache.set(name, clone(value));
  }

  /** Read, change with `fn` (returns the new value), write. Synchronous, so nothing can slip in between. */
  function update(name, fallback, fn) {
    const next = fn(read(name, fallback));
    write(name, next);
    return clone(next);
  }

  return { dir, read, write, update };
}

// The activity log: one JSON object per line. It is cut back to its newest half when it grows past LOG_MAX, so it
// never fills the disk.
export const LOG_MAX = 512 * 1024;

export function createActivityLog(file, { now = Date.now, max = LOG_MAX } = {}) {
  function add({ automation, session = '', did, outcome = 'ok' }) {
    const entry = { time: new Date(now()).toISOString(), automation, session: session || '', did: String(did).slice(0, 300), outcome: String(outcome).slice(0, 300) };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      if (fs.statSync(file).size > max) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeLines(file, lines.slice(Math.floor(lines.length / 2)));
      }
    } catch {
      /* the log is a convenience; an automation never fails because of it */
    }
    return entry;
  }

  /** The newest `limit` entries, newest first. */
  function recent(limit = 100) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* a cut line */
      }
    }
    return out;
  }

  return { file, add, recent };
}

function writeLines(file, lines) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  replaceFile(tmp, file);
}
