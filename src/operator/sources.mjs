// The board's sources on a real dashboard, and the acts behind the owner's taps, each through a function the product
// already has. A look reads only what is held already: the sessions and providers the page also reads, files of the
// state folder, and what the slow checks below found on their last round. The slow checks (git state of the
// repositories, the processes, whether the login page and the public link answer) run on the dashboard's tick, at
// most once a minute (git once in five), so a look never waits for git, a process listing or the network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextProfile, parseResets } from '../autoswitch.mjs';
import { findAddon } from '../addons/index.mjs';
import { gatewayAddons, providersOf } from '../addons/gateways.mjs';
import { noteStarted, stoppedAt } from '../addons/stopmark.mjs';
import { knock } from '../knock.mjs';
import { gitRead } from '../gitread.mjs';
import { loadMachines } from '../machines/store.mjs';
import { readNote } from '../keeper/keep.mjs';
import { repoInfo, syncRepo } from '../pcsetup/workspace.mjs';
import { system as identity, statStart } from '../procid.mjs';
import { endProcess } from '../desktop/procs.mjs';
import { killProcess, parentLookup, snapshot } from '../server/platform.mjs';
import { isShell, onlyIdleShells } from './detect/leftover.mjs';
import { AGENT_STOP_MS } from './detect/providerstop.mjs';
import { capture } from '../setup/system.mjs';
import { listRuns } from '../runs.mjs';
import { classify } from '../providers/table.mjs';
import { checkable, gapsOf, lastCheck } from '../providers/check.mjs';
import { noteReading, noteStops } from '../providers/left.mjs';
import { ownConversations, transcriptReader } from '../providers/transcripts.mjs';
import { readProfile } from '../profiles.mjs';
import { profileUsage } from '../routerstate.mjs';
import { projectDir } from '../sessions.mjs';
import { brainDir, listProjects, projectsIn } from '../workspace/layout.mjs';
import { COMMIT_MESSAGE } from '../workspace/map.mjs';
import { listRuns as workRuns } from '../work/runs.mjs';
import { listMissions } from '../mission/file.mjs';
import { resolvePlace } from '../work/place.mjs';
import * as link from '../addons/linkswitch.mjs';
import { passBack } from '../oneturn.mjs';
import { stateDir } from '../paths.mjs';
import { bytesWords, cleanOwnTemp, defaultNext, httpLook, ownTempBytes, portHolder, reopenSession, probeAddress } from './mends.mjs';

const MIN = 60_000;
// The program a Work run's task came from (a Work token's name), read once per look of the board's work source.
/**
 * A mission's task whose check failed the same way after a fix: its gate failed twice and says now what it said before
 * the fix (the engine keeps the first words as the fix's points). For the `unknown` detector.
 */
export function sameChecks(place) {
  const out = [];
  for (const m of listMissions(place).missions.slice(0, 20)) {
    for (const t of m.tasks) {
      if (t.gateFails < 2 || !t.gate || t.gate.ok || !t.points.length) continue;
      if (JSON.stringify(t.gate.words.slice(0, 10)) !== JSON.stringify(t.points.slice(0, 10))) continue;
      const at = [...m.line].reverse().find((l) => l.task === t.id)?.at || m.endedAt || m.createdAt;
      out.push({ mission: m.id, task: t.id, title: String(t.title).slice(0, 80), project: m.project || null, words: t.gate.words.slice(0, 5).map((w) => String(w).slice(0, 100)), at, run: t.runs.length ? t.runs[t.runs.length - 1].id : null });
    }
  }
  return out;
}

let workFromCache = { at: 0, file: '', by: new Map() };
function workFrom(r, cfg) {
  const now = Date.now();
  let file = '';
  try {
    file = resolvePlace(cfg, {}).file;
  } catch {
    /* Work is not set up: no source to name */
  }
  if (now - workFromCache.at > 2000 || workFromCache.file !== file) {
    const by = new Map();
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const x of Array.isArray(doc.items) ? doc.items : []) {
        const f = x && typeof x === 'object' && x.from && typeof x.from === 'object' ? x.from : null;
        if (f && typeof f.name === 'string' && f.name.trim() && typeof x.id === 'string') by.set(x.id, { name: f.name.trim().slice(0, 60), at: typeof f.at === 'string' ? f.at : '' });
      }
    } catch {
      /* no Work list: no source to name */
    }
    workFromCache = { at: now, file, by };
  }
  const f = workFromCache.by.get(r.item);
  return f && (!f.at || String(r.startedAt || '') >= f.at) ? { from: f.name } : {};
}
const ENDED_KEEP_MS = 24 * 3600_000;
const REPOS_MAX = 200;
// The upkeep's and a sync's own commit messages in the brain (src/workspace): what an automation changed there.
const AUTOMATION_MESSAGES = new Set([COMMIT_MESSAGE, 'Add the workspace map']);

const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return null;
  }
};
const iso = (t) => (t == null ? null : new Date(t).toISOString());

/**
 * The newest change under a conversation's subagents folder (`<conversation>/subagents/…`, two levels deep: a
 * workflow keeps its agents in a folder of its own): background agents write there, not in the main conversation.
 * Sub-folders are gone into first, and each folder has its own budget: at most 400 of its files are looked at and at
 * most 64 of its sub-folders (the newest by their own time when there are more). So old files beside `workflows/`
 * cannot use up the look before the folder is entered, and a long workflow whose folder is older than later, finished
 * ones (a folder's time moves only when an entry is added) is still read.
 */
const FILES_PER_DIR = 400;
const DIRS_PER_DIR = 64;
function newestUnder(dir, depth = 3) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  const keep = (t) => {
    if (t != null && (best == null || t > best)) best = t;
  };
  let dirs = list.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  if (depth > 1) {
    if (dirs.length > DIRS_PER_DIR) dirs = dirs.map((f) => ({ f, t: mtime(f) ?? 0 })).sort((x, y) => y.t - x.t).slice(0, DIRS_PER_DIR).map((d) => d.f);
    for (const d of dirs) keep(newestUnder(d, depth - 1));
  }
  let files = 0;
  for (const e of list) {
    if (e.isDirectory()) continue;
    if (++files > FILES_PER_DIR) break;
    keep(mtime(path.join(dir, e.name)));
  }
  return best;
}

