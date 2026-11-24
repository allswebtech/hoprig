// Hands-off's switches (src/handsoff.mjs says what it answers): set here, from the page behind its login, never from a
// file in a project. A command of a session runs as the same user and can write Hoprig's config and state like any
// other file of that user; Hands-off is no fence against its own session (which could as well run what it asks about).
// What holds: the hook takes neither the switch nor whose switch counts from the run record handed to the session.
//   GET  /api/handsoff?dir=<folder>          → { on, stale, note, dir } for the project that holds the folder
//   GET  /api/handsoff                       → { projects: [{ dir, on, stale, note }] } every project with a switch or a note
//   POST /api/handsoff/project               { dir, on?, note? }   the project's switch and its note (Hoprig's config)
//   POST /api/handsoff/session               { name, on }          a terminal session's own switch (Hoprig's config,
//                                            under its run id; never the run record, which the session is handed):
//                                            off stops it at once; on again also ends a stop and starts the hour again
// A switch is stored with the Hoprig version it was turned on under: after an update it reads as off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handsOffOffered, hoprigVersion, projectEntry, sessionEntry, settingsHoldWall, switchState } from '../handsoff.mjs';
import { hookSettingsDir, runsDir, stateDir } from '../paths.mjs';
import { changeRun, readRun } from '../runfile.mjs';
import { listRuns } from '../runs.mjs';
import { insideRoots, resolveRoots } from './folders.mjs';

// Can the hook hold a command for this session? Only when the settings Hoprig handed it at its start carry the wall's
// PreToolUse hold (launch.mjs hookSettings, installed while Hands-off is offered). A session started before the hold
// existed, or on a coding tool that has no such hook, cannot have Hands-off turned on: it would answer questions but
// never hold an act. Read from the handed settings file, which lives beside the run records (launch.mjs settingsFile).
export function sessionHasHold(runId) {
  try {
    return settingsHoldWall(JSON.parse(fs.readFileSync(path.join(hookSettingsDir(), `${path.basename(String(runId))}.json`), 'utf8')));
  } catch {
    return false;
  }
}

// A run that is on but whose handed settings carry no wall hold cannot be covered (it was started before Hands-off
// could hold its commands, or on a coding tool with no such hook): its name, so the owner can be told it is answered
// but never held. The PreToolUse hook reads the switch from the config itself (launch.mjs), so nothing is written to
// start it: a file the session can reach, or one that goes stale after an update, must never decide whether the wall
// runs. → the run's name when it is on but uncovered, else null.
function uncoveredName(cfg, version, runId) {
  const id = path.basename(String(runId));
  const run = readRun(path.join(runsDir(), `${id}.json`));
  const on = !!run && switchState({ session: sessionEntry(cfg, id), project: projectEntry(cfg, run.cwd), version, stopped: run.handsOffStop }).on;
  if (on && !sessionHasHold(id)) return run && typeof run.termName === 'string' && run.termName ? run.termName : id;
  return null;
}

const NOTE_MAX = 2000;
export const NOT_OFFERED = 'Hands-off is not offered on this computer';

// A single marker in the state folder, present while any Hands-off switch (a project's or a session's, at this
// version) is on. The PreToolUse hook's cheap shell test reads it (launch.mjs): with no switch on anywhere, an
// ordinary command starts no node process. The hook still reads the switch itself and is the authority, so the
// marker only decides whether to START the hook; a marker left behind merely wastes a start. It sits inside Hoprig's
// state folder, which the wall protects, so a session cannot remove it to go unheld.
const activeMark = () => path.join(stateDir(), 'handsoff-active');
const anyOn = (cfg, version) => {
  const ho = (cfg && cfg.handsOff) || {};
  return [...Object.values(ho.projects || {}), ...Object.values(ho.sessions || {})].some((e) => e && e.on === true && e.version === version);
};
function syncActive(cfg, version) {
  try {
    if (anyOn(cfg, version)) fs.writeFileSync(activeMark(), '', { mode: 0o600 });
    else fs.rmSync(activeMark(), { force: true });
  } catch {
    /* best effort: the hook reads the switch itself, so a missing sync only affects the cheap gate, never a hold */
  }
}

