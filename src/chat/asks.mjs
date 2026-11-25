// Who answers when a chat's coding tool asks for an OK (the `ask` event of src/chat/events.mjs):
//   - bypassPermissions ("Run anything without asking"), Claude Code: the one rule of src/asking.mjs bypassAllows (the
//     shell tool, no "ask" rule for it, a command that is plainly a delete inside the folder it runs in) is answered by
//     the PermissionRequest hook the chat's process gets, as a terminal session's (src/chat/engines/claude.mjs): the
//     hook's event carries the folder the shell is in at that moment, which the chat's channel does not (a `cd sub` in
//     an earlier call moves it). The chat itself answers nothing by itself then. Claude Code sends its request and
//     starts the hook at once and takes the request back when the hook allows (seen on 2.1.326), so an ask the hook
//     may answer waits HOOK_WAIT_MS before its card is shown (no card and no "needs your OK" for a delete the hook
//     allows a moment later); what the hook allowed is read from the chat's run record and shown in the chat
//     (`allowed`). A Claude Code that does not know the event gets no hook: there the chat answers the rule itself,
//     and as its channel names no folder only an absolute target inside the chat's folder counts (plainDelete
//     relative: false). What the channel tells and a terminal's hook event does not (the engine marks it `owner`,
//     claude-lines.mjs ownerOnly): a question to him or a plan to approve, an "ask" rule of his settings that matched
//     this very call, a hook of his that says ask; Claude Code's own stop before a delete it cannot judge ("safety") is
//     the stop the rule answers. This holds only while the coding tool itself reports the mode (liveMode): where its
//     settings turn it off, or Claude entered plan mode, cards show.
//   - bypassPermissions, OpenCode: its server has no mode that asks nothing, so the chat stands in for the tool's own
//     "approve what is not denied" (its terminal's --auto, src/codetools/opencode.mjs) and allows every OK it saw
//     whole and that names no reason of the owner's, with one exception (openCodeAllows): a shell command that names a
//     delete in plain sight (src/asking.mjs mayDelete) is answered only where plainDelete says it is a plain delete
//     inside the folder it runs in. That bypass is Hoprig's own, not the tool's: Hoprig stops the deletes a coding agent
//     writes in plain sight, and is no wall against a line written to get around it. OpenCode's built-in agent allows every action (2.3), so a bypass chat's conversation asks for every
//     shell call (src/chat/engines/served.mjs modeRules) and the chat answers it here at once (measured on the real
//     OpenCode 2.3: 5 to 10 ms from the ask to the answer); edits, pages and other folders stay unasked. What the
//     owner's own OpenCode config says "ask" for is answered "allow" here (but for a delete as above): that is what
//     OpenCode's own automatic mode does (approve what is not denied), and the chat stands in for it. His "deny" stays
//     a deny (his deny rules follow the chat's own); one he adds while a bypass chat runs holds from its next start.
//   - every other mode: a card. "Allow in this chat" adds the coding tool's own suggestion for the running process
//     and is remembered in the chat (grants): a process started again gets them with its start, and an ask that a
//     remembered grant covers is answered from it when a rule settles that kind of ask (the engine's `settled`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BYPASS, SHELL_TOOL, bypassAllows, mayDelete, plainDelete, projectFolders } from '../asking.mjs';
import { configDir, hookFile, stateDir } from '../paths.mjs';
import { askedWhat } from '../hook.mjs';
import { readRun } from '../runs.mjs';
import { chatCard, handsOffAsk } from './handsoff.mjs';
import { mcpContent } from './mcpask.mjs';

import { rememberAllowed } from './turns.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';

const GRANTS_MAX = 500; // what "allow in this chat" covered, kept per chat (the oldest go first)
// How long an ask the hook may answer waits before its card shows: the hook answered in about 0.1 s on 2.1.326 and
// Claude Code gives it at most 5 s (launch.mjs). One it answers later still closes its card when the request is taken back.
export const HOOK_WAIT_MS = 2000;

const isClaude = (chat) => !chat.engine || !chat.engine.id || chat.engine.id === 'claude';
function places(chat, relative) {
  const home = os.homedir();
  const workspace = workspaceDir();
  return { home, workspace, projects: projectFolders({ workspace, home, chosen: projectsIn() }), hoprig: [configDir(), stateDir(), path.dirname(path.dirname(hookFile()))], own: chat.cwd || null, cwd: chat.cwd || null, relative };
}

