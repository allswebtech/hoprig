// A long transcript of Claude Code's read in pieces (src/chat/reading.mjs), so the server's one thread is never held
// for a whole file: when the dashboard starts with fifty open App sessions, or when a session's page opens first.
// The first screen comes from the transcript's last part, read backwards from its end in pieces of PIECE bytes, and
// it starts at one of the owner's messages (a turn is never cut in two) once it holds TAIL_EVENTS events; the earlier
// part is read forwards in pieces when the page asks for it. Between two pieces the thread goes back to the server. A
// line cut across a piece's edge is read whole: lines are split on the newline byte, which no UTF-8 character holds.
import fs from 'node:fs';
import { inTurn } from '../../oneturn.mjs';
import { newTodos, todoStep } from './claude-content.mjs';
import { lineStep, linkWorkflows, nestAgents, subagentList, workflows } from './claude-transcript.mjs';

export const PIECE = 256 * 1024;
export const WHOLE_MAX = 32 * 1024; // a transcript up to this is read at once, as before: well under a millisecond
export const TAIL_EVENTS = 300; // the page's first window (src/chat/timeline.mjs window)
export const TAIL_MAX = 4 * 1024 * 1024; // a turn longer than this: the last part starts inside it
const NL = 0x0a;
// Fifty open sessions read at the start take turns (oneturn.mjs): without them their pieces ran back to back (80-90 ms).
/**
 * The complete lines of `buf` (file offset `at0`) into `st`; only: Buffers, of which a line must hold one to be read (the
 * rest is not parsed). → Map(first event index of a line → the line's offset)
 */
function stepLines(st, buf, at0, only = null) {
  const starts = new Map();
  let at = 0;
  for (;;) {
    const i = buf.indexOf(NL, at);
    const end = i < 0 ? buf.length : i;
    if (end > at && (!only || only.some((k) => buf.subarray(at, end).includes(k)))) {
      const k = st.events.length;
      lineStep(st, buf.toString('utf8', at, end));
      if (st.events.length > k) starts.set(k, at0 + at);
    }
    if (i < 0) return starts;
    at = i + 1;
  }
}

async function readAt(fh, n, pos) {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(buf, got, n - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got < n ? buf.subarray(0, got) : buf;
}

/** The events of bytes [from, to) of `file`, read forwards in pieces. agent: a subagent's tool call; only: stepLines'. */
export async function readRange(file, from, to, agent = null, only = null) {
  const st = { events: [], title: null, agent };
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return st;
  }
  try {
    let pos = from;
    let carry = Buffer.alloc(0);
    let done = false;
    while (pos < to && !done) {
      await inTurn(async () => {
        const buf = await readAt(fh, Math.min(PIECE, to - pos), pos);
        if (!buf.length) {
          done = true;
          return;
        }
        const chunk = carry.length ? Buffer.concat([carry, buf]) : buf;
        const at0 = pos - carry.length;
        pos += buf.length;
        const last = pos < to ? chunk.lastIndexOf(NL) : chunk.length;
        if (last < 0) {
          carry = chunk; // one line longer than a piece: read on
          return;
        }
        stepLines(st, chunk.subarray(0, last), at0, only);
        carry = pos < to ? chunk.subarray(last + 1) : Buffer.alloc(0);
      });
    }
    if (carry.length) stepLines(st, carry, to - carry.length, only);
  } finally {
    await fh.close();
  }
  return st;
}

/** The subagents of `dir` whose call is among `events`, each read in pieces: Map(toolId → events). */
async function agentEvents(subs, events) {
  const calls = new Set(events.filter((e) => e.kind === 'tool').map((e) => e.id));
  const out = new Map();
  for (const s of subs) {
    if (!calls.has(s.toolId)) continue;
    let size = 0;
    try {
      size = fs.statSync(s.file).size;
    } catch {
      /* no lines yet */
    }
    out.set(s.toolId, (await readRange(s.file, 0, size, s.toolId)).events);
  }
  return out;
}

