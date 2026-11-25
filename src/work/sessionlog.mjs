// The sessions this dashboard and its launchers ran, kept for Work's one history (history.mjs): one JSON line when a
// terminal session starts and one when any session's process ends (a terminal's or an App session's), in
// <state>/work-history/sessions.jsonl. src/runs.mjs calls noteStart from createRun and noteEnd from removeRun, before the
// run's record and Tia's mark go.
//
// A line holds only: the time, "start" or "end", the run's id (and the App session's id for a chat), the name of the
// workspace project the session ran in (null: a folder outside every project), the coding tool, the provider, the
// session's title where one is known, who (`tia` when the dashboard marked the session hers, src/hermark.mjs; else
// `owner`; a schedule is told at read time from the automations' log), the dashboard's name of its terminal, and how it
// ended (ended, limit, failed). Never a full path, a host name, a prompt, a transcript or an answer's text. Kept 30
// days and at most LOG_MAX bytes (trimmed when written). A write never throws into its caller: a session that is not
// noted still starts and ends. Sessions from before this version are not in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMarkedHers } from '../hermark.mjs';
import { stateDir } from '../paths.mjs';
import { projectDir } from '../sessions.mjs';
import { conversationTitle, ownName } from '../titles.mjs';
import { listProjects, projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { cleanText, pathsOf } from './runs.mjs';

export const KEEP_MS = 30 * 24 * 3_600_000;
export const LOG_MAX = 256 * 1024;
const TITLE_MAX = 120;
const TRANSCRIPT_MAX = 16 * 1024 * 1024; // a title is not looked for in a transcript larger than this (the end stays quick)
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const TERM_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const logFile = () => path.join(stateDir(), 'work-history', 'sessions.jsonl');

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The name of the workspace project folder `cwd` lies in, or null (outside every project, or no folder). */
export function projectOf(cwd, projects = projectsIn()) {
  const c = typeof cwd === 'string' && path.isAbsolute(cwd) ? real(cwd) || path.resolve(cwd) : null;
  if (!c) return null;
  for (const p of listProjects(projects)) {
    const r = real(p.dir);
    if (r && inside(c, r)) return p.name;
  }
  return null;
}

/** The title of a run's session, cleaned of keys, paths and this computer's name; '' when none is known. */
function titleOf(run) {
  let t = typeof run.title === 'string' ? run.title : '';
  const id = run.sessionId || run.conversation;
  if (!t && typeof id === 'string' && UUID_RE.test(id)) {
    t = ownName(id);
    if (!t && (run.tool || 'claude') === 'claude' && typeof run.cwd === 'string') {
      const file = path.join(projectDir(run.cwd), `${id}.jsonl`);
      // Its name, or the coding tool's own title for it: never the first thing typed (that is a prompt).
      if (fs.statSync(file, { throwIfNoEntry: false })?.size <= TRANSCRIPT_MAX) {
        const c = conversationTitle(file);
        t = c.custom || c.ai || '';
      }
    }
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t ? cleanText(t, TITLE_MAX, pathsOf({ projectsDir: projectsIn(), workspace: workspaceDir(), home: os.homedir() })) : '';
}

function lineOf(ev, file, run, at) {
  const id = typeof run.runId === 'string' && ID_RE.test(run.runId) ? run.runId : path.basename(String(file), '.json');
  if (!ID_RE.test(id)) return null;
  const line = { at: new Date(at).toISOString(), ev, id, kind: run.kind === 'chat' ? 'chat' : 'terminal' };
  if (line.kind === 'chat' && typeof run.chat === 'string' && ID_RE.test(run.chat)) line.chat = run.chat;
  line.project = projectOf(run.cwd);
  line.tool = typeof run.tool === 'string' && NAME_RE.test(run.tool) ? run.tool : 'claude';
  if (typeof run.profile === 'string' && NAME_RE.test(run.profile)) line.provider = run.profile;
  line.who = isMarkedHers(file) ? 'tia' : 'owner';
  if (typeof run.termName === 'string' && TERM_RE.test(run.termName)) line.term = run.termName;
  if (Number.isFinite(run.startedAt)) line.startedAt = new Date(run.startedAt).toISOString();
  if (ev === 'end') {
    line.end = run.limit ? 'limit' : run.failure ? 'failed' : 'ended';
    try {
      const t = titleOf(run);
      if (t) line.title = t;
    } catch {
      /* no title: the line is kept without one */
    }
  } else if (typeof run.title === 'string' && run.title.trim()) {
    line.title = cleanText(run.title.replace(/\s+/g, ' ').trim(), TITLE_MAX, []);
  }
  return line;
}

/** Lines of the log, oldest first; a line that cannot be read is skipped. */
export function readLines(file = logFile()) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const x = JSON.parse(l);
      if (x && typeof x === 'object' && typeof x.at === 'string' && Number.isFinite(Date.parse(x.at)) && (x.ev === 'start' || x.ev === 'end') && typeof x.id === 'string') out.push(x);
    } catch {
      /* a line cut off */
    }
  }
  return out;
}

