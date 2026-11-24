// What a coding session's own files say of its progress, for pulse.mjs: its workflows (Claude Code writes one record
// per workflow, <claudeDir>/projects/<slug>/<conversation>/workflows/<task>.json: its name, status, phases, agents,
// start, duration and tokens) and the tokens its transcript reports (<conversation>.jsonl, each assistant message's
// usage). Only files are read, never a program started. A transcript is read on from where the last look stopped, so
// a long one costs its new lines only.
//
// A look never holds the server's one thread for long: the records of a folder are taken newest first (by the time
// the file was last written), a record written before the earliest time asked for is passed over before it is read,
// at most FILES_MAX are parsed, what was parsed is kept (CACHE_MAX, the oldest left out first, never all at once),
// and the thread is given back (a cut) after every PARSE_SLICE parses, OPS_SLICE file operations or SLICE_MS.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from '../sessions.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const FILE_RE = /^[A-Za-z0-9_-]{1,100}\.json$/;
const FILES_MAX = 300; // workflow records parsed for one folder, newest first (the basis of an estimate, what ended)
const CACHE_MAX = 20_000; // parsed records kept (a few hundred bytes each)
const WF_MAX = 512 * 1024;
const PARSE_SLICE = 8;
const OPS_SLICE = 200;
const SLICE_MS = 10;
const CHUNK = 1024 * 1024; // a transcript is read in pieces of this size, a cut after each
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const word = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Counted for the tests: records and transcript pieces parsed, and the cuts given. */
export const pieces = { parsed: 0, cuts: 0 };

/**
 * One look's cuts: op() before a file operation, parsed() after a parse; each gives the thread back (setImmediate)
 * when its count or SLICE_MS is reached. One cutter is shared by everything one look reads.
 */
export function cutter() {
  let ops = 0;
  let parsed = 0;
  let at = performance.now();
  const cut = async () => {
    ops = 0;
    parsed = 0;
    pieces.cuts += 1;
    await new Promise((r) => setImmediate(r));
    at = performance.now();
  };
  return {
    cut,
    async op() {
      ops += 1;
      if (ops >= OPS_SLICE || performance.now() - at > SLICE_MS) await cut();
    },
    async parsed() {
      pieces.parsed += 1;
      parsed += 1;
      if (parsed >= PARSE_SLICE || performance.now() - at > SLICE_MS) await cut();
    },
  };
}
const noCut = () => cutter();

const DONE = new Set(['completed', 'done', 'success']);
const FAILED = new Set(['failed', 'error', 'killed', 'cancelled', 'canceled', 'stopped']);

/** A workflow record as pulse reads it, or null. */
export function workflowOf(j) {
  if (!isObj(j) || typeof j.taskId !== 'string' || !ID_RE.test(j.taskId)) return null;
  const status = typeof j.status === 'string' ? j.status : 'running';
  const list = Array.isArray(j.workflowProgress) ? j.workflowProgress.slice(0, 1000) : [];
  const phases = list.filter((x) => isObj(x) && x.type === 'workflow_phase').map((x) => ({ index: num(x.index), title: word(x.title, 60) }));
  const agents = list.filter((x) => isObj(x) && x.type === 'workflow_agent');
  const st = (x) => String(x.state || '');
  const agentsDone = agents.filter((x) => st(x) === 'done').length;
  const agentsFailed = agents.filter((x) => st(x) === 'error' || st(x) === 'failed').length;
  const agentsWorking = agents.length - agentsDone - agentsFailed;
  const phaseNow = agents.reduce((m, x) => (Number.isInteger(x.phaseIndex) ? Math.max(m, x.phaseIndex) : m), -1);
  const lastAt = agents.reduce((m, x) => Math.max(m, num(x.lastProgressAt) || 0, num(x.startedAt) || 0), 0) || null;
  const startedMs = num(j.startTime);
  const durationMs = num(j.durationMs);
  return {
    id: j.taskId, name: word(j.workflowName || 'workflow', 60) || 'workflow',
    state: DONE.has(status) ? 'done' : FAILED.has(status) ? (status === 'killed' ? 'stopped' : 'failed') : 'running',
    startedMs, endedMs: !DONE.has(status) && !FAILED.has(status) ? null : startedMs !== null && durationMs !== null ? startedMs + durationMs : null,
    durationMs: DONE.has(status) || FAILED.has(status) ? durationMs : null,
    tokens: Number.isInteger(j.totalTokens) && j.totalTokens >= 0 ? j.totalTokens : null,
    steps: {
      phases: phases.length, phase: phaseNow >= 0 ? phaseNow + 1 : (phases.length ? 1 : null),
      phaseTitle: phaseNow >= 0 ? (phases.find((p) => p.index === phaseNow) || {}).title || null : null,
      agents: agents.length, done: agentsDone, working: agentsWorking, failed: agentsFailed,
    },
    lastAt,
  };
}

