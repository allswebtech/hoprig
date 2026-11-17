// The automations as a server feature (see the header of src/server/server.mjs): built from the server's `ctx`,
// it returns { name, routes, start, close }. Routes use the server's own form, [method, path regex, handler(req,
// match, query)] → JSON, behind its login and same-origin checks. Errors carry `status` (400 for a refused value,
// 404 for something that is not there).
//
//   GET  /api/automation                     settings, schedules with their next run, queue sizes
//   POST /api/automation/settings            { <section>: { key: value }, paused? }   (see ./settings.mjs)
//   GET  /api/automation/log?limit=100       the activity log, newest first
//   GET  /api/automation/queue/<session>     { paused, items: [{ id, text, addedAt }] }
//   POST /api/automation/queue/<session>     { op: 'add', text, position? } | { op: 'remove', id }
//                                            | { op: 'move', id, to } | { op: 'pause', paused } | { op: 'clear' }
//   POST /api/automation/schedules           { op: 'add', schedule } | { op: 'change', id, schedule } | { op: 'delete', id }
//
// Settings → Updates (./updater.mjs; the old /api/claude routes stay for older pages and other computers):
//   GET  /api/updates                        { mode, notify, running, items: [row] }
//   POST /api/updates/check                  { id? }: look again now (one item, or all)
//   POST /api/updates/settings               { mode?: 'manual' | 'auto', notify?: bool, itemModes?: { <id>: 'manual' | 'auto' | null } }
//   POST /api/updates/run                    { id: <item> | 'all' }: update (or install) in the background
//   GET  /api/updates/log?from=N             the output of the update that runs or ran last
//
// `serverAdapter` turns the server's ctx into the one the automations need (./index.mjs): the session cards with
// the run record fields they read (stopAt, failure, attentionKind, carryArgs), starting a session under a wished
// name with the launcher's arguments, typing into a session by name.
import path from 'node:path';
import { getAutoSwitch } from '../autoswitch.mjs';
import { assertServes, readProfile } from '../profiles.mjs';
import { chatToolList } from '../chat/tools.mjs';
import { listRuns } from '../runs.mjs';
import { launchArgv } from '../server/deck.mjs';
import { insideRoots, resolveRoots } from '../server/folders.mjs';
import { createAutomation } from './index.mjs';

const BODY_MAX = 64 * 1024; // a 32 KiB message plus JSON escaping
const SESSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function readJson(req, max = BODY_MAX) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw fail(413, 'that is too large');
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw fail(400, 'send a JSON object');
  }
}

/** "auto" is not a profile file: the launcher builds it from the Auto mode settings. */
const profileObject = (name) => (name === 'auto' ? { name: 'auto', env: {} } : readProfile(name));

/** The automation ctx (see ./index.mjs) made from the server's feature ctx. */
export function serverAdapter(sctx, { log = console.log, chat = null } = {}) {
  return {
    deck: {
      async list() {
        const st = await sctx.state();
        const runs = new Map(listRuns().map((r) => [r.runId, r]));
        return st.sessions.map((c) => {
          const r = c.runId ? runs.get(c.runId) : null;
          if (!r) return c;
          return { ...c, stopAt: r.stopAt || null, failure: r.failure || null, attentionKind: r.attentionKind || null, carryArgs: Array.isArray(r.carryArgs) ? r.carryArgs : [] };
        });
      },
      async start({ dir, profile, mode = 'new', sessionId = null, carryArgs = [], name = null, fresh = false }) {
        const p = profileObject(profile);
        if (!p) throw new Error(`there is no provider "${profile}"`);
        // Checked again when it runs (a schedule was saved earlier): the provider must still serve Claude Code, which
        // this starts, and Auto mode must still be on.
        if (p.name === 'auto' && getAutoSwitch().enabled !== true) throw new Error('Auto mode is off: choose a provider for this schedule');
        if (p.name !== 'auto') assertServes(p, 'claude');
        const argv = launchArgv(sctx.deck.launcher(), { profile: p, mode, sessionId, carryArgs, fresh });
        // A start on a conversation is noted for the moment before its launcher's record (deck.mjs create).
        const go = async () => ({ name: await sctx.deck.create({ base: name || path.basename(dir), dir, argv, conversation: sessionId }) });
        if (!sessionId || !chat) return (await go()).name;
        // One conversation, one process: a conversation that a chat or a terminal runs already is not started again
        // (a message sent right after a restart, before this terminal reports it, must find it too). A fresh start
        // under the id of a conversation nobody typed into goes through the same claim.
        const r = await chat.startTerminal(sessionId, go);
        if (r.existing) {
          // Read on Automations → Activity. A terminal outside the dashboard has no name here.
          const where = r.existing.chat ? 'a chat' : r.existing.terminal.name ? `the terminal session "${r.existing.terminal.name}"` : 'a terminal outside the dashboard';
          throw Object.assign(new Error(`${where} runs its conversation now`), { existing: r.existing });
        }
        return r.name;
      },
      async send(name, text) {
        const found = await sctx.deck.find(name);
        if (!found) throw new Error('the session is gone');
        await sctx.deck.send(found.term.id, text);
      },
      kill: (name) => sctx.backend.kill(name),
      // A chat (src/chat): its feature opens it as the page does, with Settings' New-session defaults (as a terminal
      // a schedule starts), not the folder's last chat: nobody watches a scheduled chat as it starts.
      ...(chat ? {
        // The chat's own checks run here too: the coding tool is on, and the provider still serves it.
        startChat: async ({ dir, profile, text, tool }) => (await chat.open({ dir, profile, ...(tool ? { tool } : {}), ...(text ? { text } : {}), defaults: true })).id,
        sendChat: (id, text) => chat.send(id, text),
      } : {}),
    },
    // A provider as the owner named it (the activity log is read by a person); Auto mode is no profile file.
    label: (name) => (name === 'auto' ? 'Auto mode' : (readProfile(name) || {}).label || name),
    backend: sctx.backend,
    config: sctx.config,
    saveConfig: sctx.saveConfig,
    notify: (ev) => {
      Promise.resolve(sctx.notify({ ...ev, status: 'automation', url: '' })).catch(() => {});
    },
    log,
    checks: {
      dirOk: (d) => Boolean(insideRoots(d, resolveRoots(sctx.config().server.roots))),
      // A schedule starts a coding tool (Claude Code in a terminal; a chat in its tool): a provider that does not
      // serve it says why.
      profileOk: (p, tool = 'claude') => {
        if (p === 'auto') return tool === 'claude' && getAutoSwitch().enabled === true;
        const prof = readProfile(p);
        if (prof) assertServes(prof, tool);
        return Boolean(prof);
      },
      // A chat's coding tool: one a chat runs on this computer (on, installed, with a chat).
      chatToolOk: (tool) => chatToolList(sctx.config()).some((t) => t.id === tool),
    },
  };
}