/** A slow check run on the tick: its last result (or why it could not be had), and when. `force()` runs it now. */
function slow(everyMs, fn, now) {
  let last = { at: 0, value: undefined, error: 'not looked at yet: the first look comes within a minute' };
  let running = null;
  const start = () => {
    running = (async () => {
      try {
        last = { at: now(), value: await fn(), error: null };
      } catch (e) {
        last = { at: now(), value: undefined, error: String(e?.message || e) };
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return {
    async tick() {
      // A last look later than now (the clock was set back) is no reason to wait: the check runs again.
      const age = now() - last.at;
      if (running || (age >= 0 && age < everyMs)) return;
      await start();
    },
    // After an act changed what this check reads: a round that is on its way may have read the old state, so a new
    // round follows it.
    async force() {
      if (running) await running;
      await start();
    },
    read() {
      if (last.error) throw new Error(last.error);
      return last.value;
    },
  };
}

/** The login page of a dashboard's address (the public link's address may carry a path or a query: only its origin counts). */
export const loginAddress = (base) => `${new URL(base).origin}/login`;

/**
 * The address a request reached this dashboard on, as a URL host: an IPv4 address, or an IPv6 one in brackets. A
 * dashboard may listen on one address only (`--host` with a LAN address), so the live check asks that one.
 */
export function hostOf(address) {
  const a = String(address || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!a || a === '0.0.0.0' || a === '::') return '127.0.0.1';
  return a.includes(':') ? `[${a.replace(/%.*$/, '')}]` : a;
}

const AGENTS_MAX = 10;

/** A run record's failure as the board's stop: { at, reason, text }, or null when it is no provider stop. */
export function stopOf(f) {
  if (!f || typeof f !== 'object') return null;
  const c = classify({ error: f.error, text: f.text });
  return c ? { at: iso(f.at || null), reason: c.reason, text: c.text } : null;
}

/** A session's stop from its run record's failure, marked `either` when an earlier hook wrote it (that hook put an
 * agent's stop there too, unnamed): the item then says "the session, or an agent in it". */
export function sessionStop(f) {
  const stop = stopOf(f);
  return stop && !f.own ? { ...stop, either: true } : stop;
}

/** A run record's agentStops as the board's agents: each with its label, its stop and, for a usage limit, its limit. */
export function agentsOf(list, now = Date.now()) {
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a === 'object' && typeof a.id === 'string').slice(-AGENTS_MAX).map((a) => {
    const stop = stopOf(a);
    // An agent's limit is the past after a day, as its other stops are: it no longer offers to move a session that runs.
    const recent = Number.isFinite(a.at) && now - a.at <= AGENT_STOP_MS;
    return { id: a.id.slice(0, 80), label: String(a.label || '').slice(0, 80), stop, limit: stop?.reason === 'limit' && recent ? { at: stop.at, text: stop.text.slice(0, 80), resetsAt: null } : null };
  }).filter((a) => a.stop);
}

/**
 * When a limit ends, only when it was named: by the tool's own line ("resets 5pm (UTC)"), or by the reset of a full
 * window the provider reported (the usage the product already reads). Never guessed: null otherwise. The line is read
 * against the time the limit was hit (`at`), as the tool wrote it: read against the look's time, "resets 7am" seen at
 * 07:10 would name tomorrow's 7am for a limit that already reset. A named time that has passed is no time to wait for.
 */
export function namedReset(text, usage, t = Date.now(), at = null) {
  const hit = Date.parse(at);
  const said = parseResets(String(text || ''), Number.isFinite(hit) ? hit : t);
  if (said) return said > t ? iso(said) : null;
  const full = ['fiveHour', 'week'].map((w) => usage?.[w]).find((w) => w && w.pct >= 100 && Number.isFinite(w.resetsAt) && w.resetsAt > t);
  return full ? iso(full.resetsAt) : null;
}

/** The product's sources. `port()`: the port this dashboard answers on; `address()`: the address it was reached on. */
export function defaultSources(ctx, { port, address = () => null, now = Date.now, gateways = gatewayAddons, usersOf = providersOf, keepLeftover = null, rooms = null }) {
  const seenCoding = new Map(); // name → { provider, cwd, sessionId, runId, carryArgs, tool } as last seen (for "ended")
  const ended = new Map(); // name → { at, provider }
  const liveSince = { local: null, link: null };
  const liveLast = { local: null, link: null };
  const offlineSince = {}; // linked computer → when it was first found not answering
  // The coding tool's own records, for sessions Hoprig did not start (providers/transcripts.mjs): read only, a bounded
  // part per look.
  const outside = transcriptReader({ now });
  const ours = ownConversations({ now });

  async function sessions() {
    const st = await ctx.state();
    const all = listRuns({ chats: true });
    const runs = new Map(all.filter((r) => r.kind !== 'chat').map((r) => [r.runId, r]));
    // A chat's record is its process's (runs.mjs createChatRun): the hook writes the chat's provider stops there.
    const chatRuns = new Map(all.filter((r) => r.kind === 'chat').map((r) => [r.chat, r]));
    const out = [];
    const coding = new Set();
    const usage = profileUsage(now());
    const labels = new Map((st.profiles || []).map((p) => [p.name, p.label || null]));
    const labelOf = (name) => labels.get(name) || null;
    for (const c of st.sessions || []) {
      if (c.kind === 'shell' || !c.profile) continue;
      coding.add(c.name);
      const chat = c.kind === 'chat';
      const run = (chat ? chatRuns.get(c.chatId) : c.runId && runs.get(c.runId)) || {};
      seenCoding.set(c.name, { provider: c.profile.name, cwd: run.cwd || c.cwd || null, sessionId: c.sessionId || run.sessionId || null, runId: c.runId || null, carryArgs: Array.isArray(run.carryArgs) ? run.carryArgs.filter((a) => typeof a === 'string') : [], tool: c.tool || 'claude' });
      const convDir = c.cwd && c.sessionId ? projectDir(run.cwd || c.cwd) : null;
      const conv = convDir ? mtime(path.join(convDir, `${c.sessionId}.jsonl`)) : null;
      // A workflow or background agents the session started: they write their own transcripts, so their progress counts.
      const background = Array.isArray(run.background) ? run.background.length : 0;
      const agentsAt = background && convDir ? newestUnder(path.join(convDir, c.sessionId, 'subagents')) : null;
      const progress = Math.max(Number(run.statusAt) || 0, conv || 0, agentsAt || 0, Number(c.statusAt) || 0) || null;
      const lim = c.runLimit || c.limit || (chat ? run.limit : null);
      const claude = (c.tool || 'claude') === 'claude';
      // The owner's order first; with none set, his subscription providers in list order (a paid one is never named here).
      const next = c.profile.name === 'auto' ? null : nextProfile(c.profile.name) || defaultNext(c.profile.name, st.profiles, now());
      out.push({
        name: c.name,
        tool: c.tool || 'claude',
        chatId: chat ? String(c.chatId || '').slice(0, 80) || null : null, // a chat is opened by its own address
        display: chat ? String(c.display || '').slice(0, 60) : null,
        provider: c.profile.name,
        folder: run.cwd || c.cwd || null, // stays on the server: which project the session belongs to
        conversation: c.sessionId || run.sessionId || run.conversation || null, // stays on the server: its runs' providers (runs.mjs ranBefore)
        providerLabel: c.profile.label || null, // a gateway's users are profiles as the pages call them
        state: c.status || 'unknown',
        statusAt: iso(c.statusAt),
        progressAt: iso(progress),
        // `source`: 'hook' when Claude Code's own report (the run record) says it, 'screen' when only the screen shows
        // a limit line (a file or a log on the screen can show one too): a rule of Tia's acts only on the first.
        // `resetsAt`: only a time the tool's line or a full window names (namedReset), never a guess.
        limit: lim ? { at: iso(c.limitAt || lim.at || null), text: String(lim.text || '').slice(0, 80), resetsAt: namedReset(lim.text, usage[c.profile.name], now(), iso(c.limitAt || lim.at || null)), source: c.runLimit ? 'hook' : 'screen' } : null,
        // A chat's question or OK is its own card's (chat/feature.mjs): the hook keeps none in a chat's record.
        asks: chat ? (c.ask ? ['main'] : []) : Array.isArray(run.asks) ? run.asks.map(String).slice(0, 5) : [],
        askType: chat ? (c.ask && c.ask.type) || null : run.askType || null,
        askAt: iso(chat ? (c.ask ? c.statusAt : null) : run.askAt || c.askAt || null),
        background,
        toolNow: null, // the run record does not say which tool call runs: the stuck item says only how long it is quiet
        // How a provider stopped the session's last reply, or one of its agents (the hook's failure and agentStops,
        // named by the closed table). Claude Code's records only.
        stop: claude ? sessionStop(run.failure) : null,
        agents: claude ? agentsOf(run.agentStops, now()).map((a) => (a.limit ? { ...a, limit: { ...a.limit, resetsAt: namedReset(a.limit.text, usage[c.profile.name], now(), a.limit.at) } } : a)) : [],
        canSwitch: !!c.canSwitch && (c.tool || 'claude') === 'claude' && c.profile.name !== 'auto',
        nextProvider: next,
        nextProviderLabel: next ? labelOf(next) : null, // the item names it as the Providers page does
      });
    }
    // A coding session whose terminal is still there as a plain shell: its coding tool ended in it, and what it said
    // last is there to read (kept for a day). A session that went away with its terminal was closed by the owner (the
    // Sessions page, this panel's Stop): nothing is left to read, so it is no item.
    const terminals = new Set((st.sessions || []).map((c) => c.name));
    for (const [name, seen] of seenCoding) {
      if (coding.has(name)) continue;
      seenCoding.delete(name);
      if (terminals.has(name)) ended.set(name, { at: now(), ...seen });
    }
    for (const [name, e] of ended) {
      if (now() - e.at > ENDED_KEEP_MS || coding.has(name) || !terminals.has(name)) {
        ended.delete(name);
        continue;
      }
      // The coding tool left its pane with no end of its own: Claude Code's SessionEnd never reached its run record
      // (a killed process, a crash). Only then can it be reopened; /exit and the like wrote their end, and such a session
      // is the person's, as is one whose conversation is not known. Claude Code's sessions only.
      const rec = e.runId ? runs.get(e.runId) : null;
      const own = !rec || (rec.status !== 'ended' && !rec.endReason);
      const reopen = own && e.tool === 'claude' && e.sessionId && e.cwd && e.provider && e.provider !== 'auto' ? { cwd: e.cwd, sessionId: e.sessionId, profile: e.provider, carryArgs: e.carryArgs, tool: e.tool } : null;
      out.push({ name, state: 'ended', provider: e.provider, providerLabel: labelOf(e.provider), folder: e.cwd || null, statusAt: iso(e.at), asks: [], agents: [], ...(reopen ? { reopen } : {}) });
    }
    // Sessions the coding tool ran without Hoprig: the same items. A session Hoprig started (a run record or a chat
    // names its conversation, now or in the last day) is left out: the hook's record of it wins.
    let mine;
    try {
      mine = ours.note([...all.flatMap((r) => [r.sessionId, r.conversation]), ...(st.sessions || []).map((c) => c.sessionId)].filter(Boolean));
    } catch {
      mine = new Set();
    }
    try {
      for (const c of outside.look({ skip: mine })) {
        const named = (l) => (l ? { ...l, resetsAt: namedReset(l.text, null, now(), l.at) } : null);
        out.push({ ...c, limit: named(c.limit), agents: c.agents.map((a) => ({ ...a, limit: named(a.limit) })) });
      }
    } catch {
      /* the tool's folder could not be read: Hoprig's own sessions are still told */
    }
    noteStops(out, now()); // how often each provider stopped the work in the last day (providers/left.mjs), in memory
    return out;
  }

  const checkOf = (name) => {
    try {
      const last = lastCheck(name);
      const p = readProfile(name);
      // `on`: the map is on for this provider's sessions now, so a MODELS mend needs no switch (check.mjs withSwitch).
      return { checkable: checkable(p), check: last ? { at: last.at, gaps: gapsOf(last, { on: p?.mapSessions === true }).slice(0, 12) } : null };
    } catch {
      return { checkable: false, check: null };
    }
  };

  // A provider's address that answers nothing (a plain gateway, an endpoint the owner added): looked at every 5 minutes,
  // only for the providers an open session goes through now, with a knock and one request that carries no key.
  const reachCheck = slow(5 * MIN, async () => {
    const st = await ctx.state();
    const open = new Map();
    for (const c of st.sessions || []) {
      if (c.kind === 'shell' || !c.profile || (c.kind === 'chat' && c.running !== true)) continue;
      open.set(c.profile.name, (open.get(c.profile.name) || 0) + 1);
    }
    const out = {};
    for (const [name, sessions] of [...open].slice(0, 12)) {
      const prof = readProfile(name);
      const base = prof?.env?.ANTHROPIC_BASE_URL;
      // A subscription has no address of its own; the add-ons' gateways have their own check (the gateways source).
      if (typeof base !== 'string' || !base) continue;
      // A gateway add-on's own port is the gateways source's: a restart rule looks after it.
      let addonPort = false;
      try {
        const u = new URL(base);
        addonPort = (gatewaysCheck.read() || []).some((g) => g.port && String(g.port) === (u.port || (u.protocol === 'https:' ? '443' : '80')) && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname));
      } catch { /* not a URL */ }
      if (addonPort) continue;
      const r = await probeAddress(base);
      if (r.state === 'skipped') continue;
      let host = '';
      try {
        const u = new URL(base);
        host = u.host;
      } catch { /* not a URL: said without an address */ }
      out[name] = { answers: r.state === 'answers', address: host, sessions, since: iso(now()) };
    }
    return out;
  }, now);
  let reachSince = {}; // provider → when its address was first found silent: a row keeps its age between looks

  async function providers() {
    const st = await ctx.state();
    let reach = {};
    try {
      reach = reachCheck.read() || {};
    } catch { /* not looked at yet: no row */ }
    for (const k of Object.keys(reachSince)) if (!(k in reach) || reach[k].answers) delete reachSince[k];
    for (const [k, v] of Object.entries(reach)) if (!v.answers) reachSince[k] ||= v.since;
    return (st.profiles || []).filter((p) => !p.virtual).map((p) => ({
      ...(reach[p.name] ? { reach: { ...reach[p.name], ...(reachSince[p.name] ? { since: reachSince[p.name] } : {}) } } : {}),
      name: p.name,
      label: p.label || null, // the item names it as the Providers page does
      signedIn: typeof p.signedIn === 'boolean' ? p.signedIn : null,
      usage: p.usage ? { fiveHour: p.usage.fiveHour || null, week: p.usage.week || null, at: iso(p.usage.at || null) } : null,
      // The provider check's last result (only kept, never run by a look): its gaps, for the model-name item's mend.
      ...checkOf(p.name),
    }));
  }

  const gatewaysCheck = slow(MIN, async () => {
    const out = [];
    for (const a of gateways()) {
      const s = await a.status({ version: false });
      const p = Number(/:(\d+)/.exec(String(s.url || '').replace(/^[a-z]+:\/\//, ''))?.[1]) || null;
      // A gateway that providers go through is knocked on also when it is not running: a stopped or crashed one is
      // what stops their sessions. One that nothing uses may be off on purpose.
      const users = s.installed ? usersOf(a.id) : [];
      const usedBy = users.length;
      const knocked = p && (s.running || usedBy) ? (await knock({ port: p, host: '127.0.0.1' }, 1500)) === 'open' : null;
      // A gateway that runs and accepts the connection is asked once for its own health address (no key, no body): a
      // server error there is as much a stop as no answer. 404 (no such address) still means it is up.
      const status = s.running && knocked === true && p ? await httpLook(`http://127.0.0.1:${p}/health`, { timeoutMs: 3000 }) : null;
      // Another program holds its port (the add-on says it answers but is not ours): named, never touched.
      const foreign = !s.running && s.foreign === true;
      const heldBy = foreign && p ? portHolder(p) : null;
      // A provider's PRERUN starts its gateway before each of its sessions: a gateway that is not running stops work
      // only for a session of such a provider that is open now. A chat counts only while its process runs (as in
      // src/automation/idle.mjs): a chat restored after a restart runs the PRERUN again with its next message. Null
      // when the sessions could not be read.
      let live = null;
      if (usedBy) {
        try {
          const names = new Set(users);
          const open = (c) => c.kind !== 'shell' && (c.kind !== 'chat' || c.running === true);
          live = ((await ctx.state()).sessions || []).filter((c) => open(c) && c.profile && names.has(c.profile.label || c.profile.name)).length;
        } catch { /* left unknown: the item stays stopped work */ }
      }
      // `ownerStopped`: it is not running because the owner stopped it himself (stopmark.mjs).
      out.push({ name: a.id, port: p, running: !!s.running, installed: !!s.installed, usedBy, users: users.slice(0, 3).map((u) => String(u).slice(0, 40)), live, answers: knocked, status, ...(foreign ? { foreign: true, heldBy } : {}), ownerStopped: !s.running && stoppedAt(a.id) != null });
    }
    return out;
  }, now);

  const status = async (url) => {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await r.body?.cancel();
      return r.status;
    } catch {
      return 0;
    }
  };
  const liveCheck = slow(MIN, async () => {
    const out = {};
    // The login page itself: it is public, so it answers 200 without a login (the page "/" sends a visitor to it
    // with a 302, which is not a failure).
    const own = port() ?? ctx.config().server?.port ?? null;
    if (!Number.isInteger(own)) throw new Error('the port of this dashboard is not known yet');
    const local = await status(loginAddress(`http://${hostOf(address() ?? ctx.config().server?.host)}:${own}`));
    const s = link.status({ why: false });
    const linkOn = !!s.on || s.state === 'on';
    const linkStatus = linkOn && s.url ? await status(loginAddress(s.url)) : linkOn ? 0 : null;
    for (const [k, v] of [['local', local], ['link', linkStatus]]) {
      if (v !== liveLast[k]) liveSince[k] = now();
      liveLast[k] = v;
    }
    out.local = { status: local, since: iso(liveSince.local), checkedAt: iso(now()) };
    out.link = { on: linkOn, status: linkStatus, since: iso(liveSince.link), checkedAt: iso(now()) };
    return out;
  }, now);

  const reposCheck = slow(5 * MIN, async () => {
    const out = [];
    const root = projectsIn(ctx.config());
    for (const p of listProjects(root)) {
      const dirs = p.git ? [p.dir] : [];
      const code = path.join(p.dir, 'code');
      try {
        for (const d of fs.readdirSync(code, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(code, d.name, '.git'))) dirs.push(path.join(code, d.name));
      } catch {
        /* no code/ folder */
      }
      for (const dir of dirs) {
        if (out.length >= REPOS_MAX) break;
        const s = await repoInfo(dir);
        if (!s.ok) continue;
        const rel = path.relative(root, dir);
        // A merge or a rebase left half done: git's own marks inside the .git folder (a linked worktree has none here).
        const g = path.join(dir, '.git');
        const merging = fs.existsSync(path.join(g, 'MERGE_HEAD')) ? 'merge' : fs.existsSync(path.join(g, 'rebase-merge')) || fs.existsSync(path.join(g, 'rebase-apply')) ? 'rebase' : null;
        out.push({ name: rel.split(path.sep).join('/'), path: rel, project: p.name, ...(merging ? { merging } : {}), branch: s.branch || null, upstream: s.upstream || null, behind: s.behind || 0, ahead: s.ahead || 0, dirty: s.changes || 0, fetchedAt: iso(mtime(path.join(dir, '.git', 'FETCH_HEAD'))) });
      }
    }
    return out;
  }, now);

  const changesCheck = slow(5 * MIN, async () => {
    const brain = brainDir();
    if (!fs.existsSync(path.join(brain, '.git'))) return [];
    const r = await gitRead(brain, ['log', '--max-count=40', '--since=3.days', '--format=%H%x09%ct%x09%s']);
    if (!r.ok) throw new Error((r.stderr || 'git failed').trim().split('\n')[0]);
    return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, , s]) => AUTOMATION_MESSAGES.has(s))
      .map(([commit, ct, subject]) => ({ where: 'brain', commit, at: iso(Number(ct) * 1000), by: 'the upkeep', subject }));
  }, now);

  const machineCheck = slow(MIN, async () => {
    const s = await snapshot();
    let tmp = null;
    try {
      const f = fs.statfsSync(os.tmpdir());
      tmp = { usedPct: Math.round((1 - f.bavail / f.blocks) * 100) };
    } catch {
      /* not known on this system */
    }
    // What Hoprig itself made and may remove (mends.mjs): the bytes only, nothing is read of it.
    let ownTemp = 0;
    try {
      ownTemp = ownTempBytes({ state: stateDir(), now: now() });
    } catch { /* not known: no clean is offered */ }
    return {
      ownTemp,
      cpus: s.cpus, load1: s.load?.[0] ?? null, memTotal: s.mem?.total ?? null, memAvailable: s.mem?.available ?? null,
      disks: (s.disks || []).filter((d) => d.size > 1e9).slice(0, 8).map((d) => ({ mount: d.mount, usedPct: Math.round((d.used / d.size) * 100) })),
      tmp,
      keeper: readNote(),
    };
  }, now);

  // This dashboard's own tmux server: the socket its running backend uses (an option of the server can differ from the
  // settings file), and the one the settings name.
  const ownSockets = () => [ctx.backend?.kind === 'tmux' ? ctx.backend.socket : null, ctx.config().server?.tmuxSocket].filter(Boolean);
  // `keepLeftover` (tests only): which processes count, so a test's rule never ends what another program runs.
  const leftoversCheck = slow(MIN, async () => (await leftovers({ ownSocket: ownSockets(), ownPort: port() })).filter((p) => !keepLeftover || keepLeftover(p)), now);

  const checks = [gatewaysCheck, liveCheck, reposCheck, changesCheck, machineCheck, leftoversCheck, reachCheck];
  // The checks an act changes the answer of: run again right after it, so the next look does not show the old state.
  const AFTER = { sync: [reposCheck], push: [reposCheck], end: [leftoversCheck], 'restart-gateway': [gatewaysCheck], clean: [machineCheck] };
  return {
    sources: {
      sessions,
      // A look of Tia's (src/operator/look.mjs) is no run of Work: its record stays in the runs folder, never on the board.
      // A run's reason is kept long here: the card's fact cuts it to its own length, with a mark (item.mjs).
      work: () => {
        const place = resolvePlace(ctx.config(), {});
        return { runs: workRuns(place, { max: 40 }).filter((r) => r.by !== 'look').map((r) => ({ id: r.id, item: r.item, by: r.by, title: String(r.title || '').slice(0, 80), state: r.state, endedAt: r.endedAt || null, reason: r.reason ? String(r.reason).slice(0, 300) : null, project: r.project || null, mission: r.by === 'mission', ...workFrom(r, ctx.config()) })), checks: sameChecks(place) };
      },
      providers,
      gateways: () => gatewaysCheck.read(),
      live: () => liveCheck.read(),
      // `rooms`: what the room keeper holds (src/operator/rooms.mjs view): read from memory, never asked here.
      computers: () => {
        const list = rooms ? rooms().computers.filter((c) => !c.here).map((c) => ({ name: c.name, online: c.reached ? true : c.seenAt ? false : null, room: c.room, why: c.why, cpus: c.cpus, load1: c.load1, memFreePct: c.memFreePct, seenAt: c.seenAt || null })) : loadMachines().map((m) => ({ name: m.name, online: null }));
        // How long a linked computer has been silent: from the last time it answered, else from the first look that missed it.
        for (const n of Object.keys(offlineSince)) if (!list.some((c) => c.name === n && c.online === false)) delete offlineSince[n];
        return list.map((c) => {
          if (c.online !== false) return c;
          offlineSince[c.name] ||= c.seenAt && Date.parse(c.seenAt) > now() - 24 * 3600_000 ? Date.parse(c.seenAt) : now();
          return { ...c, offlineSince: iso(offlineSince[c.name]) };
        });
      },
      repos: () => reposCheck.read(),
      changes: () => changesCheck.read(),
      schedules: () => ((ctx.config().automation || {}).schedules?.list || []).map((s) => ({ name: String(s.name || s.label || s.id || 'schedule').slice(0, 40), on: s.enabled !== false })),
      machine: () => machineCheck.read(),
      leftovers: () => leftoversCheck.read(),
    },
    // One check started per pass of the loop: started together, their first steps (the gateways' status, the walk of
    // /proc, the snapshot's answers) ran back to back, about 23 ms of a 65 ms stretch on the first tick (a CPU profile
    // with fifty open sessions). Each check's outcome is taken at once, so one that fails while the next waits for its
    // pass is never an unhandled rejection (that ends the server); the first failure is the tick's, as with Promise.all.
    tick: async () => {
      // The providers' reported usage, noted on each tick so the pace of the last hour rests on readings (in memory):
      // one look at the clock, in a pass of its own before the checks.
      try {
        const at = now();
        for (const [name, u] of Object.entries(profileUsage(at))) noteReading(name, u, at);
      } catch { /* no usage kept */ }
      await passBack();
      const going = [];
      for (const c of checks) {
        going.push(c.tick().then(() => null, (e) => ({ e })));
        await passBack();
      }
      const failed = (await Promise.all(going)).find(Boolean);
      if (failed) throw failed.e;
    },
    after: (actId) => Promise.all((AFTER[actId] || []).map((c) => c.force())),
  };
}

/**
 * The process ids a process started (Linux), or null when they could not be read: from the task's children file
 * where the kernel has one, else by the parent id of every process.
 */
function childrenOf(proc, pid) {
  try {
    const dir = path.join(proc, String(pid), 'task');
    const tasks = fs.readdirSync(dir);
    if (tasks.every((t) => fs.existsSync(path.join(dir, t, 'children')))) {
      return tasks.flatMap((t) => fs.readFileSync(path.join(dir, t, 'children'), 'utf8').split(' ').filter(Boolean).map(Number));
    }
  } catch {
    return null;
  }
  const kids = [];
  for (const name of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (Number(/^\d+ \(.*\) \S (\d+)/s.exec(fs.readFileSync(path.join(proc, name, 'stat'), 'utf8'))?.[1]) === Number(pid)) kids.push(Number(name));
    } catch { /* it ended while we read */ }
  }
  return kids;
}