/**
 * Does an OpenCode chat in bypass mode answer this OK by itself (see above)? Every permission it saw whole that names
 * no reason of the owner's, except a shell command (OpenCode's shell action, under any tool name) that names a delete in
 * plain sight (mayDelete) and is not a plain delete inside the folder it runs in; a shell call whose command is not one
 * line of text is not answered either. That folder is known here: OpenCode 2.3's shell tool starts every command afresh, in its
 * `workdir` (resolved against the conversation's folder) or else in the conversation's own folder, the chat's (its
 * Shell.create: cwd = path.resolve(directory, workdir ?? directory)), so a relative target is read as in a terminal.
 * But OpenCode reads a workdir in its own way too (`~` and `~/x` are the home folder: its FileAccess, from
 * ShellTool.prepare), so a call is answered by itself only without a workdir or with a plain one (relative, or absolute)
 * inside the chat's folder (shellFolder); any other workdir is a card, whatever the command.
 */
export function openCodeAllows(chat, ev, mode, { scan = mayDelete } = {}) {
  if (mode !== BYPASS || ev.type !== 'permission' || ev.owner) return false;
  const input = ev.full && typeof ev.full === 'object' ? ev.full : {};
  if (!ev.shell && ev.tool !== SHELL_TOOL) return true;
  if (chat.session && chat.session.deniesUnread) return false; // his deny rules could not be read: every command is his
  const command = input.command ?? input.cmd;
  if (typeof command !== 'string') return false;
  const cwd = shellFolder(chat.cwd, input.workdir);
  if (!cwd) return false;
  // A scan or a look that throws must never leave the question unanswered (the event's reader would drop it as a
  // broken line, and the session would wait for ever): what cannot be judged is the owner's to answer, as a card.
  try {
    if (!scan(command)) return true;
    return plainDelete(command, { ...places(chat, true), cwd });
  } catch {
    return false;
  }
}

/**
 * The folder a shell call of an OpenCode chat runs in, where the chat can be sure of it: the chat's folder without a
 * workdir, else a workdir written plainly (no ~, $, backtick or backslash, no .. part), relative or absolute, that is
 * the chat's folder or inside it by its text and by its real place. Else null.
 */