export function handsOffFeature(ctx, { version = hoprigVersion() } = {}) {
  const bad = (m) => new ctx.HttpError(400, m);
  const folder = (dir) => {
    // "~" and "~/…" are the home folder, as the owner writes them; any other relative path is no folder.
    const full = typeof dir === 'string' && (dir === '~' || dir.startsWith('~/')) ? path.join(os.homedir(), dir.slice(1)) : dir;
    if (typeof full !== 'string' || !path.isAbsolute(full)) throw bad('write the folder\'s full path, or one that starts with ~/');
    const d = insideRoots(path.normalize(full), resolveRoots(ctx.config().server.roots));
    if (!d) throw bad('choose a folder inside the allowed roots');
    return d;
  };
  // The live sessions in folder `dir` that the switch answers for but whose acts it cannot hold (uncoveredName). Read
  // on every look at the project, so the page's line about them stays while they run (and goes when they end). Only
  // where Hands-off is offered: otherwise no record is read for it.
  const uncoveredIn = (cfg, dir) => {
    const out = [];
    if (!handsOffOffered(cfg)) return out;
    try {
      const under = (c) => typeof c === 'string' && (c === dir || c.startsWith(`${dir}/`));
      for (const r of listRuns({ chats: false, usage: false, only: (r) => r.status !== 'ended' && under(r.cwd) })) {
        const u = uncoveredName(cfg, version, r.runId);
        if (u) out.push(u);
      }
    } catch {
      /* best effort: the switch still holds through the hook */
    }
    return out;
  };
  const view = (dir) => {
    const cfg = ctx.config();
    const e = projectEntry(cfg, dir);
    const st = switchState({ project: e, version });
    const uncovered = st.on ? uncoveredIn(cfg, e ? e.dir : dir) : [];
    return { dir: e ? e.dir : dir, on: st.on, stale: st.stale, note: st.note, ...(uncovered.length ? { uncovered } : {}) };
  };
  // While Hands-off is not offered nothing of it is written: a switch stored now would read as on the day it is
  // offered under the same version. Checked before the body is read, so nothing is read or written.
  const offered = () => {
    if (!handsOffOffered(ctx.config())) throw new ctx.HttpError(409, NOT_OFFERED);
  };
  // At mount, bring the hook's cheap gate in step with the config: after an update, switches read as off (their
  // version no longer matches), so the marker is cleared and ordinary commands start no node again.
  try {
    syncActive(ctx.config(), version);
  } catch {
    /* ctx may not be ready at mount; the routes sync on every change */
  }
  return {
    name: 'handsoff',
    routes: [
      ['GET', /^\/api\/handsoff$/, async (req, m, q) => {
        if (q.get('dir')) return view(folder(q.get('dir')));
        const all = (ctx.config().handsOff && ctx.config().handsOff.projects) || {};
        return { projects: Object.keys(all).sort().map((dir) => view(dir)) };
      }],
      ['POST', /^\/api\/handsoff\/project$/, async (req) => {
        offered();
        const b = await ctx.readJson(req);
        const dir = folder(b.dir);
        if (b.on !== undefined && typeof b.on !== 'boolean') throw bad('say on: true or false');
        if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > NOTE_MAX)) throw bad(`the note is text of at most ${NOTE_MAX} characters`);
        const cfg = ctx.config();
        const all = { ...((cfg.handsOff && cfg.handsOff.projects) || {}) };
        const was = all[dir] || {};
        all[dir] = {
          on: b.on === undefined ? was.on === true && was.version === version : b.on,
          version,
          // When the switch was pressed: the project turned off after a session's own switch stops that one too.
          at: b.on === undefined ? Number(was.at) || 0 : Date.now(),
          note: b.note === undefined ? String(was.note || '') : b.note.trim(),
        };
        const next = { handsOff: { ...(cfg.handsOff || {}), projects: all } };
        ctx.saveConfig(next);
        syncActive(next, version); // keep the hook's cheap gate in step: the marker is present while any switch is on
        // The PreToolUse hook reads this switch itself, so turning it on needs nothing written per session. But a live
        // session in this folder that carries no wall hold cannot be covered (started before Hands-off): the view
        // names those, now and on every later read, so the owner is told the switch answers their questions but holds
        // none of their acts.
        return view(dir);
      }],
      ['POST', /^\/api\/handsoff\/session$/, async (req) => {
        offered();
        const b = await ctx.readJson(req);
        if (typeof b.name !== 'string' || typeof b.on !== 'boolean') throw bad('say name and on: true or false');
        let found = await ctx.deck.find(b.name);
        // A move is in flight for this terminal (deck.movingTerm): the old launcher is handing the conversation to a new
        // one, so its run id is changing. For a moment the old record may still be there, or be gone with the new one not
        // written yet. Writing the switch against the run as it is now could land on the OLD id that is going away: its
        // entry never reaches the new run, and the session keeps following the project switch as before (the owner's
        // press lost). So wait for the move to settle, then write the run that remains, so the press reaches the new run.
        // Bounded by 5 s, so a stuck move still answers rather than hanging the press.
        if (found && ctx.deck.movingTerm?.(found.term.id)) {
          const until = Date.now() + 5000;
          while (Date.now() < until && found && (ctx.deck.movingTerm?.(found.term.id) || !found.run)) {
            await new Promise((r) => setTimeout(r, 150));
            found = await ctx.deck.find(b.name);
          }
        }
        if (!found || !found.run || !found.run.runId) throw new ctx.HttpError(404, 'no such coding session');
        const runId = path.basename(String(found.run.runId));
        const file = path.join(runsDir(), `${runId}.json`);
        // Turning it on needs the wall's hold in the session's handed settings, or Hands-off could answer a question
        // but never hold an act. A session started without it is left as it is, with the one line why.
        if (b.on && !sessionHasHold(runId)) throw new ctx.HttpError(409, 'This session started before Hands-off could hold its commands; start it again to turn Hands-off on.');
        // The loop's stop and its count stay in the run record: they only ever stop Hands-off, never start it.
        const next = changeRun(file, (run) => ({ ...run, handsOffStop: null, handsOffRow: 0 }));
        if (!next) throw new ctx.HttpError(404, 'the session ended');
        const cfg = ctx.config();
        const was = (cfg.handsOff && cfg.handsOff.sessions) || {};
        // Sessions whose record is gone are dropped as the list is written.
        // A session just moved (deck.mjs handedOver) keeps its entry while its new launcher has not written its record.
        const sessions = Object.fromEntries(Object.entries(was).filter(([id]) => id !== runId && (fs.existsSync(path.join(runsDir(), `${path.basename(id)}.json`)) || !!ctx.deck.handedOver?.(id))));
        sessions[runId] = { on: b.on, version, at: Date.now() };
        // The session was moved while this old record stayed (its coding tool still ends): the move has handed it to a
        // new run id already, which the press must reach too, or the new run would follow the switch as it was before.
        const to = ctx.deck.forwardOf?.(runId);
        if (to) sessions[to] = sessions[runId];
        // A moving mark whose record has gone silences nothing: it goes here, with the stale entries above.
        const moving = Object.fromEntries(Object.entries((cfg.handsOff && cfg.handsOff.moving) || {}).filter(([id]) => fs.existsSync(path.join(runsDir(), `${path.basename(id)}.json`))));
        const ho = { ...(cfg.handsOff || {}), sessions, moving };
        if (!Object.keys(moving).length) delete ho.moving;
        const saved = { handsOff: ho };
        ctx.saveConfig(saved);
        syncActive(saved, version); // keep the hook's cheap gate in step with the switch
        // The PreToolUse hook reads this switch from the config itself (launch.mjs), so an off takes hold at the next
        // tool call; the marker only decides whether to start the hook, and nothing the session can reach decides it.
        ctx.poke();
        return { on: b.on };
      }],
    ],
  };
}