/**
 * What runs in a tmux server's panes, or null when they could not be read: each pane's program and, when that program
 * is a shell, how many processes the shell started. tmux names only a pane's foreground program, so a shell that runs
 * a job in the background ("sleep 600 &", "(sleep 600; echo done) &", nohup, a job stopped with Ctrl+Z) reads as an
 * idle shell there: its children count, whatever their names (onlyIdleShells decides).
 */
async function panesOf(socket, run, proc = '/proc') {
  const r = await run(['tmux', '-L', socket, 'list-panes', '-a', '-F', '#{pane_pid} #{pane_current_command}'], { timeout: 3000 });
  if (!r.ok) return null;
  const panes = [];
  for (const line of r.stdout.split('\n').filter(Boolean).slice(0, 20)) {
    const [, pid, command] = /^(\d+) (.*)$/.exec(line) || [];
    if (!pid) return null;
    if (!isShell(command)) {
      panes.push({ command: command.slice(0, 40), children: null });
      continue;
    }
    const kids = childrenOf(proc, pid);
    if (!kids) return null;
    panes.push({ command: command.slice(0, 40), children: kids.length });
  }
  return panes;
}

/** The tmux sockets the run records of coding sessions name (from $TMUX): never left over. */
const sessionSocketsOf = (runs) => new Set(runs().map((r) => (r.tmuxSocket ? path.basename(String(r.tmuxSocket)) : null)).filter(Boolean));

