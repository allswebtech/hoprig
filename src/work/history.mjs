// Work's one history (Work → Activity): what happened in the workspace, newest first, as one list. It reads only what
// the dashboard keeps already and writes nothing anywhere:
//   - the sessions (sessionlog.mjs), the open and archived App sessions (chats.json, chat-archived.json: a title, Tia's
//     mark, still open; an open one the log has no line for yet gets its line from chats.json), and who started one
//     by a schedule (the automations' log names the session it started);
//   - Work's runs (doit.mjs list): a failed one is an error;
//   - the commits of the workspace's projects, read through src/gitread.mjs only (no fetch, no lock), the last 30 days,
//     at most COMMITS_MAX per repository, cached CACHE_MS; a commit with Work's save subject is a save;
//   - the automations' log (a failed or missed line is an error) and the Operator's timeline lines that failed.
// A line: { id, at, day, kind: session|run|commit|save|automation|error, project (null: outside every project), who:
// owner|tia|schedule|null (null: not known, shown only under "everyone"), text, detail, and what opens it (item, run,
// chat) }. No line holds a full path: free text is cleaned as a run's words are (runs.mjs cleanText).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { listProfiles, publicProfile } from '../profiles.mjs';
import { listProjects, projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { folderChoices } from './folders.mjs';
import { todayIn } from './model.mjs';
import { workSettings } from './place.mjs';
import { cleanText, pathsOf } from './runs.mjs';
import { KEEP_MS, projectOf, readSessions } from './sessionlog.mjs';

export const PAGE = 200;
export const WHO = ['owner', 'tia', 'schedule'];
const COMMITS_MAX = 100;
const REPOS_MAX = 60;
const CACHE_MS = 5 * 60_000;
const MATCH_MS = 5 * 60_000; // a schedule's "started" line and the session it started
const TEXT_MAX = 200;
const TOOLS = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' };
const ENDS = { ended: 'ended', limit: 'stopped at a usage limit', failed: 'ended with an error', stopped: 'was stopped' };
const RUN_WORDS = { running: 'working', done: 'done', failed: 'failed', limit: 'stopped at a usage limit', stopped: 'stopped' };

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const iso = (ms) => new Date(ms).toISOString();
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const readJsonLines = (file) => {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).flatMap((l) => {
    try {
      const x = JSON.parse(l);
      return x && typeof x === 'object' ? [x] : [];
    } catch {
      return [];
    }
  });
};

// ---------- commits, through the safe reader, cached ----------

const cache = new Map(); // repository folder → { at, list }
/** Forget the cached git reads (tests; a page's "Refresh" does not need it). */
export const forgetCommits = () => cache.clear();

/** The git repositories of the workspace's projects: [{ project, repo ("." or "code/web"), dir }]. */
export function projectRepos(projects = projectsIn()) {
  const out = [];
  for (const p of listProjects(projects)) {
    for (const c of folderChoices(p.dir)) {
      if (!c.git || out.length >= REPOS_MAX) continue;
      out.push({ project: p.name, repo: c.value, dir: c.value === '.' ? p.dir : path.join(p.dir, c.value) });
    }
  }
  return out;
}

/** The commits of repository `dir` of the last 30 days: [{ sha, short, at, subject }], newest first; [] when git cannot read it. */
export async function commitsOf(dir, { now = Date.now(), run } = {}) {
  const c = cache.get(dir);
  if (c && now - c.at < CACHE_MS) return c.list;
  const since = Math.floor((now - KEEP_MS) / 1000);
  const r = await gitRead(dir, ['log', `--max-count=${COMMITS_MAX}`, `--since=${since}`, '--no-merges', '--format=%H%x09%ct%x09%s'], run ? { run } : {});
  const list = r.ok ? r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([sha, ct]) => /^[0-9a-f]{40,64}$/.test(sha) && /^\d+$/.test(ct))
    .map(([sha, ct, ...s]) => ({ sha, short: sha.slice(0, 7), at: iso(Number(ct) * 1000), subject: s.join('\t') })) : [];
  cache.set(dir, { at: now, list });
  return list;
}

// ---------- the lines ----------