export function shellFolder(cwd, workdir) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  if (workdir === undefined || workdir === null) return cwd;
  if (typeof workdir !== 'string' || /[~$`\\]/.test(workdir) || workdir.split('/').includes('..')) return null;
  // OpenCode's own sample call writes workdir: process.cwd(), and its tool text asks for a workdir instead of cd: an
  // absolute one that is the chat's folder or inside it, by its text and its real place, is as good as none.
  const dir = path.isAbsolute(workdir) ? path.normalize(workdir).replace(/(.)\/+$/, '$1') : path.resolve(cwd, workdir);
  const within = (d, root) => d === root || d.startsWith(`${root}/`);
  if (!within(dir, cwd)) return null;
  let realDir;
  let realCwd;
  try {
    realDir = fs.realpathSync(dir);
    realCwd = fs.realpathSync(cwd);
  } catch {
    return null; // a folder that is not there: OpenCode cannot start the command in it either
  }
  return within(realDir, realCwd) ? dir : null;
}

// What the chat answers by itself for an ask in `mode`. "safety" is no reason of the owner's here (see above).
function byBypass(chat, ev, mode) {
  if (!isClaude(chat)) return openCodeAllows(chat, ev, mode);
  if (chat.session && chat.session.hooked) return false; // the hook answers, with the shell's real folder
  return bypassAllows({ mode, tool: ev.tool, input: ev.full, why: ev.owner === 'safety' ? null : ev.owner, places: places(chat, false) });
}

// An ask the chat's hook may still answer (see above): Claude Code with the hook, in bypass mode, the shell tool, no
// reason of the owner's but Claude Code's own stop.
const hookMayAnswer = (chat, ev, mode) => isClaude(chat) && !!(chat.session && chat.session.hooked) && mode === BYPASS && ev.type === 'permission' && ev.tool === SHELL_TOOL && (!ev.owner || ev.owner === 'safety');

const fail = (status, message) => Object.assign(new Error(message), { status });

export const keepGrants = (list) => new Set((Array.isArray(list) ? list : []).filter((g) => typeof g === 'string').slice(-GRANTS_MAX));

/** An ask came: answered by the chat where the mode or a remembered grant settles it, else a card for the owner. */
export function askArrived(chat, ev) {
  // An MCP server's question (mcpask.mjs): always his card. No mode, grant, hook or Hands-off answers it.
  if (ev.type === 'mcp') {
    chat.pending.set(ev.request, ev);
    const { full, interactive, owner, grant: g, settled, ...shown } = ev;
    chat.push(shown);
    chat.changed();
    return;
  }
  const grant = ev.grant;
  // No card: the mode allows everything, or the owner already allowed exactly this for the chat and only the
  // process is new (it gets the rule again with the answer).
  const allowedBefore = !ev.owner && !!grant && ev.settled && grant.atoms.every((a) => chat.grants.has(a));
  const mode = chat.bypass && (!chat.liveMode || chat.liveMode === BYPASS) ? BYPASS : chat.liveMode;
  const byMode = byBypass(chat, ev, mode);
  if ((byMode || allowedBefore) && chat.session) {
    chat.session.answer(ev.request, { allow: true, input: ev.full, permissions: byMode ? null : grant.updates });
    return;
  }
  if (hookMayAnswer(chat, ev, mode)) {
    const timer = setTimeout(() => {
      if (chat.held.delete(ev.request)) show(chat, ev);
    }, chat.o.hookWaitMs ?? HOOK_WAIT_MS);
    timer.unref?.();
    chat.held.set(ev.request, { timer, ev });
    return;
  }
  show(chat, ev);
}

// The card for an ask: it waits for the owner.
function show(chat, ev) {
  const grant = ev.grant;
  // The exact card (askcard.mjs): what the tool's channel gave, its key checked again at the answer.
  ev.card = chatCard(chat, ev);
  chat.pending.set(ev.request, ev);
  // The page gets the input to show and what "allow in this chat" covers; the rest stays here.
  const { full, interactive, reasonType, reason, ruleForced, manualOnly, noAlways, settled, owner, subjectCut, judged, shell, grant: g, ...shown } = ev;
  chat.push({ ...shown, canAlways: !!grant, always: grant ? (grant.edits ? 'edits' : 'rule') : null, alwaysText: grant && !grant.edits ? grant.text : '', canProject: !!(grant && grant.project), projectText: grant && grant.project ? grant.projectText : '' });
  chat.changed();
  // Hands-off (chat/handsoff.mjs): where it is on and has an answer, it answers now, through answerAsk.
  try {
    handsOffAsk(chat, ev, answerAsk);
  } catch {
    /* the card stays for the owner */
  }
}

/**
 * The owner's answer to an ask. a: { allow, always (true: only for this chat, the coding tool's own session
 * suggestions; 'project': "Always allow in this project", the same rules sent with Claude Code's localSettings
 * destination, which Claude Code itself keeps in the project's local settings file), answers (a question: question → chosen label), mode (a plan approved: the permission mode
 * to go on in), message }.
 */
export function answerAsk(chat, request, a) {
  const ask = chat.pending.get(request);
  if (!ask) throw fail(409, 'that question was already answered');
  if (!chat.session) throw fail(409, `${chat.engine.label} is not running in this chat`);
  // The answer goes only to the very ask its card showed: `key` (askcard.mjs askKey) is checked again now.
  if (a.key !== undefined && a.key !== null && (!ask.card || a.key !== ask.card.key)) throw fail(409, 'the question changed. Look at it again');
  // An MCP server's question takes only the person's own answer to it (the route refuses Tia's door), and only that.
  if (ask.type === 'mcp' || a.mcp) return answerMcp(chat, request, ask, a);
  let outcome = 'denied';
  if (a.allow) {
    const input = ask.tool === 'AskUserQuestion' && a.answers ? { ...ask.full, answers: a.answers } : ask.full;
    const project = a.always === 'project' && ask.grant && ask.grant.project ? ask.grant.project : null;
    const grant = a.always && !project ? ask.grant : null;
    let permissions = project || (grant ? grant.updates : null);
    if (ask.type === 'plan' && a.mode) {
      permissions = [{ type: 'setMode', mode: a.mode === 'manual' ? 'default' : a.mode, destination: 'session' }];
      chat.permissionMode = a.mode;
      chat.bypass = a.mode === 'bypassPermissions';
      chat.emit('record');
    }
    chat.session.answer(request, { allow: true, input, permissions });
    outcome = a.by === 'handsoff' ? 'handsoff' : project ? 'allowed-project' : grant ? 'allowed-always' : 'allowed';
    const remember = grant ? grant.atoms : project ? ask.grant.projectAtoms || [] : [];
    if (remember.length) {
      for (const x of remember) chat.grants.add(x);
      for (const x of [...chat.grants].slice(0, Math.max(0, chat.grants.size - GRANTS_MAX))) chat.grants.delete(x);
      chat.emit('record'); // kept with the chat (feature.mjs saves the open chats)
    }
  } else {
    const why = a.message ? `: ${a.message.replace(/[\s.!?]+$/, '')}.` : '.';
    chat.session.answer(request, { allow: false, message: `The user said no to this ${ask.tool} call in the dashboard${why} Do not do it another way; wait for the user to say how to go on.` });
  }
  chat.pending.delete(request);
  chat.push({ kind: 'ask-closed', request, outcome });
  chat.changed();
}

/**
 * The person's answer to an MCP server's question: a.mcp { action: 'accept' | 'decline', content (accept, a form) }.
 * The content is held against the fields the server asked for (mcpContent) before it goes back. Nothing else answers
 * it: an OK, Hands-off (`by`), or an answer for another kind of ask.
 */
function answerMcp(chat, request, ask, a) {
  if (ask.type !== 'mcp' || !a.mcp || a.by) throw fail(409, 'only you answer a question an MCP server asks, in its own card');
  const action = a.mcp.action;
  if (action !== 'accept' && action !== 'decline') throw fail(400, 'say accept or decline');
  const content = action === 'accept' && ask.mode === 'form' ? mcpContent(ask.fields, a.mcp.content ?? {}) : null;
  chat.session.answer(request, { mcp: { action, content } });
  chat.pending.delete(request);
  chat.push({ kind: 'ask-closed', request, outcome: action === 'accept' ? 'mcp-accepted' : 'mcp-declined' });
  chat.changed();
}

/** Switched to bypass: what waits for an OK that is not the owner's own word is allowed now. */
export function allowPending(chat) {
  for (const [r, ask] of [...chat.pending]) {
    if (ask.type === 'mcp' || !byBypass(chat, ask, BYPASS)) continue; // an MCP server's question stays his
    chat.session.answer(r, { allow: true, input: ask.full, permissions: null });
    chat.pending.delete(r);
    chat.push({ kind: 'ask-closed', request: r, outcome: 'allowed' });
  }
  chat.changed();
}

/**
 * The coding tool took its request back. For Claude Code with the hook that is how the hook's "allow" shows (an
 * allow that came after the owner's own answer is not honoured, and no request is taken back then): the chat shows an
 * "allowed" line only for a request it held or showed and saw taken back, from the entry the hook wrote into the
 * chat's run record for that same command (hook.mjs), now or a moment later (the record is written as the hook ends).
 */
export function askCancelled(chat, request) {
  const held = chat.held.get(request);
  let ev = null;
  let shown = false;
  if (held !== undefined) {
    clearTimeout(held.timer);
    chat.held.delete(request);
    ev = held.ev;
  } else if (chat.pending.has(request)) {
    ev = chat.pending.get(request);
    chat.pending.delete(request);
    shown = true;
  }
  // A card already shown (a hook slower than the hold) closes as allowed by Hoprig when the hook allowed it, else as
  // no longer waiting.
  const close = (allowed) => shown && chat.push({ kind: 'ask-closed', request, outcome: allowed ? 'hoprig' : 'cancelled' });
  if (ev && chat.session && chat.session.hooked && ev.tool === SHELL_TOOL) {
    const what = askedWhat({ tool_input: ev.full });
    if (hookAllowed(chat, what, ev.toolId)) close(true);
    else {
      const again = setTimeout(() => {
        close(hookAllowed(chat, what, ev.toolId));
        chat.changed();
      }, 1000);
      again.unref?.();
    }
  } else close(false);
  chat.changed();
}

/**
 * The entry of the chat's run record (`allowed`, numbered by the hook under the record's lock) for command `what` that
 * the chat has not shown yet, shown now: true when there was one. The entry is found by the command's text (the event
 * names no request), so a late entry of an allow that lost to the owner's own answer can stand for the next take-back
 * of the same command: its line is then still true (that one was allowed), only its time is the earlier one.
 */
export function hookAllowed(chat, what, toolId = null) {
  const file = chat.session && chat.session.hold;
  const run = file ? readRun(file) : null;
  const list = run && Array.isArray(run.allowed) ? run.allowed : [];
  // Each start of the process has a record of its own, numbered from 1: what was shown is kept by record and number.
  const key = (x) => `${file}#${x.n}`;
  const a = list.find((x) => x && Number.isInteger(x.n) && x.what === what && !chat.allowedShown.has(key(x)));
  if (!a) return false;
  chat.allowedShown.add(key(a));
  if (chat.allowedShown.size > 200) chat.allowedShown.delete(chat.allowedShown.values().next().value);
  // `folder`: where the command ran when that is not the chat's own folder (the hook's event says it).
  const line = { tool: String(a.tool || '').slice(0, 80), what: String(a.what || '').slice(0, 200), ...(typeof a.folder === 'string' && a.folder ? { folder: a.folder.slice(0, 200) } : {}), at: Number(a.at) || Date.now() };
  chat.push({ kind: 'allowed', ...line });
  // Kept with the tool call, so a page opened again after a restart shows it too (turns.mjs).
  if (chat.o && chat.o.turnsDir) rememberAllowed(chat.o.turnsDir, chat.conversationId, toolId, line);
  return true;
}

/** Every open ask is closed (the turn ended, the process stopped). */
export function cancelAsks(chat) {
  for (const r of chat.pending.keys()) chat.push({ kind: 'ask-closed', request: r, outcome: 'cancelled' });
  chat.pending.clear();
  for (const h of chat.held.values()) clearTimeout(h.timer);
  chat.held.clear();
}