/**
 * Left-over processes of this user (Linux, from /proc): tmux servers on a private socket (not this dashboard's own,
 * not one a run record names) with no client, with what runs in their panes, and dashboards (`hoprig serve`) on another port whose state folder is in the temporary folder (a
 * test's or a try's: a real dashboard is never offered to be ended). Each with its identity for the act. `temp`: a
 * tmux server a test's or a try's Hoprig started (its state folder is in the temporary folder).
 */
export async function leftovers({ ownSocket = '', ownPort = null, proc = '/proc', run = capture, ports = async () => (await snapshot()).ports || [], runs = listRuns, tmp = tempFolders() } = {}) {
  if (process.platform !== 'linux') throw new Error('not looked at on this system yet');
  const uid = process.getuid();
  const sessionSockets = sessionSocketsOf(runs);
  const owns = [].concat(ownSocket).filter(Boolean);
  const out = [];
  let listening = null;
  for (const name of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let argv;
    let st;
    try {
      st = fs.statSync(path.join(proc, name));
      if (st.uid !== uid) continue;
      argv = fs.readFileSync(path.join(proc, name, 'cmdline'), 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    const startedAt = iso(startOf(proc, pid));
    if (!startedAt) continue;
    const base = path.basename(argv[0] || '');
    if (base === 'tmux') {
      const i = argv.indexOf('-L');
      const socket = i >= 0 ? argv[i + 1] : null;
      if (!socket || owns.includes(socket) || sessionSockets.has(socket) || !/^[\w.-]{1,80}$/.test(socket)) continue;
      // Only a server (it was started by "new-session" or a start-server): a tmux client has a terminal of its own.
      const r = await run(['tmux', '-L', socket, 'list-clients'], { timeout: 3000 });
      if (!r.ok && !/no server running/.test(r.stderr || '')) continue;
      const clients = r.ok ? r.stdout.split('\n').filter(Boolean).length : 0;
      // The server may end between the look at its clients and this read (a test's server, a session that closes):
      // then it is no leftover, and the others are still listed (an error here made the whole check unreadable).
      let ppid;
      try {
        ppid = Number(/^\d+ \(.*\) \S (\d+)/.exec(fs.readFileSync(path.join(proc, name, 'stat'), 'utf8'))?.[1]);
      } catch {
        continue;
      }
      // tmux puts its server in the background, so its parent is init (1) or a session's process reaper: the
      // program that started it is gone in every case. Its clients and its age decide.
      const panes = await panesOf(socket, run, proc);
      // A test's or a try's server: the Hoprig it was started under keeps its state in the temporary folder, as a test's
      // dashboard below. Only such a one may a rule of Tia's end. Its folder or its socket folder says nothing: the
      // owner's own detached server started in /tmp is his to end.
      const cwd = cwdOf(proc, pid);
      const temp = inTemp(stateDirOf(proc, name), tmp);
      out.push({ what: 'tmux', pid, socket, startedAt, clients, panes, parentAlive: ppid > 1 && !isReaper(proc, ppid), cwd, temp, proc: identity.of([pid]).get(pid) || null });
    } else if (base === 'node' && argv.some((a) => /hoprig\.mjs$/.test(a)) && argv.includes('serve')) {
      if (pid === process.pid) continue;
      if (!inTemp(stateDirOf(proc, name), tmp)) continue;
      listening ??= await ports();
      const port = listening.find((p) => p.pid === pid)?.port ?? null;
      if (!Number.isInteger(port) || port === ownPort) continue;
      out.push({ what: 'dashboard', pid, port, startedAt, cwd: cwdOf(proc, pid), temp: true, proc: identity.of([pid]).get(pid) || null });
    }
  }
  return out;
}

/** The state folder a process was started with (HOPRIG_STATE_DIR), '' when it has none or it cannot be read. */
function stateDirOf(proc, name) {
  try {
    return /(?:^|\0)HOPRIG_STATE_DIR=([^\0]*)/.exec(fs.readFileSync(path.join(proc, name, 'environ'), 'utf8'))?.[1] || '';
  } catch {
    return '';
  }
}

// The temporary folders: the system's (TMPDIR) and, on a POSIX system, /tmp (a test's or a try's state folder may lie
// there when TMPDIR points elsewhere).
const tempFolders = () => [...new Set([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])])];