const cache = new Map(); // file → { mtimeMs, size, value }, the least recently used first
const keep = (file, v) => {
  cache.delete(file);
  cache.set(file, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
};
/** The record of `file` (stat `st`), parsed once per change of the file. */
async function readCached(file, st, cut) {
  const c = cache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
    keep(file, c);
    return c.value;
  }
  let value = null;
  await cut.op();
  try {
    value = workflowOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    value = null;
  }
  keep(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  await cut.parsed();
  return value;
}
/** The stat of a plain record file, or null. */
function statOf(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= WF_MAX ? st : null;
  } catch {
    cache.delete(file);
    return null;
  }
}

const listDir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

/** The workflows of conversation `id` in folder `cwd`. */
export async function workflowsOf(cwd, id, { cut = noCut() } = {}) {
  if (typeof cwd !== 'string' || !cwd || typeof id !== 'string' || !ID_RE.test(id)) return [];
  const dir = path.join(projectDir(cwd), id, 'workflows');
  const out = [];
  for (const f of listDir(dir).filter((x) => FILE_RE.test(x)).slice(0, 100)) {
    await cut.op();
    const st = statOf(path.join(dir, f));
    const w = st ? await readCached(path.join(dir, f), st, cut) : null;
    if (w) out.push(w);
  }
  return out;
}

/**
 * The workflow records of folder `cwd` (all its conversations), newest first: those written at `since` or later (a
 * record is written last when its workflow ends, so an older one cannot have ended later), FILES_MAX at most.
 * → [{ conv, ...workflowOf }].
 */
async function folderWorkflows(cwd, { since = -Infinity, cut = noCut() } = {}) {
  if (typeof cwd !== 'string' || !cwd) return [];
  const root = projectDir(cwd);
  const found = [];
  for (const conv of listDir(root)) {
    if (!ID_RE.test(conv)) continue;
    await cut.op();
    const dir = path.join(root, conv, 'workflows');
    for (const f of listDir(dir)) {
      if (!FILE_RE.test(f)) continue;
      await cut.op();
      const st = statOf(path.join(dir, f));
      if (st && st.mtimeMs >= since) found.push({ conv, file: path.join(dir, f), st });
    }
  }
  found.sort((x, y) => y.st.mtimeMs - x.st.mtimeMs);
  const out = [];
  for (const x of found.slice(0, FILES_MAX)) {
    const w = await readCached(x.file, x.st, cut);
    if (w) out.push({ conv: x.conv, ...w });
  }
  return out;
}

/** Every finished workflow of folder `cwd` (all its conversations), for the basis of an estimate: [{ name, ms, endedAt }]. */
export async function finishedWorkflows(cwd, { cut } = {}) {
  return (await folderWorkflows(cwd, { cut })).filter((w) => w.state === 'done' && w.durationMs !== null && w.endedMs !== null)
    .map((w) => ({ name: w.name, ms: w.durationMs, endedAt: new Date(w.endedMs).toISOString() }));
}

/** Every workflow of folder `cwd` that ended (finished, failed or stopped) at `since` or later, whether or not its session still runs. */
export async function endedWorkflows(cwd, { since = -Infinity, cut } = {}) {
  return (await folderWorkflows(cwd, { since, cut })).filter((w) => w.state !== 'running');
}

const tokenCache = new Map(); // transcript file → { offset, ids: Map(message id → tokens), sum }
const reading = new Map(); // transcript file → the read in flight (two looks at once share it)
/**
 * The tokens a conversation's transcript reports (each assistant message counted once, by its id), or null when it
 * reports none. Read on from the last look, in pieces of CHUNK with a cut after each.
 */
export async function transcriptTokens(cwd, id, { cut = noCut() } = {}) {
  if (typeof cwd !== 'string' || !cwd || typeof id !== 'string' || !ID_RE.test(id)) return null;
  const file = path.join(projectDir(cwd), `${id}.jsonl`);
  if (!reading.has(file)) reading.set(file, readTokens(file, cut).finally(() => reading.delete(file)));
  return reading.get(file);
}
async function readTokens(file, cut) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let c = tokenCache.get(file);
  if (!c || st.size < c.offset) c = { offset: 0, ids: new Map(), sum: 0 };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let size = CHUNK;
    while (st.size > c.offset) {
      const len = Math.min(st.size - c.offset, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, c.offset);
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) {
        // One line longer than the piece: a larger piece, up to 64 MB; else what is there is left for now.
        if (len < st.size - c.offset && size < 64 * CHUNK) {
          size *= 2;
          continue;
        }
        break;
      }
      size = CHUNK;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = isObj(m) && m.type === 'assistant' && isObj(m.message) ? m.message : null;
        if (!msg || !isObj(msg.usage)) continue;
        const u = msg.usage;
        const n = [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((s, v) => s + (Number.isFinite(v) && v >= 0 ? v : 0), 0);
        const key = typeof msg.id === 'string' ? msg.id : `line${c.offset}:${c.ids.size}`;
        c.sum += n - (c.ids.get(key) || 0);
        c.ids.set(key, n);
      }
      c.offset += end + 1;
      await cut.parsed();
      await cut.cut(); // a piece of a transcript is the most one stretch holds
    }
  } catch {
    /* read again next time */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value);
  tokenCache.set(file, c);
  return c.ids.size ? c.sum : null;
}