/**
 * Everything of the history, newest first, before any filter. `src`: what was read (each a list, any may be absent):
 * { sessions, chats: { open: Map(id → { title, byTia, hers, project, tool, provider, openedAt }), archived: Map(id → title) },
 * runs, commits: [{ project, repo, place?, list }], saveSubject, automation, operator }, `tz` (Work's time zone),
 * `clean(text)`, `label(name)`: a provider's label as Settings shows it (the name when it has none or is gone).
 */
export function mergeHistory(src, { tz = '', clean = (s) => s, label = (n) => n } = {}) {
  const lines = [];
  const day = (at) => todayIn(tz, new Date(at));
  const add = (l) => {
    if (!l.at || !Number.isFinite(Date.parse(l.at))) return;
    lines.push({ ...l, text: clean(String(l.text || '')).slice(0, TEXT_MAX + 1), ...(l.detail ? { detail: clean(String(l.detail)) } : {}), day: day(l.at) });
  };
  const runs = src.runs || [];
  const workChats = new Set(runs.map((r) => r.session).filter(Boolean));
  const automation = src.automation || [];
  const open = (src.chats && src.chats.open) || new Map();
  const archived = (src.chats && src.chats.archived) || new Map();

  // Who started a session by a schedule: the schedules' "started" line that names it, within a few minutes of its start.
  const started = automation.filter((e) => e.automation === 'schedules' && /^started /.test(String(e.did || '')) && (e.outcome || 'ok') === 'ok');
  const used = new Set();
  const bySchedule = (s) => {
    const name = s.kind === 'chat' ? `chat:${s.chat || s.id}` : s.term;
    if (!name || !s.startedAt) return false;
    const e = started.find((x) => !used.has(x) && x.session === name && Math.abs(Date.parse(x.time) - Date.parse(s.startedAt)) <= MATCH_MS);
    if (e) used.add(e);
    return !!e;
  };
  // A run that ends by itself: its schedule's line is the run's start.
  for (const r of runs) {
    if (r.by !== 'schedule') continue;
    const e = started.find((x) => !used.has(x) && !x.session && Math.abs(Date.parse(x.time) - Date.parse(r.startedAt)) <= MATCH_MS);
    if (e) used.add(e);
  }

  // An open App session whose process has not ended yet has no line in the session log: it gets its line from the
  // App's own list (chats.json), as one that is open in the App.
  const logged = new Set((src.sessions || []).filter((s) => s.kind === 'chat').map((s) => s.chat || s.id));
  const sessions = [...(src.sessions || [])];
  for (const [id, o] of open) {
    if (logged.has(id) || !o.openedAt) continue;
    sessions.push({ id, kind: 'chat', chat: id, project: o.project || null, tool: o.tool || 'claude', provider: o.provider || null, providers: [], title: '', who: o.byTia ? 'tia' : 'owner', startedAt: o.openedAt, endedAt: null, end: null });
  }

  for (const s of sessions) {
    if (s.kind === 'chat' && workChats.has(s.chat || s.id)) continue; // a Work run's session: the run's line says it
    const o = s.kind === 'chat' ? open.get(s.chat || s.id) : null;
    const who = s.who === 'tia' || (o && o.byTia) ? 'tia' : bySchedule(s) ? 'schedule' : 'owner';
    const title = s.title || (o && o.title) || (s.kind === 'chat' ? archived.get(s.chat || s.id) : '') || '';
    const where = s.kind === 'chat' ? 'An App session' : 'A terminal session';
    const still = o ? 'is open in the App' : s.end ? ENDS[s.end] || 'ended' : 'started';
    const on = [TOOLS[s.tool] || s.tool, s.providers && s.providers.length > 1 ? `on ${s.providers.map(label).join(', then ')}` : s.provider ? `on ${label(s.provider)}` : ''].filter(Boolean).join(' ');
    add({ id: `session:${s.kind}:${s.id}`, at: (!o && s.endedAt) || s.startedAt, kind: 'session', project: s.project || null, who, text: title || `${where} ${still}`,
      detail: `${title ? `${where} · ` : ''}${on}${title ? ` · ${still}` : ''}`, end: o ? null : s.end || null, tool: s.tool, provider: s.provider || null, ...(s.kind === 'chat' ? { chat: s.chat || s.id, open: !!o } : {}) });
  }

  // A Do it run Tia started through her door is written by "owner" (the jobs, missions and Accept read `by` so), but its
  // chat is hers: marked so while open (chats.json `hers`) and noted so when it ended (the session log's who).
  const herChats = new Set([
    ...(src.sessions || []).filter((s) => s.kind === 'chat' && s.who === 'tia').map((s) => s.chat || s.id),
    ...[...open].filter(([, o]) => o.hers === true || o.byTia === true).map(([id]) => id),
  ]);
  const runWho = new Map(); // a commit's short id → the who of the run that made it
  for (const r of runs) {
    const who = r.by === 'schedule' ? 'schedule' : r.by === 'mission' ? 'tia' : r.by === 'owner' ? (r.session && herChats.has(r.session) ? 'tia' : 'owner') : null;
    for (const c of r.commits || []) if (c && typeof c.short === 'string') runWho.set(`${r.project}:${c.repo}:${c.short.slice(0, 7)}`, who);
    const failed = r.state === 'failed';
    add({ id: `run:${r.id}`, at: r.endedAt || r.startedAt, kind: failed ? 'error' : 'run', project: r.project || null, who,
      text: failed ? `"${r.title}" failed${r.reason ? `: ${r.reason}` : ''}` : r.title,
      detail: `${r.by === 'schedule' ? 'A schedule ran it' : 'Do it'} · ${[TOOLS[r.tool] || r.tool, r.providerLabel || r.provider ? `on ${r.providerLabel || label(r.provider)}` : ''].filter(Boolean).join(' ')} · ${RUN_WORDS[r.state] || r.state}`,
      item: r.item, run: r.id, state: r.state, tool: r.tool, provider: r.provider || null });
  }

  for (const c of src.commits || []) {
    for (const x of c.list) {
      // A save: Work's own commit (its subject) in the repository that keeps the Work file.
      const save = c.work === true && !!src.saveSubject && x.subject === src.saveSubject;
      if (c.only && !save) continue; // the Work file's repository outside the projects (the AI brain): only its saves
      const who = runWho.get(`${c.project}:${c.repo}:${x.short}`) ?? null;
      const where = c.project ? (c.repo === '.' ? c.project : `${c.project}/${c.repo}`) : 'the AI brain';
      add({ id: `commit:${c.project || ''}:${c.repo}:${x.sha}`, at: x.at, kind: save ? 'save' : 'commit', project: c.project || null, who,
        text: save ? 'Saved the Work list' : x.subject || '(no message)', detail: `${save ? 'Save · ' : ''}${where} · ${x.short}`, short: x.short });
    }
  }

  for (const e of automation) {
    if (used.has(e)) continue;
    const did = String(e.did || '').trim();
    const outcome = String(e.outcome || 'ok');
    const bad = /^(failed|missed)/.test(outcome);
    const session = String(e.session || '');
    const project = session && !session.startsWith('chat:') && src.projects && src.projects.includes(session) ? session : null;
    add({ id: `auto:${e.time}:${e.automation}:${did.slice(0, 40)}`, at: e.time, kind: bad ? 'error' : 'automation', project, who: e.automation === 'schedules' ? 'schedule' : null,
      text: `${cap(did)}${bad ? `: ${outcome.replace(/^(failed|missed):?\s*/, '') || outcome}` : ''}`, detail: `Automation · ${e.automation}${!bad && outcome !== 'ok' ? ` · ${outcome}` : ''}` });
  }

  for (const l of src.operator || []) {
    if (l.ok !== false) continue;
    add({ id: `operator:${l.at}:${l.item || ''}:${l.act || ''}`, at: l.at, kind: 'error', project: null, who: l.by ? 'tia' : 'owner',
      text: `${cap(String(l.subject || 'Operator'))}: "${l.act}" did not work${l.result ? ` (${l.result})` : ''}`, detail: 'Operator' });
  }
  return lines.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

/**
 * One page of the history: f { project, day, who, before (an ISO time: only lines older than it) }. → { lines (at most
 * PAGE; a page never splits lines of one time), more, before (the next page's `before`, or null), projects, days }.
 */
export function pageOf(all, f = {}) {
  const shown = all.filter((l) => (!f.project || l.project === f.project) && (!f.day || l.day === f.day) && (!f.who || l.who === f.who));
  const older = f.before ? shown.filter((l) => l.at < f.before) : shown;
  let n = Math.min(PAGE, older.length);
  while (n < older.length && older[n].at === older[n - 1].at) n += 1;
  const lines = older.slice(0, n);
  const more = older.length > n;
  return { lines, more, before: more ? lines[lines.length - 1].at : null,
    projects: [...new Set(all.map((l) => l.project).filter(Boolean))].sort(), days: [...new Set(all.map((l) => l.day))].sort().reverse() };
}

/**
 * Read everything and merge it. o: { cfg, projects (the projects folder), runs() (Work's runs as doit.mjs lists them),
 * place() (Work's place: its repository's saves), now, run (git, for tests) }.
 */
export async function readHistory({ cfg = {}, projects = projectsIn(cfg), runs = () => [], place = () => null, now = Date.now(), run } = {}) {
  const st = stateDir();
  const since = now - KEEP_MS;
  const after = (at) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= since;
  const settings = workSettings(cfg);
  const open = new Map();
  for (const c of [].concat(readJson(path.join(st, 'chats.json'), []))) {
    if (!c || typeof c.id !== 'string') continue;
    // What an open chat's own line needs (mergeHistory): its project by name, never its folder.
    open.set(c.id, { title: typeof c.title === 'string' ? c.title : '', byTia: c.byTia === true, hers: c.hers === true, project: projectOf(c.cwd, projects), tool: typeof c.engine === 'string' ? c.engine : 'claude',
      provider: typeof c.profile === 'string' ? c.profile : null, openedAt: Number.isFinite(c.openedAt) && c.openedAt >= since ? iso(c.openedAt) : null });
  }
  const archived = new Map();
  for (const c of [].concat(readJson(path.join(st, 'chat-archived.json'), []))) if (c && typeof c.id === 'string' && typeof c.title === 'string') archived.set(c.id, c.title);
  let workRuns = [];
  try {
    workRuns = runs().filter((r) => after(r.endedAt || r.startedAt));
  } catch {
    /* no Work place: no runs */
  }
  let p = null;
  try {
    p = place();
  } catch {
    /* no Work place */
  }
  const real = (d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  };
  const repos = projectRepos(projects);
  // The repository the Work file is committed in: the deepest one that holds its folder, else its place's own folder.
  const holds = (d) => p && p.folder && (real(p.folder) === real(d) || real(p.folder).startsWith(real(d) + path.sep));
  const workRepo = p ? (repos.filter((r) => holds(r.dir)).map((r) => real(r.dir)).sort((a, b) => b.length - a.length)[0] || (p.base ? real(p.base) : null)) : null;
  const commits = [];
  for (const r of repos) commits.push({ project: r.project, repo: r.repo, work: real(r.dir) === workRepo, list: await commitsOf(r.dir, { now, run }) });
  // The Work file outside every project's repository (the AI brain): its saves are read there too.
  if (workRepo && !commits.some((c) => c.work) && fs.existsSync(path.join(workRepo, '.git'))) commits.push({ project: null, repo: '.', work: true, only: true, list: await commitsOf(workRepo, { now, run }) });
  const names = listProjects(projects).map((x) => x.name);
  const automation = readJsonLines(path.join(st, 'automation.log')).filter((e) => typeof e.time === 'string' && after(e.time));
  const operator = readJsonLines(path.join(st, 'operator', 'timeline.jsonl')).filter((l) => typeof l.at === 'string' && after(l.at));
  const paths = pathsOf({ projectsDir: projects, workspace: workspaceDir(cfg), home: os.homedir() });
  const clean = (s) => cleanText(String(s).replace(/\s+/g, ' ').trim(), TEXT_MAX, paths);
  // A provider by the label Settings and Providers show ("Claude Max"), as a run's card names it (doit.mjs labels).
  const labels = new Map([['auto', 'Auto mode']]);
  try {
    for (const x of listProfiles()) labels.set(x.name, publicProfile(x).label || x.name);
  } catch {
    /* no providers readable: their names */
  }
  const label = (n) => labels.get(n) || n;
  return mergeHistory({ sessions: readSessions({ now }), chats: { open, archived }, runs: workRuns, commits, saveSubject: settings.saveSubject, automation, operator, projects: names }, { tz: settings.timeZone, clean, label });
}