/** Whether `dir` is inside one of the temporary folders `tmp` (not the folder itself), as written or as real paths. */
function inTemp(dir, tmp) {
  if (!dir) return false;
  if (Array.isArray(tmp)) return tmp.some((t) => inTemp(dir, t));
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return [[path.resolve(dir), path.resolve(tmp)], [real(dir), real(tmp)]].some(([d, t]) => d.startsWith(t + path.sep));
}

// When a process started: its stat's start field (clock ticks after boot, 100 a second on Linux) plus the boot time.
let bootAt = null;
function startOf(proc, pid) {
  try {
    bootAt ??= Number(/^btime (\d+)$/m.exec(fs.readFileSync(path.join(proc, 'stat'), 'utf8'))[1]) * 1000;
    const ticks = Number(statStart(fs.readFileSync(path.join(proc, String(pid), 'stat'), 'utf8')));
    return Number.isFinite(ticks) && bootAt ? bootAt + ticks * 10 : null;
  } catch {
    return null;
  }
}

/** The folder a process works in (it stays on the server: which project it belongs to), or null. */
function cwdOf(proc, pid) {
  try {
    return fs.readlinkSync(path.join(proc, String(pid), 'cwd'));
  } catch {
    return null;
  }
}

function isReaper(proc, pid) {
  try {
    const argv = fs.readFileSync(path.join(proc, String(pid), 'cmdline'), 'utf8').split('\0');
    return /systemd$/.test(path.basename(argv[0] || ''));
  } catch {
    return true;
  }
}

