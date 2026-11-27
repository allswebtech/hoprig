// Hands-off in a session of the App (src/handsoff.mjs says what it answers). The card is shown first, as without it;
// then, where the switch is on and the rule has an answer, the answer goes through answerAsk, the very function the
// owner's own press uses (no other way to answer), and the chat shows "Answered by Hoprig: …" and writes one line in
// Activity. Three answers with no work between them (a tool call that is no question or plan, a message of the
// owner's) stop it for the chat until he turns it on again (a loop).
import os from 'node:os';
import path from 'node:path';
import { projectFolders } from '../asking.mjs';
import { cardOf, heldCard, heldRecord } from '../askcard.mjs';
import { createActivityLog } from '../automation/store.mjs';
import { BECAUSE, HOUR_MAX, LOOP_MAX, WORK_TOOLS, answerText, decide, handsOffOffered, hoprigVersion, hourFull, keptMode, projectEntry, switchState } from '../handsoff.mjs';

import { herHeld } from '../hook.mjs';
import { configDir, defaultWorkspaceDir, hookFile, stateDir } from '../paths.mjs';
import { wallHeld } from '../wall.mjs';

const VERSION = hoprigVersion();

/** The exact card of a chat's ask (askcard.mjs), from what the coding tool's channel gave. */
export function chatCard(chat, ev) {
  const engine = chat.engine && chat.engine.id && chat.engine.id !== 'claude' ? chat.engine.id : 'claude';
  const input = ev.type === 'plan' ? { plan: ev.plan || '' } : ev.full;
  const card = cardOf({ tool: ev.tool, input, engine, source: 'channel', what: ev.subject || '' });
  // A held act (the wall, src/wall.mjs): the chat's ask carries the same `held` a terminal's card does, so the page
  // draws the same card (what the session wanted, why it is his, Allow once / No) instead of the hook's line under the
  // tool's own title. Only a permission, and only where Hands-off is offered on this computer (the wall runs then).
  const cfg = chat.o && chat.o.handsOffConfig ? chat.o.handsOffConfig() : {};
  // A chat of hers carries the hold whatever Hands-off says (hook.mjs sessionHold), so its card is drawn there too.
  const hers = !!(chat.byTia || chat.hers || chat.restoredMark);
  // The floor of "Allow everything" (asks.mjs): its card is the floor's own words, not Hands-off's wall card.
  if (ev.type === 'permission' && !ev.floor && (handsOffOffered(cfg) || hers)) {
    const places = chatPlaces(chat, cfg);
    let held = wallHeld({ tool: ev.tool, input: ev.full, cwd: chat.cwd, places });
    // In a chat of hers the hook held what her level leaves (at Full: not the administrator act), unless Hands-off's
    // switch is on for it, which holds the whole wall first (hook.mjs preToolHold; the hold ignores a stop). The card
    // names the act the hook held: `sudo rm -rf ../x` at Full is a delete outside the folder, not administrator rights.
    if (held && hers && !(handsOffOffered(cfg) && switchState({ session: chat.handsOff, project: projectEntry(cfg, chat.cwd), version: VERSION }).on)) {
      held = herHeld(held, { tool_name: ev.tool, tool_input: ev.full, cwd: chat.cwd }, { cfg, places, version: VERSION });
    }
    if (held) card.held = heldCard(heldRecord(held, ev.tool));
  }
  return card;
}

// The folders the wall reads a delete and a touch of Hoprig's files against, for the chat's folder (as hook.mjs
// sessionFacts builds them for a terminal). The chat stands in one folder, so `own` and `cwd` are both chat.cwd.
function chatPlaces(chat, cfg) {
  const home = os.homedir();
  const ws = process.env.HOPRIG_WORKSPACE_DIR;
  const workspace = ws && path.isAbsolute(ws) ? path.normalize(ws)
    : typeof cfg.workspaceDir === 'string' && path.isAbsolute(cfg.workspaceDir) ? path.normalize(cfg.workspaceDir)
      : defaultWorkspaceDir();
  return { home, workspace, projects: projectFolders({ workspace, home, chosen: cfg.projectsDir }), hoprig: [configDir(), stateDir(), path.dirname(path.dirname(hookFile()))], own: chat.cwd, cwd: chat.cwd, relative: true };
}

/** Is Hands-off on for `chat` now? → switchState's { on, stale, note, loop } */
export function chatSwitch(chat, cfg = chat.o && chat.o.handsOffConfig ? chat.o.handsOffConfig() : {}, version = VERSION) {
  // Not offered on this computer: Hands-off is as if it did not exist (no answer, nothing shown), whatever is stored.
  if (!handsOffOffered(cfg)) return { on: false, stale: false, note: '', loop: false, stopped: null, since: 0 };
  return switchState({ session: chat.handsOff, project: projectEntry(cfg, chat.cwd), version, stopped: chat.handsOffStop });
}

/**
 * Work came between Hands-off's answers (a call that changes something: an edit, a write, a command; or a message of
 * the owner's): the count starts again. A read or a search is no work.
 */
export function workSeen(chat, ev = null) {
  if (ev && (ev.kind !== 'tool' || !WORK_TOOLS.has(ev.name))) return;
  chat.handsOffRow = 0;
}

/** The ask `ev` was shown: answer it for the owner where Hands-off is on and has an answer. → true when it did. */
export function handsOffAsk(chat, ev, answer, o = {}) {
  if (ev.type !== 'question' && ev.type !== 'plan') return false; // a permission: the mode's own rules, as before
  const st = chatSwitch(chat, o.cfg, o.version);
  if (!st.on) return false;
  const card = ev.card || chatCard(chat, ev);
  const stop = (chat.handsOffRow || 0) >= LOOP_MAX ? 'loop' : hourFull(chat.handsOffTimes, o.now ?? Date.now(), st.since) ? 'hour' : null;
  if (stop) {
    chat.handsOffStop = stop;
    chat.emit('record');
    chat.push({ kind: 'handsoff', stopped: stop, request: ev.request });
    return false;
  }
  const d = decide(card, { note: st.note, mode: chat.permissionMode });
  if (!d.answer) {
    chat.push({ kind: 'handsoff', waits: d.wait, request: ev.request });
    return false;
  }
  const a = card.kind === 'plan' ? { allow: true, mode: keptMode(chat.permissionMode), by: 'handsoff' } : { allow: true, answers: d.answer.answers, by: 'handsoff' };
  answer(chat, ev.request, a);
  chat.handsOffRow = (chat.handsOffRow || 0) + 1;
  chat.handsOffTimes = [...(Array.isArray(chat.handsOffTimes) ? chat.handsOffTimes : []), o.now ?? Date.now()].slice(-HOUR_MAX);
  chat.emit('record'); // the count and the times are kept with the chat (feature.mjs saves the open chats)
  const text = answerText(card, d);
  chat.push({ kind: 'handsoff', request: ev.request, text, because: d.because, question: card.kind === 'question' ? card.questions.map((x) => x.question).join(' · ').slice(0, 300) : '' });
  const did = card.kind === 'plan' ? `${text} (for you)` : `answered "${card.questions.map((x) => x.question).join(' · ').slice(0, 200)}" with "${text}" for you, ${BECAUSE[d.because]}`;
  createActivityLog(o.log || path.join(stateDir(), 'automation.log')).add({ automation: 'handsoff', session: `chat:${chat.id}`, did });
  return true;
}