/**
 * The last part of transcript `file`: { events, tasks, todos, title, size, mtimeMs, partial: { start, whole } | null }.
 * events: the main conversation's from one of the owner's messages on (with their subagents' steps), at least
 * TAIL_EVENTS where the file has them; partial.start: the byte offset they start at (null partial: the whole file was
 * read); partial.whole: the part starts at a turn's first message. raw: the events as read (for the to-do list later).
 */
export async function readTail(file, { want = TAIL_EVENTS, maxBytes = TAIL_MAX } = {}) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return { events: [], raw: [], tasks: [], todos: [], title: null, size: 0, mtimeMs: 0, partial: null };
  }
  let size = 0;
  let mtimeMs = 0;
  let events = [];
  let title = null;
  let start = 0;
  let whole = true;
  try {
    ({ size, mtimeMs } = await fh.stat());
    let pos = size;
    let carry = Buffer.alloc(0); // the start of a line whose beginning lies in the piece before
    let done = false;
    while (pos > 0 && !done) await inTurn(async () => {
      const n = Math.min(PIECE, pos);
      const buf = await readAt(fh, n, pos - n);
      pos -= n;
      const chunk = carry.length ? Buffer.concat([buf, carry]) : buf;
      let cut = 0;
      if (pos > 0) {
        const i = chunk.indexOf(NL);
        if (i < 0) {
          carry = chunk;
          return;
        }
        cut = i + 1;
        carry = chunk.subarray(0, i);
      } else carry = Buffer.alloc(0);
      const st = { events: [], title: null, agent: null };
      const starts = stepLines(st, chunk.subarray(cut), pos + cut);
      events = [...st.events, ...events];
      if (title === null) title = st.title; // the newest one: read first, going backwards
      start = pos + cut;
      if (events.length >= want) {
        // One of the owner's messages of this piece, as late as leaves `want` events: the part starts there.
        let k = -1;
        for (let j = st.events.length - 1; j >= 0; j--) {
          if (st.events[j].kind === 'user' && !st.events[j].agent && events.length - j >= want && starts.has(j)) {
            k = j;
            break;
          }
        }
        if (k >= 0) {
          events = events.slice(k);
          start = starts.get(k);
          done = true;
          return;
        }
        if (size - pos >= maxBytes) {
          whole = false; // one long turn: the part starts inside it
          done = true;
        }
      }
    });
  } finally {
    await fh.close();
  }
  if (start === 0) whole = true;
  const dir = file.replace(/\.jsonl$/, '');
  const subs = subagentList(dir);
  const raw = nestAgents(events, await agentEvents(subs, events));
  const tasks = [...subs.map((s) => s.task), ...workflows(dir)];
  linkWorkflows(tasks, events);
  return { events: raw, raw, tasks, todos: todosOf(raw), title, size, mtimeMs, partial: start > 0 ? { start, whole } : null };
}

/** The part before byte `start` (readTail's partial.start), read forwards in pieces: { events } (with subagents' steps). */
export async function readEarlier(file, start) {
  const st = await readRange(file, 0, start);
  const subs = subagentList(file.replace(/\.jsonl$/, ''));
  return { events: nestAgents(st.events, await agentEvents(subs, st.events)) };
}

// The lines that can change the to-do list: its tool calls, and the answer that gives a created task its number.
const TODO_LINES = ['"TodoWrite"', '"TaskCreate"', '"TaskUpdate"', 'Task #'].map((k) => Buffer.from(k));
/**
 * The to-do list of the whole transcript when only its last part was read (readTail): the calls of the part before
 * byte `start`, read forwards in pieces with only the to-do lines parsed, then those of the last part's events (`tail`,
 * in order). A list kept by TaskCreate and TaskUpdate needs every call since the start, not only the last one.
 */
export async function todosBefore(file, start, tail) {
  const st = await readRange(file, 0, start, null, TODO_LINES);
  return todosOf([...st.events, ...tail]);
}

/** The to-do list as the calls of `events` (in order) leave it. */
export function todosOf(events) {
  const t = newTodos();
  for (const e of events) if (!e.agent) todoStep(t, e);
  return t.list;
}