// What the sync engine could not do, for a toast and the timeline: without an absolute path or an address (they say
// more than the owner needs there, and the timeline is kept). A path is one when it starts with "/" or "~/"; an
// address is a URL, an scp-style one with or without a user ("alex@box2:repos/shop.git", "box2:repos/shop.git": a
// slash after the colon), or the host ssh names when it cannot reach it. A branch ("feature/login",
// "refs/heads/release/2026") and a file of the repository ("src/app.js") stay as they are.
const HIDDEN = /'?(?<![\w.+@~-])(?:[a-z][a-z0-9+.-]*:\/\/[^\s']+|[\w.-]+@[\w.-]+:[^\s']*|[\w.-]+:[^\s'\/]*\/[^\s']*|~?\/[^\s']+)'?/gi;
const HOST = /\b(resolve hostname|connect to host) [^\s:']+/gi;
// On Windows git names a folder as "C:\Users\alex\notes.git" or "\\server\share\notes.git": a path there too. A user
// name or a folder there often holds a space ("Alex Smith", "OneDrive - Example Co"), so a path git puts in quotes
// is masked up to its closing quote, also with forward slashes (C:/Users/...).
const WIN_PATH = /'(?:[a-z]:[\\/]|\\\\)[^']*'|'?(?<![\w.+@~-])(?:[a-z]:\\[^\s']*|\\\\[^\s']+)'?/gi;
export const todoText = (todo, platform = process.platform) => todo.map((x) => {
  const why = String(x.why || '');
  return (platform === 'win32' ? why.replace(WIN_PATH, '…') : why).replace(HIDDEN, '…').replace(HOST, '$1 …');
}).join('; ').slice(0, 200);

