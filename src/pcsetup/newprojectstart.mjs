// "Start with AI" for a new project (newproject.mjs makes the project): an App session in the project's folder whose
// first message names the new-project skill and carries the brief from docs/brief.md, as the owner wrote it. The same
// choices as Work's "Do it" (src/work/doit.mjs): the coding tool, the provider (the folder's default when none is
// chosen), the model and the effort (Settings → New sessions when none is chosen); the chat takes Settings'
// defaults, not a mode the owner chose for himself in another chat (defaults: true, as Do it).
//
//   GET  /api/pcsetup/project/start?name=&tool=      what a start would use: the coding tools, providers, models,
//                                                    efforts, the defaults, the kinds and the scopes (name: may
//                                                    not exist yet)
//   POST /api/pcsetup/project/start { name, kind?, scope?, tool?, provider?, model?, effort?, dryRun?, again? }
//                                                    → { chat, project, tool, toolName, provider, providerLabel,
//                                                    model, effort, kind, scope } or, with
//                                                    dryRun, { dryRun, would: { …, text } }; refused (409, code
//                                                    'started', chat) while a session that sets it up is open
//                                                    or being opened, unless again: true
//   POST /api/pcsetup/project/command/start          the same for `hoprig project new --start` / `project start` on
//                                                    this computer, with the command token (below), before the login
//
// Only a project of the workspace (by name, as every project route: where.mjs) with a first commit, with the skill in
// .claude/skills and a brief in docs/brief.md (regular files inside the project, read through inside.mjs), checked again here: a brief
// edited since it was made is refused when it holds a character that cannot be seen. Nothing here writes a file.
//
// The command token: a random token in Hoprig's state folder (mode 600, new at every start of the dashboard), good for
// that one route and nothing else, as Work's (src/work/dofeature.mjs) is for its own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { listProfiles, publicProfile } from '../profiles.mjs';
import { chatTool, chatToolList, choicesOf, modelOk, modelRefusal, serves } from '../chat/tools.mjs';
import { chatTitle } from '../server/validate.mjs';
import { gitRead } from '../gitread.mjs';
import { readIn } from '../workspace/inside.mjs';
import { BRIEF_FILE, KINDS, SCOPES, SKILL_DIR, checkProjectBrief, defaultsFile, firstMessage, kindOf, scopeOf, utf8 } from './newproject.mjs';
import { projectsDir } from './projects.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { replaceFile } from '../replacefile.mjs';

export const COMMAND_PATH = '/api/pcsetup/project/command/start';
// The first line of the start message: the chat page shows a message that begins with it folded (Hoprig wrote it,
// not he), with his brief under it as he wrote it (web/chat/words.js startFold). The same words there.
export const START_MARK = '<!-- hoprig:new-project -->';
// The mark with the project's folder name in it, so the fold can name the project before the chat's state is read.
export const startMark = (name) => START_MARK.replace(' -->', ` ${String(name).replace(/[^\w.-]/g, '').slice(0, 80)} -->`);
export const COMMAND_HEADER = 'x-hoprig-project-command';
export const commandTokenFile = () => path.join(stateDir(), 'project-command-token');
const TOKEN_RE = /^hpc_[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,119}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/;
const KEYS = ['name', 'kind', 'scope', 'tool', 'provider', 'model', 'effort', 'dryRun', 'again'];