/** Only the named keys may be present. */
function only(b, keys) {
  for (const k of Object.keys(b)) if (!keys.includes(k)) throw fail(400, `"${k}" is not expected here`);
}

const QUEUE_KEYS = { add: ['op', 'text', 'position'], remove: ['op', 'id'], move: ['op', 'id', 'to'], pause: ['op', 'paused'], clear: ['op'] };
const SCHEDULE_KEYS = { add: ['op', 'schedule'], change: ['op', 'id', 'schedule'], delete: ['op', 'id'] };

const sessionOf = (m) => {
  const name = decodeURIComponent(m[1]);
  if (!SESSION_RE.test(name)) throw fail(400, 'bad session name');
  return name;
};

/** A refused value from the validators is the owner's to read: a 400 with the plain message. */
const asBad = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    throw Number.isInteger(e.status) ? e : fail(400, e.message);
  }
};

/**
 * The feature. `opts.tick` false: no timer (tests drive tick() by hand). `opts.ctx`: a ready automation ctx
 * instead of the server adapter, `opts.now`: a clock (tests), `opts.updateItems`: stand-ins for Settings → Updates (demo, tests),
 * `opts.log`: where the automations' lines go (default: the server's output; the demo keeps them in its log file).
 */
export function automationFeature(sctx, opts = {}) {
  let auto = null;
  const live = () => {
    if (!auto) throw fail(503, 'automations are not running');
    return auto.api;
  };
  const updater = () => {
    if (!auto) throw fail(503, 'automations are not running');
    return auto.updater;
  };
  const ITEM_RE = /^[a-z][a-z0-9-]{0,30}$/;
  const itemOf = (v, all = false) => {
    if (typeof v !== 'string' || !(ITEM_RE.test(v) || (all && v === 'all'))) throw fail(400, 'say which one to update');
    return v;
  };
  const routes = [
    ['GET', /^\/api\/automation$/, async () => live().status()],
    ['GET', /^\/api\/updates$/, async () => updater().view()],
    ['POST', /^\/api\/updates\/check$/, async (req) => {
      const b = await readJson(req);
      only(b, ['id']);
      return updater().view({ fresh: true, id: b.id === undefined ? null : itemOf(b.id) });
    }],
    ['POST', /^\/api\/updates\/settings$/, async (req) => {
      const b = await readJson(req);
      return asBad(() => ({ settings: updater().changeSettings(b) }));
    }],
    ['POST', /^\/api\/updates\/run$/, async (req) => {
      const b = await readJson(req);
      only(b, ['id']);
      return updater().start(itemOf(b.id, true));
    }],
    ['GET', /^\/api\/updates\/log$/, async (req, m, q) => updater().log(Number(q && q.get('from')) || 0)],
    ['POST', /^\/api\/automation\/settings$/, async (req) => {
      const b = await readJson(req);
      return asBad(() => ({ settings: live().changeSettings(b) }));
    }],
    ['GET', /^\/api\/automation\/log$/, async (req, m, q) => {
      const n = Math.max(1, Math.min(500, Number(q && q.get('limit')) || 100));
      return { entries: live().log(n) };
    }],
    ['GET', /^\/api\/automation\/queue\/([^/]+)$/, async (req, m) => live().queueOf(sessionOf(m))],
    ['POST', /^\/api\/automation\/queue\/([^/]+)$/, async (req, m) => {
      const name = sessionOf(m);
      const b = await readJson(req);
      if (!QUEUE_KEYS[b.op]) throw fail(400, 'op must be add, remove, move, pause or clear');
      only(b, QUEUE_KEYS[b.op]);
      return asBad(() => live().changeQueue(name, b.op, b));
    }],
    ['POST', /^\/api\/automation\/schedules$/, async (req) => {
      const b = await readJson(req);
      if (!SCHEDULE_KEYS[b.op]) throw fail(400, 'op must be add, change or delete');
      only(b, SCHEDULE_KEYS[b.op]);
      return asBad(() => ({ schedules: live().changeSchedules(b.op, b) }));
    }],
  ];
  return {
    name: 'automation',
    routes,
    get automation() {
      return auto;
    },
    start() {
      auto = createAutomation(opts.ctx || { ...serverAdapter(sctx, { chat: opts.chat, ...(opts.log ? { log: opts.log } : {}) }), ...(opts.now ? { now: opts.now } : {}), ...(opts.updateItems ? { updateItems: opts.updateItems } : {}) });
      if (opts.tick !== false) auto.start();
      return auto;
    },
    async close() {
      if (auto) await auto.close();
      auto = null;
    },
  };
}
