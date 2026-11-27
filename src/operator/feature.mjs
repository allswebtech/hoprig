// The operator's part of the dashboard: the board, the attention list and the owner's taps.
//
//   GET  /api/operator/attention[?look=1][&kind=k]   { at, count, items, acts, hidden, more?, watched, timeline }: the ranked
//                                           list (look=1: the panel was just opened, for "changed since his last look")
//   GET  /api/operator/board                the board in short (publicBoard)
//   POST /api/operator/act                  { item, act, seen }: do the act the owner tapped → { ok, result, item? }
//   GET  /api/operator/settings             the reflexes: the master switch, each rule with its budget left (reflex.mjs)
//   POST /api/operator/settings             { acts?, rules?, budgets?, project? }: the owner's change (rules.mjs)
//   POST /api/operator/off                  "Tia OFF": no new act of hers starts; the one in flight ends first
//   POST /api/operator/undo                 { id }: move back a session the limit rule moved
//
// The four writes are the owner's, from his own page only: not another computer, not Tia (her door refuses them too).
// A rule's act (reflex.mjs) goes through `perform`, the very function behind the owner's tap, with its own checks added.
//
// A tap is done only from the owner's own page (not by another computer, not by Tia: this slice gives her no act).
// The server builds the list again before it acts: an item that is gone or changed since `seen` (its rev) is refused
// with the current item, an act that is not one of the item's is refused with the allowed ones, and the same tap twice
// does the act once. Every act goes through a function the product already has behind its own checks. Every tap
// writes one JSON line to <state>/operator/timeline.jsonl (time, item, act, result; nothing secret).

import fs from 'node:fs';
import path from 'node:path';
import { stateDir, tilde } from '../paths.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { projectFolders } from '../workspace/groups.mjs';
import { readMap } from '../workspace/map.mjs';
import { reflexes } from './reflex.mjs';
import { RULES, applyOperatorPatch } from './rules.mjs';
import { KIND_SOURCES, attention, publicAttention } from './attention.mjs';
import { boardCache, buildBoard, publicBoard } from './board.mjs';
import { KINDS, allowedActs, itemId, publicItem } from './item.mjs';
import { defaultActs, defaultSources } from './sources.mjs';
import { ANSWERS, HOLD_MINUTES, NUDGE, decorate } from './decide-table.mjs';
import { asksAdapter } from './decide-asks.mjs';
import { decider } from './decider.mjs';
import { applyDecidePatch, cleanNote, heldBy, heldUntil, liftHold, mayEndFor, setHold } from './decide-store.mjs';
import { elsewhereOf, endElsewhere, readElsewhere, setElsewhere } from './where-hold.mjs';
import { applyLookPatch, looks as lookPart } from './look.mjs';
import { applyCorrectionsPatch, correctionCounts, forgetCorrections, noteCorrection, readCorrections, writeEvidence } from './corrections.mjs';
import { replaceFile } from '../replacefile.mjs';
import { createActivityLog } from '../automation/store.mjs';

const TAP_KEEP_MS = 60_000;
const TIMELINE_SHOWN = 30;
const TIMELINE_MAX_BYTES = 256 * 1024;
const ROUND_MS = 20_000; // a round of the rules at most this often (the slow checks behind them run once a minute)

// A line of Tia's says no path and no address: an act's error can name them, and the timeline is kept and shown. Every
// slash and scheme starts one, also one glued to a word ("dir/home/…"). The one name with a slash a line of hers may
// say is the ref of a project she names herself ("kits/shop", `keep`): it is kept by its exact text, nothing like it.
const PATH = /(?:[a-z][a-z0-9+.-]*:\/\/|~?\/)[^\s'"]+/gi;
const ADDRESS = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const plain = (s, keep = []) => {
  const refs = [].concat(keep).filter((k) => typeof k === 'string' && k && !/^(?:~?\/|[a-z][a-z0-9+.-]*:)/i.test(k));
  // A NUL is taken out first: the refs are held by NUL-numbered marks while the paths are hidden, and a mark that
  // came with the text would be swapped for a ref, or for nothing.
  let out = String(s ?? '').replace(/\u0000/g, '');
  refs.forEach((k, i) => { out = out.split(k).join(`\u0000${i}\u0000`); });
  out = out.replace(PATH, '…').replace(ADDRESS, '…');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => refs[Number(i)]);
};