const fail = (status, message, code, more = {}) => Object.assign(new Error(message), { status, ...(code ? { details: { code, ...more } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The kind and the scope the project was made with: the lines of the NEWEST "how the project starts" entry of
 * decisions.md, the one its own `project new` wrote (newproject.mjs startDecision; an older one came with a template
 * and is another project's), when they name a kind and a scope there are. → { kind?, scope? }.
 */
export function madeWith(root) {
  const buf = readIn(root, path.join(root, 'decisions.md'), { below: true });
  const text = buf ? utf8(buf) || '' : '';
  const heads = [...text.matchAll(/^## .*: how the project starts[ \t]*$/gm)];
  if (!heads.length) return {};
  const from = heads[heads.length - 1].index;
  const next = /^## /m.exec(text.slice(from + 3));
  const entry = text.slice(from, next ? from + 3 + next.index : text.length);
  const kind = (/^- The owner's hint for the kind: .*\(`([a-z-]+)`\)\./m.exec(entry) || [])[1];
  const scope = (/^- The scope: .*\(`([a-z]+)`\):/m.exec(entry) || [])[1];
  return { ...(kind && kindOf(kind) ? { kind } : {}), ...(scope && scopeOf(scope) ? { scope } : {}) };
}

/** The body of a start, checked: { name, kind?, scope?, tool?, provider?, model?, effort?, dryRun }. */
export function cleanStart(b) {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object');
  for (const k of Object.keys(b)) if (!KEYS.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
  if (typeof b.name !== 'string' || !REF_RE.test(b.name)) throw fail(400, 'that is not a project of the workspace');
  const out = { name: b.name, dryRun: b.dryRun === true };
  const str = (k, re, what) => {
    if (b[k] === undefined || b[k] === null || b[k] === '') return;
    if (typeof b[k] !== 'string' || !re.test(b[k])) throw fail(400, `that is not ${what}`);
    out[k] = b[k];
  };
  str('tool', /^[a-z]{1,20}$/, 'a coding tool');
  str('provider', NAME_RE, 'a provider');
  str('model', MODEL_RE, 'a model');
  str('effort', /^[a-z]{1,20}$/, 'an effort');
  if (b.kind !== undefined && b.kind !== null && b.kind !== '') {
    if (typeof b.kind !== 'string' || !kindOf(b.kind)) throw fail(400, `the kind is one of: ${KINDS.map((k) => k.id).join(', ')}`);
    out.kind = b.kind;
  }
  if (b.scope !== undefined && b.scope !== null && b.scope !== '') {
    if (typeof b.scope !== 'string' || !scopeOf(b.scope)) throw fail(400, `the scope is one of: ${SCOPES.map((s) => s.id).join(', ')}`);
    out.scope = b.scope;
  }
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw fail(400, 'dryRun is true or false');
  if (b.again !== undefined && typeof b.again !== 'boolean') throw fail(400, 'again is true or false');
  if (b.again === true) out.again = true;
  return out;
}

/**
 * o: { config(), chat (the chat feature: open), defaultProvider(dir, last, tool), projects() (the projects folder),
 * findProject(ref) → { root, ref }, defaults() (the owner's defaults file or null) }.
 */
export function projectStarter(o) {
  const cfg = () => (o.config ? o.config() : {});
  const projects = () => (o.projects ? o.projects() : projectsDir());
  // The saved values a check keeps accepting (the default of Settings → New sessions); the provider's own list
  // comes from src/models/catalog.mjs (chat/tools.mjs choicesOf).
  const models = () => {
    const saved = (cfg().sessionDefaults || {}).model;
    return saved ? [saved] : [];
  };
  const providersFor = (tool) => {
    const out = listProfiles().filter((p) => serves(p.name, tool)).map((p) => {
      const v = publicProfile(p);
      return { name: v.name, label: v.label || v.name, kind: v.kind };
    });
    if (serves('auto', tool)) out.unshift({ name: 'auto', label: 'Auto mode', kind: 'auto' });
    return out;
  };

  /** The project `ref` names, with its brief and skill: { root, ref, brief } or throws (404, 409). */
  async function projectOf(ref) {
    const at = await o.findProject(ref);
    const root = at.root;
    if (!readIn(root, path.join(root, SKILL_DIR, 'SKILL.md'), { below: true })) throw fail(409, `${at.ref} has no ${SKILL_DIR}/SKILL.md: it was not made as a new project with a brief`, 'no-skill');
    const buf = readIn(root, path.join(root, BRIEF_FILE), { below: true });
    if (!buf) throw fail(409, `${at.ref} has no brief in ${BRIEF_FILE}: write one there first`, 'no-brief');
    const text = utf8(buf);
    if (text === null) throw fail(409, `${BRIEF_FILE} is not UTF-8 text`, 'brief-encoding');
    let brief;
    try {
      brief = checkProjectBrief(text);
    } catch (e) {
      throw Object.assign(e, { status: 409, details: { ...(e.details || {}), code: (e.details && e.details.code) || 'brief-bad' } });
    }
    // A project whose `project new` stopped before the first commit is not one to set up: it is left half made.
    const head = await gitRead(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    if (!head.ok && !head.refused) throw fail(409, `${at.ref} has no first commit: it was left half made. Remove it and make it again (hoprig project new)`, 'no-commit');
    return { root, ref: at.ref, brief, ...madeWith(root) };
  }

  /** What the page offers before a start: the tools, providers, models, efforts, defaults and kinds. */
  async function choices(ref, want = {}) {
    let dir = projects();
    if (ref) {
      try {
        dir = (await o.findProject(ref)).root;
      } catch {
        /* not made yet: the projects folder's default */
      }
    }
    const tool = chatTool(want.tool, cfg());
    const provider = await o.defaultProvider(dir, null, tool);
    const ch = choicesOf(tool, provider, models);
    const d = cfg().sessionDefaults || {};
    return {
      tools: chatToolList(cfg()).map(({ id, name }) => ({ id, name })), tool, providers: providersFor(tool), provider: provider || null,
      models: ch.models, efforts: ch.efforts,
      model: tool === 'claude' && d.model && ch.models.includes(d.model) ? d.model : null, effort: d.effort && ch.efforts.includes(d.effort) ? d.effort : null,
      kinds: KINDS.map(({ id, label, say }) => ({ id, label, say })), scopes: SCOPES.map(({ id, label, say }) => ({ id, label, say })),
    };
  }

  const real = (d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return path.resolve(d);
    }
  };
  /** The name a start gives its session. */
  const titleOf = (root) => `New project ${path.basename(root)}`;
  /**
   * The open App session that sets this project up (opened by a start: its folder, and its name as the chat keeps it,
   * cut to 80 characters as a project's name of up to 100 is), or null.
   */
  const openFor = (root) => {
    const title = chatTitle(titleOf(root));
    const here = real(root);
    const cards = o.chat && typeof o.chat.cards === 'function' ? o.chat.cards() : [];
    return cards.find((x) => x.kind === 'chat' && x.title === title && x.cwd && real(x.cwd) === here) || null;
  };

  // The starts under way, by the project's real folder: a start awaits the provider and the chat's opening before its
  // session is among the open ones, so two starts sent at once (the page and `project start`, two tabs) would both find
  // none open without this.
  const starting = new Map(); // real folder → the start's promise
  const already = (ref, chat) => fail(409, `a session that sets up ${ref} is already open: continue there (to open another one all the same, start again with "again")`, 'started', { chat });
  const chatOf = (run) => run.then((r) => r.chat || null, (e) => (e.details && e.details.chat) || null);

  /** Start the session (see the header). c: cleanStart's. */
  async function start(c) {
    const p = await projectOf(c.name);
    const key = real(p.root);
    // Two sessions setting up one folder at once would write the same documents and scaffold over each other: the one
    // that is open (or being opened) is named instead (with its id, for the page to go to it), unless another is asked
    // for (again). From the last check to the mark below nothing is awaited, so no other start can come between.
    if (!c.again) {
      while (starting.has(key)) {
        const first = await chatOf(starting.get(key));
        if (first) throw already(p.ref, first);
      }
      const busy = openFor(p.root);
      if (busy) throw already(p.ref, busy.chatId);
    }
    const run = launch(p, c);
    if (!c.dryRun) {
      starting.set(key, run);
      const done = () => starting.get(key) === run && starting.delete(key);
      run.then(done, done);
    }
    return run;
  }

  /** The rest of a start, once it is the only one for its folder. */
  async function launch(p, c) {
    const tool = chatTool(c.tool, cfg());
    const provider = c.provider || (await o.defaultProvider(p.root, null, tool));
    if (!provider) throw fail(400, 'there is no provider for this coding tool yet: add one under Providers first', 'no-provider');
    if (!serves(provider, tool)) throw fail(400, 'that provider does not serve this coding tool');
    const ch = choicesOf(tool, provider, models);
    if (c.model && !modelOk(tool, c.model, ch)) throw fail(400, modelRefusal(c.model, ch));
    if (c.effort && !ch.efforts.includes(c.effort)) throw fail(400, `the effort must be one of: ${ch.efforts.join(', ')}`);
    const def = o.defaults ? o.defaults() : defaultsFile();
    // Left out: as the project was made (its first decision), so a later start never turns a set-up only into more.
    const kind = c.kind || p.kind || null;
    const scope = c.scope || p.scope || null;
    const text = `${startMark(path.basename(p.root))}\n${firstMessage({ brief: p.brief, kind, scope, defaults: def ? defaultsWords(p.root, def) : null })}`;
    // The names a person reads (the command line's line says them): the coding tool's and the provider's own.
    const toolName = (chatToolList(cfg()).find((x) => x.id === tool) || { name: tool }).name;
    const providerLabel = (providersFor(tool).find((x) => x.name === provider) || { label: provider }).label;
    const would = { project: p.ref, tool, toolName, provider, providerLabel, model: c.model || null, effort: c.effort || null, kind, scope, text };
    if (c.dryRun) return { dryRun: true, would };
    const opened = await o.chat.open({ dir: p.root, tool, profile: provider, title: titleOf(p.root), ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), text, defaults: true });
    if (!opened.sent) throw fail(409, `the session opened, but its first message did not go: ${opened.why || 'unknown'}`, 'not-sent', { chat: opened.id });
    const { text: _sent, ...said } = would;
    return { chat: opened.id, ...said };
  }

  return { choices, start };
}

// ---------- the command token ----------

/** Make the command token anew (at every start of the dashboard). */
export function writeCommandToken() {
  const token = `hpc_${crypto.randomBytes(32).toString('hex')}`;
  const file = commandTokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  replaceFile(tmp, file);
  return token;
}

/** The command token as the file has it, or null. */
export function readCommandToken() {
  try {
    const t = fs.readFileSync(commandTokenFile(), 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

const dropCommandToken = (mine) => {
  if (mine && readCommandToken() === mine) fs.rmSync(commandTokenFile(), { force: true });
};

const tokenOk = (given, mine) => {
  const m = /^(hpc_[0-9a-f]{64})$/.exec(String(given || ''));
  return !!(m && mine && m[1].length === mine.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(mine)));
};

// ---------- the feature ----------

/** The answer of a refused route: its own sentence for a known refusal, never a system message. */
const plainError = (e) => (Number.isInteger(e.status) ? e : fail(500, 'the session could not be started because of an error on this computer; the dashboard\'s log has the details'));

/**
 * The defaults file as the first message names it: relative to the project, with `/` between its parts on every system,
 * as the message names the skill's file (Windows' path.relative gives a backslash). `p`: path, or path.win32 in a test.
 */
export const defaultsWords = (root, file, p = path) => p.relative(root, file).split(p.sep).join('/');

/**
 * The server feature (server.mjs features list). opts: { chat (the chat feature; without it there is no start),
 * starter (a stand-in, tests), findProject, defaults }.
 */
export function newProjectFeature(sctx, opts = {}) {
  const find = opts.findProject || (async (ref) => (await import('../workspace/where.mjs')).projectDirFor(ref, { projects: projectsDir() }));
  const starter = opts.starter || (opts.chat ? projectStarter({ config: sctx.config, chat: opts.chat, defaultProvider: sctx.defaultProvider, findProject: find, defaults: opts.defaults }) : null);
  let token = null;
  const notHere = () => fail(409, 'this dashboard cannot open App sessions', 'no-chat');
  // A session that builds a project is the owner's to start: Tia's token is refused (her tools are her door's).
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'starting a new project\'s session is the owner\'s only');
  };
  const routes = [
    ['GET', /^\/api\/pcsetup\/project\/start$/, async (req, m, q) => {
      ownerOnly(req);
      if (!starter) throw notHere();
      const name = q.get('name') || '';
      if (name && !REF_RE.test(name)) throw fail(400, 'that is not a project name');
      const tool = q.get('tool') || undefined;
      if (tool !== undefined && !/^[a-z]{1,20}$/.test(tool)) throw fail(400, 'that is not a coding tool');
      return starter.choices(name || null, { tool });
    }],
    ['POST', /^\/api\/pcsetup\/project\/start$/, async (req) => {
      ownerOnly(req);
      if (!starter) throw notHere();
      return starter.start(cleanStart(await sctx.readJson(req)));
    }],
  ];
  return {
    name: 'newproject',
    routes: routes.map(([method, re, fn]) => [method, re, async (...a) => {
      try {
        return await fn(...a);
      } catch (e) {
        throw plainError(e);
      }
    }]),
    async handle(req, res) {
      if (req.method !== 'POST' || String(req.url).split('?')[0] !== COMMAND_PATH) return false;
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (!tokenOk(req.headers && req.headers[COMMAND_HEADER], token)) {
        send(401, { error: 'the command token is not this dashboard\'s: run the command again' });
        return true;
      }
      try {
        if (!starter) throw notHere();
        send(200, await starter.start(cleanStart(await sctx.readJson(req))));
      } catch (e) {
        const p = plainError(e);
        send(p.status, { error: p.message, ...(p.details ? p.details : {}) });
      }
      return true;
    },
    start() {
      if (!starter) return;
      try {
        token = writeCommandToken();
      } catch {
        token = null; // `--start` then says the dashboard did not take it; the page works as before
      }
    },
    close() {
      dropCommandToken(token);
    },
  };
}

// ---------- the command line's side ----------

/**
 * Start the session through the dashboard that runs on this computer (`project new --start`, `project start`). c:
 * { name, kind?, scope?, tool?, provider?, model?, effort?, again? }. o: { ui, dashboard (stand-in { host, port }), fetchImpl,
 * address(base) → the page's address, for the line that says where it is }. → exit code.
 */
export async function startCommand(c, { ui, dashboard, fetchImpl = fetch } = {}) {
  const d = dashboard || runningDashboard();
  const token = readCommandToken();
  const later = `hoprig project start ${c.name}${c.kind ? ` --kind ${c.kind}` : ''}${c.scope ? ` --scope ${c.scope}` : ''}`;
  if (!d || !token) {
    ui.line('warn', `no session started: the dashboard is not running here, and it is the dashboard that opens the session. Start it (hoprig serve), then: ${later}`);
    return 1;
  }
  const host = ['0.0.0.0', '::', ''].includes(d.host) ? '127.0.0.1' : d.host.includes(':') ? `[${d.host}]` : d.host;
  const body = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  let res;
  let data;
  try {
    res = await fetchImpl(`http://${host}:${d.port}${COMMAND_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [COMMAND_HEADER]: token }, body: JSON.stringify(body) });
    data = await res.json();
  } catch {
    ui.line('warn', `no session started: the dashboard did not answer. Is it running (hoprig serve)? Then: ${later}`);
    return 1;
  }
  if (!res.ok) {
    if (data.code === 'started' && data.chat) {
      ui.line('warn', `no session started: a session that sets up ${c.name} is already open: http://${host}:${d.port}/#/chat/${encodeURIComponent(data.chat)}`);
      ui.note(`continue there; to open another one all the same: ${later} --again`);
      return 1;
    }
    ui.line('fail', `no session started: ${data.error || 'the dashboard refused it'}`);
    return 1;
  }
  ui.line('ok', `a session started in the App (${data.toolName || data.tool}, ${data.providerLabel || data.provider}${data.model ? `, ${data.model}` : ''}): its first message names the new-project skill and carries your brief`);
  ui.note(`open it on the dashboard: http://${host}:${d.port}/#/chat/${data.chat}  (Home lists it too). Answer its one message there.`);
  return 0;
}