/**
 * The acts besides moving and stopping a session (those are the server's own, passed in by server.mjs). `gateways`,
 * when given, is the same list of add-ons the look checks (the demo's pretend one): restarting a gateway looks the id
 * up there first, so the look and the act mean one gateway. Without it, the computer's own add-ons (findAddon).
 */
export function defaultActs({ projects = () => projectsIn(), run = capture, runs = listRuns, proc = '/proc', gateways = null, start = null, now = Date.now } = {}) {
  const repoDir = (rel) => {
    const root = path.resolve(projects());
    const dir = path.resolve(root, String(rel || ''));
    if (!rel || path.isAbsolute(String(rel)) || !dir.startsWith(root + path.sep)) throw Object.assign(new Error('that repository is not in the workspace'), { status: 400 });
    return { root, dir, project: path.join(root, String(rel).split(/[\\/]/)[0]) };
  };
  return {
    // The process is read again by its id: only the very process the item named is ended (endProcess guards this
    // dashboard and what it runs inside). A tmux server is asked the leftover rule again at this moment: one whose
    // shells started anything since the look, or that a session's run record names now, is at work and not ended.
    async end(t) {
      if (!Number.isInteger(t.pid) || !t.proc) throw Object.assign(new Error('that process cannot be named exactly: nothing was ended'), { status: 409 });
      if (t.what === 'tmux' && !(t.socket && !sessionSocketsOf(runs).has(t.socket) && onlyIdleShells(await panesOf(t.socket, run, proc)))) throw Object.assign(new Error('a program runs in that tmux server now: nothing was ended'), { status: 409 });
      const ask = (force) => endProcess(t.pid, { force, parentLookup, kill: killProcess, expect: async (pid) => identity.of([pid]).get(pid) === t.proc });
      let r = await ask(false);
      // Windows: a program with no window cannot be asked to close, only ended at once (platform/win32.mjs NO_WINDOW).
      // The end he chose is the end SIGTERM gives it elsewhere: the same checks again, then the end at once.
      if (!r.ok && r.noWindow) r = await ask(true);
      if (!r.ok) throw Object.assign(new Error(r.error || 'it could not be ended'), { status: 409 });
      return { ended: true };
    },
    // The sync engine of `project sync` (fast-forward only); it fetches first and changes nothing when the branch is
    // no longer only behind.
    async sync(t) {
      const { dir, project } = repoDir(t.path);
      const s = await repoInfo(dir);
      if (!s.ok || s.ahead || s.changes || !s.behind) throw Object.assign(new Error('it is no longer only behind: open the project'), { status: 409 });
      const r = await syncRepo(dir, '.', capture, { push: false, root: project });
      if (r.todo?.length) throw Object.assign(new Error(todoText(r.todo)), { status: 409 });
      return { did: r.did };
    },
    // The same engine pushes a branch that is only ahead of its upstream, after a fetch.
    async push(t) {
      const { dir, project } = repoDir(t.path);
      const s = await repoInfo(dir);
      if (!s.ok || s.behind || s.changes || !s.ahead || !s.upstream) throw Object.assign(new Error('it is no longer only ahead: open the project'), { status: 409 });
      const r = await syncRepo(dir, '.', capture, { push: true, root: project });
      if (r.todo?.length) throw Object.assign(new Error(todoText(r.todo)), { status: 409 });
      return { did: r.did };
    },
    // The same conversation again with resume, nothing sent (mends.mjs): the dashboard's own start, as a restart does it.
    async reopen(t) {
      if (!start) throw Object.assign(new Error('reopening a session is not possible here'), { status: 409 });
      return reopenSession(t, { start });
    },
    // Hoprig's own old logs and temporary folders (mends.mjs ownTemp): never anything else.
    async clean() {
      const r = cleanOwnTemp({ state: stateDir(), now: now() });
      if (!r.files) throw Object.assign(new Error('there is nothing of Hoprig\'s own to clean'), { status: 409 });
      return { did: `freed ${bytesWords(r.freed)} of Hoprig's own old files` };
    },
    async restartLink() {
      const kind = link.readSwitch().kind;
      await link.turnOff({ kind });
      const r = await link.turnOn(kind);
      if (!r.ok) throw Object.assign(new Error(r.why || r.error || 'the public link did not start'), { status: 409 });
      return { did: 'restarted the public link' };
    },
    async restartGateway(t) {
      const a = (gateways ? gateways() : null)?.find((g) => g.id === t.addon) ?? findAddon(t.addon);
      if (!a) throw Object.assign(new Error('there is no such add-on'), { status: 404 });
      // A stop that is refused (a gateway its service runs is restarted through Health → Gateways) is said as it is.
      const s = await a.stop();
      if (!s.ok) throw Object.assign(new Error(`${a.title || t.addon} was not restarted: ${s.error || 'it did not stop'}`), { status: 409 });
      const r = await a.start();
      if (!r.ok) throw Object.assign(new Error(r.error || 'the gateway did not start'), { status: 409 });
      noteStarted(t.addon);
      return { did: `restarted ${t.addon}` };
    },
  };
}
