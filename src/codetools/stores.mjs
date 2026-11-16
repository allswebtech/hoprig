// The conversations of a folder, from each coding tool's own store. A conversation stays with the tool it was
// started in: the stores have different formats, and a tool can only resume its own.
//
//   Claude Code  <claudeDir>/projects/<slug>/<id>.jsonl (src/sessions.mjs)
//   Codex        $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, whose first line ("session_meta") names
//                the folder; titles in $CODEX_HOME/session_index.jsonl (thread_name). A conversation nobody typed
//                into has no file: Codex cannot resume it either.
//   OpenCode     its database, read through its server (GET /api/session for one folder): Node 20 has no SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { sessionTitle, sessionsIn } from '../sessions.mjs';
import { opencodeClient } from './clients.mjs';
import { codex } from './codex.mjs';
import { ensureServer } from './servers.mjs';

const CODEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPENCODE_ID_RE = /^ses_[A-Za-z0-9]{8,64}$/;
/** A conversation id of `tool`, as its store spells it. */
export const isToolSessionId = (tool, s) => typeof s === 'string' && (tool === 'opencode' ? OPENCODE_ID_RE : CODEX_ID_RE).test(s);

const MAX_FILES = 3000; // newest first; older ones are not offered (the page shows 30)
const HEAD_BYTES = 64 * 1024;

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const sameDir = (a, b) => a === b || real(a) === real(b);

async function readHead(file, n = HEAD_BYTES) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

const entries = (dir) => {
  try {
    return fs.readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
};

// Read once per file and mtime: the page lists them again and again. The reads are asynchronous: a first list of a
// computer with thousands of conversations reads their heads, and the dashboard keeps serving meanwhile.
const metaCache = new Map();

/** { id, cwd, title } from the head of a Codex rollout file, or null. */
export async function codexMeta(file) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return null;
  }
  const key = `${file}|${st.mtimeMs}`;
  if (metaCache.has(key)) return metaCache.get(key);
  let out = null;
  try {
    const head = await readHead(file);
    const first = head.split('\n')[0];
    const cwd = (/"cwd":"((?:[^"\\]|\\.)*)"/.exec(first) || [])[1];
    const id = (/"id":"([0-9a-f-]{36})"/.exec(first) || [])[1];
    if (cwd && id) {
      let title = '';
      for (const line of head.split('\n').slice(1)) {
        if (!line.includes('"role":"user"')) continue;
        try {
          const m = JSON.parse(line);
          const c = m.payload && Array.isArray(m.payload.content) ? m.payload.content : [];
          const t = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join(' ').trim();
          if (t && !t.startsWith('<')) {
            title = t;
            break;
          }
        } catch {
          /* the chunk's last line may be cut */
        }
      }
      out = { id, cwd: JSON.parse(`"${cwd}"`), title, at: st.mtimeMs, file };
    }
  } catch {
    out = null;
  }
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(key, out);
  return out;
}

/** Codex's names for its conversations (it writes one line per rename, the last one counts). */
function codexNames(home) {
  const names = new Map();
  let text = '';
  try {
    const file = path.join(home, 'session_index.jsonl');
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const n = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m && typeof m.id === 'string' && typeof m.thread_name === 'string') names.set(m.id, m.thread_name);
    } catch {
      /* cut or broken line */
    }
  }
  return names;
}

const clip = (s, max = 80) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

/** Codex's rollout files, newest day first; `visit(file, name)` returns true to stop. */
function eachRollout(home, visit) {
  const root = path.join(home, 'sessions');
  let seen = 0;
  for (const y of entries(root)) {
    for (const m of entries(path.join(root, y))) {
      for (const d of entries(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        for (const f of entries(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          if (++seen > MAX_FILES || visit(path.join(dir, f), f)) return;
        }
      }
    }
  }
}

/** Whether Codex has conversation `id` on disk (a thread nobody typed into has none, and cannot be resumed). */
export function codexHas(id, { home = codex.home() } = {}) {
  if (!isToolSessionId('codex', id)) return false;
  let found = false;
  eachRollout(home, (file, name) => (found = name.endsWith(`-${id}.jsonl`)));
  return found;
}

/** Codex conversations of `cwd`, newest first: [{ id, at, title }]. */
export async function codexSessions(cwd, { home = codex.home() } = {}) {
  const files = [];
  eachRollout(home, (file) => (files.push(file), false));
  const out = [];
  for (const file of files) {
    const meta = await codexMeta(file);
    if (meta && sameDir(meta.cwd, cwd)) out.push(meta);
  }
  const names = out.length ? codexNames(home) : new Map();
  return out
    .sort((a, b) => b.at - a.at)
    .map((s) => ({ id: s.id, at: Math.round(s.at), title: clip(names.get(s.id) || s.title) }));
}

/** OpenCode conversations of `cwd`, newest first, through its server (started when it does not run). */
export async function opencodeSessions(cwd, { ensure = ensureServer, fetchImpl } = {}) {
  const r = await ensure('opencode');
  if (!r.ok) throw Object.assign(new Error(r.why), { status: 409 });
  const oc = opencodeClient({ ...r.server, fetchImpl });
  const j = await oc.req('GET', `/api/session?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`);
  const list = Array.isArray(j && j.data) ? j.data : [];
  return list
    .filter((s) => s && isToolSessionId('opencode', s.id) && !s.parentID)
    .map((s) => ({ id: s.id, at: Number(s.time && (s.time.updated || s.time.created)) || 0, title: clip(s.title || '') }))
    .sort((a, b) => b.at - a.at);
}

/** The conversations of `cwd` in `tool`'s store, newest first: [{ id, at, title }]. */
export async function toolSessions(tool, cwd, opts = {}) {
  if (tool === 'codex') return codexSessions(cwd, opts);
  if (tool === 'opencode') return opencodeSessions(cwd, opts);
  return sessionsIn(cwd).map((s) => ({ id: s.id, at: s.mtimeMs, title: sessionTitle(s.file) }));
}