/** The log cut to its last 30 days and, when it is still too big, to its newest lines that fit in half of LOG_MAX. */
function trim(file, now, max) {
  const lines = readLines(file).filter((x) => now - Date.parse(x.at) < KEEP_MS).map((x) => JSON.stringify(x));
  let size = 0;
  let from = lines.length;
  while (from > 0 && size + lines[from - 1].length + 1 <= max / 2) size += lines[--from].length + 1;
  const keep = lines.slice(from);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function note(ev, file, run, { now = Date.now(), max = LOG_MAX, to = logFile() } = {}) {
  try {
    if (!run || typeof run !== 'object') return false;
    const line = lineOf(ev, file, run, now);
    if (!line) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.appendFileSync(to, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    if (fs.statSync(to).size > max) trim(to, now, max);
    return true;
  } catch {
    return false; // never in the way of a session
  }
}

/** A terminal session's run record was written (createRun). Never throws. */
export const noteStart = (file, run, o) => note('start', file, run, o);
/** A session's run record goes (removeRun), read before its record and Tia's mark are removed. Never throws. */
export const noteEnd = (file, run, o) => note('end', file, run, o);

/**
 * The sessions of the log, one per run (a terminal) or per App session (its processes' runs taken together), newest
 * first: [{ id, kind, chat?, project, tool, provider, providers, title, who, term?, startedAt, endedAt, end }].
 * endedAt and end are null while it runs (or when its end was not noted). `since`: only sessions that started or ended
 * after it.
 */
export function readSessions({ file = logFile(), now = Date.now(), since = now - KEEP_MS } = {}) {
  const by = new Map();
  for (const x of readLines(file)) {
    const key = x.kind === 'chat' && x.chat ? `chat:${x.chat}` : `run:${x.id}`;
    const s = by.get(key) || { id: x.kind === 'chat' && x.chat ? x.chat : x.id, kind: x.kind === 'chat' ? 'chat' : 'terminal', project: null, tool: 'claude', provider: null, providers: [], title: '', who: 'owner', startedAt: null, endedAt: null, end: null, runs: new Set() };
    if (x.kind === 'chat' && x.chat) s.chat = x.chat;
    if (typeof x.project === 'string') s.project = x.project;
    if (typeof x.tool === 'string') s.tool = x.tool;
    if (typeof x.provider === 'string') {
      s.provider = x.provider;
      if (s.providers[s.providers.length - 1] !== x.provider) s.providers.push(x.provider);
    }
    if (typeof x.title === 'string' && x.title) s.title = x.title;
    if (x.who === 'tia') s.who = 'tia';
    if (typeof x.term === 'string') s.term = x.term;
    const started = typeof x.startedAt === 'string' ? x.startedAt : x.ev === 'start' ? x.at : null;
    if (started && (!s.startedAt || started < s.startedAt)) s.startedAt = started;
    s.runs.add(x.id);
    if (x.ev === 'end') {
      s.endedAt = x.at;
      s.end = x.end || 'ended';
    } else if (s.kind === 'terminal' && s.endedAt && x.at > s.endedAt) {
      s.endedAt = null; // started again under the same record (a move to another provider): it runs
      s.end = null;
    }
    by.set(key, s);
  }
  return [...by.values()]
    .filter((s) => Date.parse(s.endedAt || s.startedAt || 0) >= since)
    .map(({ runs, ...s }) => s)
    .sort((a, b) => String(b.endedAt || b.startedAt).localeCompare(String(a.endedAt || a.startedAt)));
}