const dir = () => path.join(stateDir(), 'operator');
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  replaceFile(tmp, file);
};

/** The timeline: one JSON line per tap, the newest last; cut to its newest half when it grows too big. */
export function timeline({ file = () => path.join(dir(), 'timeline.jsonl') } = {}) {
  const FREE = new Set(RULES.filter((r) => r.cost === 'none').map((r) => r.id));
  return {
    add({ keep, ...raw }) {
      const line = raw.by ? { ...raw, result: plain(raw.result, keep) } : raw;
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.appendFileSync(file(), `${JSON.stringify(line)}\n`);
      // A mend that costs nothing and worked is also one line in Activity: with Tia off her tab is hidden, and this is where he sees it.
      if (FREE.has(raw.by) && raw.ok !== false && !raw.refused) createActivityLog(path.join(path.dirname(path.dirname(file())), 'automation.log')).add({ automation: 'mend', did: `Mended: ${line.result}`, outcome: 'ok' });
      try {
        if (fs.statSync(file()).size > TIMELINE_MAX_BYTES) {
          const lines = fs.readFileSync(file(), 'utf8').trim().split('\n');
          fs.writeFileSync(file(), `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
        }
      } catch {
        /* the next tap tries again */
      }
    },
    last(n = TIMELINE_SHOWN, keep = () => true) {
      let text = '';
      try {
        text = fs.readFileSync(file(), 'utf8');
      } catch {
        return [];
      }
      return text.trim().split('\n').reverse().map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter((l) => l && keep(l)).slice(0, n);
    },
  };
}

const short = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
/**
 * The main repository of the linked worktree `dir` is in (it or a folder above it holds a .git FILE that says
 * "gitdir: <main>/.git/worktrees/<name>"), or null. Only that file is read: no git program runs for it.
 */
function mainRepoOf(dir) {
  for (let d = dir, i = 0; i < 12; i++) {
    const g = path.join(d, '.git');
    let st = null;
    try {
      st = fs.lstatSync(g);
    } catch { /* none here: the folder above */ }
    if (st?.isDirectory()) return null; // a repository of its own
    if (st?.isFile()) {
      let text = '';
      try {
        const fd = fs.openSync(g, 'r');
        const buf = Buffer.alloc(4096);
        text = buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)).toString('utf8');
        fs.closeSync(fd);
      } catch {
        return null;
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      const gitdir = m ? path.resolve(d, m[1]) : null;
      const at = gitdir ? gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`) : -1;
      return at > 0 ? gitdir.slice(0, at) : null;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** The first folder name of `dir` under `root`, or null when `dir` is not under it. */
const firstUnder = (root, dir) => {
  const rel = path.relative(root, dir);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep)[0];
};

/**
 * `sources`: the board's sources (tests pass made-up ones; else the product's own, sources.mjs). `session`: how a
 * session is moved to another provider and stopped (the server's own functions, passed in by server.mjs). `acts`:
 * the other acts (tests pass stand-ins).
 */
export function operatorFeature(ctx, { sources = null, session = {}, acts = {}, now = Date.now, cacheMs, timeoutMs = 4000, accounts = null, keepLeftover, gateways = null, asks = asksAdapter(), turn, rooms = null, work = null, lookModel } = {}) {
  const fail = (status, message, details) => Object.assign(new ctx.HttpError(status, message), details ? { details } : {});
  const looks = () => readJson(path.join(dir(), 'looks.json'), { prev: null, current: null });
  const dismissedFile = () => path.join(dir(), 'dismissed.json');
  const dismissed = () => new Map(Object.entries(readJson(dismissedFile(), {})));
  // A nudge is given once per stretch without progress: the session → when its stretch began (the stuck item's since).
  const nudgedFile = () => path.join(dir(), 'nudged.json');
  const nudged = (name, since) => readJson(nudgedFile(), {})[name] === since;
  const line = timeline();
  let port = null; // the port and address this dashboard answers on, as its own requests show them
  let address = null;
  // `gateways`: the add-ons the look checks (the demo's pretend one); by default the computer's own (gatewayAddons).
  const own = sources ? null : defaultSources(ctx, { port: () => port, address: () => address, now, keepLeftover, rooms, ...(gateways ? { gateways } : {}) });
  const src = sources || own.sources;
  const doer = { ...defaultActs({ now, gateways, start: session.start }), ...acts };

  const cache = boardCache((t) => buildBoard(src, { now: t, timeoutMs, extra: { port, lastLook: looks().prev, ...(rooms ? elsewhereOf({ view: rooms(), computers: ctx.config().assistant?.computers, held: readElsewhere(now(), { computers: ctx.config().assistant?.computers ?? null }) }) : {}) } }), { ttlMs: cacheMs, clock: now });

  // The list of a board; a put-off item that is no longer there is forgotten, so when the same thing comes back it is
  // shown again. Only the sources its own kind reads count: when one of those could not be read, the look cannot tell
  // whether it went away, and a source of another kind that fails (on some systems one always does) changes nothing.
  const listOf = (board) => {
    const d = dismissed();
    const l = attention(board, { now: now(), dismissed: d, decorate: (all) => decorate(all, board, { now: now(), nudged, card: (n) => asks.card(n), alone: (t) => (asks.alone ? asks.alone(t) : 'not wired') }) });
    const unread = new Set(board.watched.filter((w) => !w.ok && w.at).map((w) => w.source));
    const told = (id) => KIND_SOURCES[id.split('-')[0]]?.every((n) => !unread.has(n)) ?? false;
    const gone = [...d.keys()].filter((id) => !l.present.has(id) && told(id));
    if (gone.length) {
      const keep = readJson(dismissedFile(), {});
      for (const id of gone) delete keep[id];
      writeJson(dismissedFile(), keep);
    }
    l.board = board;
    return l;
  };
  const list = async () => listOf(await cache.get());
  const fresh = async () => {
    cache.forget();
    return list();
  };

  // A tap in flight or just done, by item, act and the rev it was made on: the same tap again gets the same answer.
  const taps = new Map();
  // An entry later than now (the clock was set back) is old too: else it would answer for up to that long.
  const forgetOld = () => {
    for (const [k, v] of taps) if (now() - v.at > TAP_KEEP_MS || v.at > now()) taps.delete(k);
  };

  // `by`: 'owner' for his tap, 'tia' for a rule's or a decision's act (perform with a guard).
  async function act(item, id, by) {
    const t = item.target || {};
    switch (id) {
      case 'open':
      case 'open-commit':
        return { href: item.acts.find((a) => a.id === id)?.href || null };
      case 'wait': // the limit ends soon: the item is hidden until it changes, as "Not now"
      case 'dismiss': {
        const d = readJson(dismissedFile(), {});
        d[item.id] = item.rev;
        writeJson(dismissedFile(), d);
        return { hidden: true };
      }
      case 'switch':
        if (!session.move) throw fail(409, 'moving a session is not possible here');
        await session.move(t.session, t.to);
        return { moved: t.to };
      case 'stop':
        if (!session.stop) throw fail(409, 'stopping a session is not possible here');
        await session.stop(t.session);
        return { stopped: true };
      case 'nudge': {
        if (!session.nudge) throw fail(409, 'typing into a session is not possible here');
        await session.nudge(t.session, NUDGE);
        writeJson(nudgedFile(), { ...readJson(nudgedFile(), {}), [t.session]: item.since });
        return { did: 'nudged it once' };
      }
      case 'hold': {
        const until = now() + HOLD_MINUTES * 60_000;
        setHold(until, now(), by);
        return { did: `no new session or chat starts for ${HOLD_MINUTES} min` };
      }
      case 'elsewhere': {
        const h = setElsewhere(t.to, t.label, now(), by);
        return { did: `Tia's new work starts on ${h.label} until this computer is calm (since ${new Date(h.since).toISOString().slice(11, 16)} UTC)` };
      }
      case 'note':
        await asks.answer(t.session, { note: true });
        return { did: 'answered with your Hands-off note' };
      case 'end':
        return doer.end(t);
      case 'sync':
        return doer.sync(t);
      case 'push':
        return doer.push(t);
      case 'restart-link':
        return doer.restartLink(t);
      case 'restart-gateway':
        return doer.restartGateway(t);
      case 'reopen':
        return doer.reopen(t);
      case 'clean':
        return doer.clean(t);
      default:
        if (ANSWERS.includes(id)) {
          const option = ANSWERS.indexOf(id) + 1;
          await asks.answer(t.session, { option });
          return { did: `answered with option ${option}` };
        }
        throw fail(400, 'there is no such act');
    }
  }

  /**
   * The one way an act is done, for the owner's tap and for a rule's: the list is built again, the item must still be
   * there with the rev it was seen with, the act must be one of its own, and the same act on the same rev twice is
   * done once. `guard(item, list)`: a rule's own checks on the item as it is now (they throw a refusal); `extra(ok)`:
   * what the rule adds to the line (who did it, what can be undone).
   */
  async function perform(b, { guard = null, extra = () => ({}) } = {}) {
    forgetOld();
    const key = `${b.item}|${b.act}|${b.seen}`;
    // The owner's tap shares a rule's act only while it is in flight (done once); a rule's FINISHED act on the same rev
    // did not make the item go away, so his tap does the act again.
    const prior = taps.get(key);
    if (prior && !(prior.rule && prior.done && !guard)) {
      try {
        return { ...(await prior.answer), again: true };
      } catch (e) {
        // A rule's act that its own checks refused was never done: the owner's tap of the same is done now.
        if (!e.refusal || guard) throw e;
      }
    }
    const entry = { at: now(), answer: null, rule: !!guard, done: false };
    entry.answer = (async () => {
      const l = await fresh();
      const it = l.items.find((i) => i.id === b.item) ?? null;
      if (!it) throw fail(409, 'that item is gone: what it said is no longer so', { current: null });
      if (it.rev !== b.seen) throw fail(409, 'that item changed since you saw it: look at it again', { current: publicItem(it) });
      const allowed = allowedActs(it);
      if (!allowed.includes(b.act)) throw fail(400, `that act is not one of this item's: ${allowed.join(', ')}`, { allowed });
      if (guard) await guard(it, l);
      let result;
      try {
        result = await act(it, b.act, guard ? 'tia' : 'owner');
      } catch (e) {
        line.add({ at: new Date(now()).toISOString(), item: it.id, kind: it.kind, subject: it.subject, act: b.act, ok: false, result: short(e.message), ...extra(false) });
        throw e;
      } finally {
        // The slow check behind the item reads again (what was there may be gone now, also after a refusal), and the
        // board is built again on the next look.
        await own?.after(b.act).catch(() => {});
        cache.forget();
      }
      line.add({ at: new Date(now()).toISOString(), item: it.id, kind: it.kind, subject: it.subject, act: b.act, ok: true, result: short(describe(result)), ...extra(true) });
      return { ok: true, act: b.act, result, said: `${it.subject}: ${short(describe(result))}` };
    })();
    taps.set(key, entry);
    entry.answer.then(() => (entry.done = true), () => {});
    try {
      return await entry.answer;
    } catch (e) {
      if (taps.get(key) === entry) taps.delete(key); // a refusal is not remembered: the owner may tap again on the current item
      throw e;
    }
  }

  async function tap(req) {
    // Only the owner's own page taps: not another computer with its token, not Tia's door.
    if (ctx.caller(req) !== 'page') throw fail(403, 'only the owner taps an act, from the dashboard\'s page');
    const b = await ctx.readJson(req);
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['item', 'act', 'seen'].includes(k))) throw fail(400, 'send { item, act, seen }');
    if (typeof b.item !== 'string' || !/^[a-z]+-[0-9a-f]{12}$/.test(b.item)) throw fail(400, 'item: the id of an item of the list');
    if (typeof b.act !== 'string' || !/^[a-z-]{1,20}$/.test(b.act)) throw fail(400, 'act: the id of one of the item\'s acts');
    if (typeof b.seen !== 'string' || !/^[0-9a-f]{12}$/.test(b.seen)) throw fail(400, 'seen: the rev of the item as you saw it');
    const seen = (await list()).items.find((i) => i.id === b.item);
    const r = await perform(b);
    // He picked another step than the one recommended: one correction of that kind of decision (never "Not now").
    if (seen && b.act !== seen.recommended && b.act !== 'dismiss') noteCorrection(ctx.config(), { kind: 'other-answer', about: { decision: seen.kind } }, now());
    rx.forget(b.item); // he tapped it: a rule that tried twice on it may try again later
    return r;
  }

  // ---- the reflexes: the owner's standing rules (reflex.mjs) ----
  // The project a folder belongs to: its name, null when it is in none, undefined when that cannot be told. A process's
  // folder (/proc/<pid>/cwd) and a session's are real paths, while the projects folder (or a folder above it) may be a
  // link: both are compared as written and as real paths. A folder whose real path cannot be read is not known.
  // A linked worktree (a Work run's, kept under <state>/work-trees, or one the owner made anywhere) belongs to the
  // project of the repository it was made from: its .git file names that repository. A folder under work-trees whose
  // repository cannot be told is not known.
  // A project is named by its ref, as the map and every command name it: <name> in the projects folder, <place>/<name>
  // in a group of the workspace map (projectFolders): two projects of one name in two places are two projects.
  const folders = () => projectFolders(readMap().map, { dir: workspaceDir(ctx.config()), projects: projectsIn(ctx.config()) });
  const projectOf = (folder) => {
    const root = path.resolve(projectsIn(ctx.config()));
    const dir = path.resolve(String(folder));
    const realDir = realOr(dir);
    const grouped = folders().filter((f) => f.place);
    const inGroup = (d) => grouped.find((f) => [f.dir, realOr(f.dir)].some((g) => g && (d === g || d.startsWith(g + path.sep))))?.ref ?? null;
    const inRoot = (d) => inGroup(d) ?? firstUnder(root, d) ?? firstUnder(realOr(root) || root, d);
    const name = inGroup(dir) ?? firstUnder(root, dir) ?? (realDir ? inRoot(realDir) : null);
    if (name) return name;
    const main = realDir ? mainRepoOf(realDir) : null;
    if (main) return inRoot(main) ?? inRoot(realOr(main) || main);
    const trees = path.join(stateDir(), 'work-trees');
    if (firstUnder(trees, dir) || (realDir && firstUnder(realOr(trees) || trees, realDir))) return undefined;
    return realDir ? null : undefined;
  };
  const accountsNow = accounts || (async () => {
    const st = await ctx.state();
    return { profiles: st.profiles || [], autoSwitch: st.autoSwitch || {} };
  });
  const rx = reflexes({ ctx, perform, fresh, peek: list, line, dir, now, accounts: accountsNow, projectOf, move: async (name, to) => {
    if (!session.move) throw fail(409, 'moving a session is not possible here');
    await session.move(name, to);
    cache.forget();
  } });
  rx.start();
  const dc = decider({ ctx, rx, dir, now, accounts: accountsNow, asks, line, ...(turn ? { turn } : {}) });
  // A look into what nobody can explain (look.mjs): through Work's door for her sessions; off unless he turned it on.
  const lk = lookPart({ ctx, runner: () => (work && work()) || { start: () => { throw fail(409, 'Work is not on this dashboard'); } }, accounts: accountsNow, now, dir, ...(lookModel ? { model: lookModel } : {}) });
  let lookTick = null;
  let lastRound = -Infinity;
  let looking = null; // the decisions' look in flight: started by a tick, never awaited by it
  const unsubscribe = ctx.onTick ? ctx.onTick(async () => {
    if (own) await own.tick();
    // A last round later than now (the clock was set back) holds nothing back: else no round runs until the clock passes it.
    const since = now() - lastRound;
    if (!(since >= 0 && since < ROUND_MS)) {
      lastRound = now();
      await rx.round().catch(() => {});
    }
    // "Tia decides": only while it is on, on every tick (a new rev must hold a few seconds, decider.mjs), and a call
    // only for an item whose rev is new. Off: not even the list is built for it. The look is started, not awaited: the
    // watcher waits for this listener before its next tick, and a model call takes seconds, so the limits,
    // notifications and follow-ups of every session would wait for her. A tick while one runs starts no second one.
    if (dc.enabled() && !looking) {
      looking = fresh().then((l) => dc.look(l)).catch(() => {}).finally(() => {
        looking = null;
      });
    }
    // A look: only while its switch is on (and Tia acts by herself); off, not even the list is built for it, and only
    // what a lost look left is removed (look.mjs clear).
    if (!lookTick) {
      lookTick = (lk.enabled() ? fresh().then((l) => lk.tick(l)) : lk.clear()).catch(() => {}).finally(() => {
        lookTick = null;
      });
    }
  }) : null;
  const ownerOnly = (req, what) => {
    if (ctx.caller(req) !== 'page') throw fail(403, `${what} is the owner's, from the dashboard's page`);
  };
  const projectNames = () => folders().map((f) => f.ref);
  // The rules' view with "Tia decides" beside it: while it is on, the sentence over the panel says she decides too.
  const tiaView = async () => {
    const v = rx.view();
    const decide = dc.view();
    const anyRule = v.rules.some((r) => r.on);
    const said = v.active && decide.on ? (anyRule ? `${v.said} She also decides new items by "Tia decides", within its limits.` : 'Every rule is off; she decides new items only by "Tia decides", within its limits.') : v.said;
    return { ...v, said, decide, look: await lk.view(), corrections: { ...readCorrections(ctx.config()), ...correctionCounts(now()) } };
  };
  // The lines of the timeline: the owner's (no `by`) and Tia's (by a rule, or about her record).
  const byYou = (l) => !l.by;
  const byTia = (l) => !!l.by;

  const notePort = (req) => {
    const p = req.socket?.localPort;
    if (Number.isInteger(p)) {
      port = p;
      address = req.socket.localAddress || null;
    }
  };

  const routes = [
    ['GET', /^\/api\/operator\/attention(?:\?.*)?$/, async (req) => {
      notePort(req);
      if (/[?&]look=1(?:&|$)/.test(req.url || '')) {
        const l = looks();
        writeJson(path.join(dir(), 'looks.json'), { prev: l.current, current: new Date(now()).toISOString() });
        cache.forget();
      }
      // ?kind=<kind>: only that kind, chosen before the list is cut to its first items (else a kind ranked low is lost).
      const kind = /[?&]kind=([a-z]+)(?:&|$)/.exec(req.url || '')?.[1] || null;
      if (kind && !KINDS.includes(kind)) throw fail(400, `kind: one of ${KINDS.join(', ')}`);
      const board = await cache.get();
      const l = listOf(board);
      const out = publicAttention(kind ? { ...l, items: l.items.filter((i) => i.kind === kind) } : l);
      // A look's state and finding beside each item of the kind unknown (the item itself stays small: item.mjs).
      const findings = Object.fromEntries(out.items.filter((i) => i.kind === 'unknown').map((i) => [i.id, lk.about(i.id)]).filter(([, f]) => f));
      return { ...out, findings, watched: publicBoard(board).watched, timeline: line.last(TIMELINE_SHOWN, byYou), byTia: line.last(TIMELINE_SHOWN, byTia), reflexes: await tiaView() };
    }],
    ['GET', /^\/api\/operator\/board$/, async (req) => {
      notePort(req);
      return publicBoard(await cache.get());
    }],
    ['POST', /^\/api\/operator\/act$/, async (req) => {
      notePort(req);
      return tap(req);
    }],
    ['GET', /^\/api\/operator\/settings$/, async () => tiaView()],
    ['POST', /^\/api\/operator\/settings$/, async (req) => {
      ownerOnly(req, 'a change of what Tia may do by herself');
      const raw = await ctx.readJson(req);
      // "Tia decides" (decide) and a project's standing note with its tick (note: { project, text, mayEnd }) are keys of their own; the rest
      // are the rules' (rules.mjs). Every other key of "operator" is kept as it was.
      const { decide, note, look, corrections, ...b } = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { bad: raw };
      const cur = ctx.config().operator && typeof ctx.config().operator === 'object' ? ctx.config().operator : {};
      let next;
      let cleaned = false;
      try {
        next = { ...cur, ...applyOperatorPatch(ctx.config(), b, projectNames()) };
        if (decide !== undefined) next.decide = applyDecidePatch(ctx.config(), decide);
        if (look !== undefined) next.look = applyLookPatch(ctx.config(), look);
        if (corrections !== undefined) next.corrections = applyCorrectionsPatch(ctx.config(), corrections);
        if (note !== undefined) {
          if (!note || typeof note !== 'object' || Array.isArray(note) || typeof note.project !== 'string' || Object.keys(note).some((k) => !['project', 'text', 'mayEnd'].includes(k))) throw new Error('note is { project, text, mayEnd }');
          if (note.mayEnd !== undefined && typeof note.mayEnd !== 'boolean') throw new Error('mayEnd must be true or false');
          const ref = note.project.startsWith('projects/') ? note.project.slice('projects/'.length) : note.project;
          if (!projectNames().includes(ref)) throw new Error(`there is no project "${ref.slice(0, 60)}" on this computer`);
          const c = cleanNote(note.text);
          cleaned = c.changed;
          const notes = { ...(cur.notes && typeof cur.notes === 'object' ? cur.notes : {}) };
          if (c.note) notes[ref] = c.note;
          else delete notes[ref];
          next.notes = notes;
          // "Tia may end a stuck session in this project": its own key, so the notes keep their shape. Sent with the
          // note; a body without it leaves the tick as it was.
          // A note emptied by a body without the field (an older page, an API client) takes the tick with it: the tick
          // allows a stop "when your note says when", and with no note nothing says when. The page always sends it.
          if (note.mayEnd !== undefined || !c.note) {
            const ends = { ...(cur.mayEnd && typeof cur.mayEnd === 'object' && !Array.isArray(cur.mayEnd) ? cur.mayEnd : {}) };
            if (note.mayEnd === true) ends[ref] = true;
            else delete ends[ref];
            next.mayEnd = ends;
          }
        }
      } catch (e) {
        throw fail(400, e.message);
      }
      ctx.saveConfig({ operator: next });
      if (!next.acts) await rx.off();
      return { ...(await tiaView()), ...(note !== undefined ? { note: { project: note.project, text: next.notes[note.project.replace(/^projects\//, '')] || '', mayEnd: mayEndFor({ operator: next }, note.project.replace(/^projects\//, '')), cleaned } } : {}) };
    }],
    ['POST', /^\/api\/operator\/off$/, async (req) => {
      ownerOnly(req, '"Tia OFF"');
      await ctx.readJson(req);
      lk.off(); // a look in flight ends now
      const r = await rx.off();
      // "Tia OFF stops her at once": her hold on new starts is hers too, so it goes with her. A hold he set himself stays.
      // Only her own part goes: when he also holds, his stays until his own time.
      const by = heldBy(now());
      const lifted = by === 'tia' || by === 'both';
      if (lifted) {
        liftHold('tia', now());
        line.add({ at: new Date(now()).toISOString(), item: null, kind: 'machine', subject: 'new starts', act: 'lift-hold', ok: true, result: by === 'both' ? 'Tia OFF lifted her hold; yours stays' : 'Tia OFF lifted her hold: sessions and chats start again' });
      }
      // "Start new work on <name> until this computer is calm" that his rule set is hers too: it ends with her.
      const away = readElsewhere(now());
      if (away && away.by === 'tia') {
        endElsewhere();
        line.add({ at: new Date(now()).toISOString(), item: null, kind: 'machine', subject: 'new work', act: 'elsewhere-end', ok: true, result: `Tia OFF ended it: Tia's new work starts here again (it went to ${away.label})` });
      }
      return { ...rx.view(), ...r, ...(lifted ? { said: by === 'both' ? 'Tia is off, and her hold on new starts is lifted; yours stays.' : 'Tia is off, and her hold on new starts is lifted.' } : {}) };
    }],
    ['GET', /^\/api\/operator\/note(?:\?.*)?$/, async (req) => {
      // The server matches the path; the project is the query's (?project=<ref>).
      const ref = (new URL(req.url || '', 'http://x').searchParams.get('project') || '').replace(/^projects\//, '');
      if (!projectNames().includes(ref)) throw fail(404, 'there is no such project on this computer');
      const all = ctx.config().operator?.notes || {};
      return { project: ref, text: typeof all[ref] === 'string' ? all[ref] : '', mayEnd: mayEndFor(ctx.config(), ref), max: 500 };
    }],
    ['POST', /^\/api\/operator\/hold$/, async (req) => {
      ownerOnly(req, 'lifting the hold on new starts');
      await ctx.readJson(req);
      if (['tia', 'both'].includes(heldBy(now()))) noteCorrection(ctx.config(), { kind: 'hold-lifted', about: { decision: 'machine' } }, now());
      liftHold();
      line.add({ at: new Date(now()).toISOString(), item: null, kind: 'machine', subject: 'new starts', act: 'lift-hold', ok: true, result: 'the hold was lifted: sessions and chats start again' });
      return { held: null };
    }],
    // "Make it a task": the owner's tap on a finding, from his own page only (never another computer, never Tia: her
    // door refuses every write under /api/operator, and her in-process call is not the page).
    ['POST', /^\/api\/operator\/look\/task$/, async (req) => {
      ownerOnly(req, 'Make it a task');
      const b = await ctx.readJson(req);
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'item') || typeof b.item !== 'string' || !/^unknown-[0-9a-f]{12}$/.test(b.item)) throw fail(400, 'send { item }: the id of an item of the kind unknown');
      const w = work && work();
      if (!w || !w.add) throw fail(409, 'Work is not on this dashboard');
      try {
        const r = await lk.toTask(b.item, (t) => w.add(t));
        line.add({ at: new Date(now()).toISOString(), item: b.item, kind: 'unknown', subject: r.finding.subject || b.item, act: 'make-task', ok: true, result: `it is a task in Work now: ${String(r.finding.taskTitle || r.task).slice(0, 120)}` });
        return r;
      } catch (e) {
        throw e.status ? fail(e.status, e.message) : e;
      }
    }],
    // His corrections (corrections.mjs): what the pages show, "Forget these", "Use these as evidence". His page only:
    // Tia's door refuses every route under /api/operator but the list and the board, reads too.
    ['GET', /^\/api\/operator\/corrections$/, async (req) => {
      ownerOnly(req, 'His corrections');
      return { ...readCorrections(ctx.config()), ...correctionCounts(now()) };
    }],
    ['POST', /^\/api\/operator\/corrections\/forget$/, async (req) => {
      ownerOnly(req, 'Forget these');
      await ctx.readJson(req);
      const n = forgetCorrections(now());
      return { forgot: n, said: n ? `${n} correction${n === 1 ? ' is' : 's are'} forgotten, and the evidence written from them is gone too.` : 'There was nothing to forget.' };
    }],
    ['POST', /^\/api\/operator\/corrections\/evidence$/, async (req) => {
      ownerOnly(req, 'Use these as evidence');
      await ctx.readJson(req);
      const r = writeEvidence(now());
      return { ...r, file: path.relative(stateDir(), r.file), said: `${r.lines} correction${r.lines === 1 ? '' : 's'} of skills ${r.lines === 1 ? 'is' : 'are'} written as evidence for the improvement loop, into ${tilde(r.file)}. ${r.leftOut ? `${r.leftOut} about rules, decisions or roles ${r.leftOut === 1 ? 'is' : 'are'} left out: the loop improves skills only.` : ''} The improvement loop is not started: you start it yourself.`.replace(/ {2,}/g, ' ') };
    }],
    ['POST', /^\/api\/operator\/undo$/, async (req) => {
      ownerOnly(req, 'Undo');
      const b = await ctx.readJson(req);
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'id')) throw fail(400, 'send { id }');
      const r = await rx.undo(b.id);
      noteCorrection(ctx.config(), { kind: 'undo', about: r.rule === 'decide' ? { decision: 'limit' } : { rule: r.rule } }, now());
      cache.forget();
      const { rule: _r, ...out } = r;
      return out;
    }],
  ];
  // The Start-elsewhere hold's Undo (rooms.mjs): his rule leaves the overload item for the day.
  const elsewhereUndone = () => rx.undoneByHim('elsewhere', itemId('machine', 'load'), 'You ended "Start new work elsewhere" with Undo: the rule leaves it to you for today, or until you tap it.');
  return { name: 'operator', routes, elsewhereUndone, forget: () => cache.forget(), machine: () => (src.machine ? src.machine() : null), list: async () => publicAttention(await list(), { limit: 20 }), reflex: rx, decide: dc, look: lk, looking: () => lookTick, deciding: () => looking, held: () => heldUntil(now()), close: () => unsubscribe?.() };
}

/** A result in a few words, for the timeline. */
function describe(r) {
  if (!r || typeof r !== 'object') return 'done';
  if (r.href) return `opened ${r.href}`;
  if (r.hidden) return 'Not now: hidden until it changes';
  if (r.moved) return `moved to ${r.moved}`;
  if (r.stopped) return 'stopped';
  if (r.ended) return 'ended';
  if (r.did) return [].concat(r.did).join('; ') || 'done';
  return 'done';
}
