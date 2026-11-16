// Who answers when a chat's coding tool asks for an OK (the `ask` event of src/chat/events.mjs):
//   - bypassPermissions ("Run anything without asking"): the chat allows it at once, with no card. Three things stay
//     the owner's, because they are his own word or cannot be taken back (the engine marks them `owner`): a question
//     to him or a plan to approve, what his own settings insist on (an "ask" rule, a hook that says ask), and the
//     coding tool's stop before a delete that could empty the disk. This holds only while the coding tool itself
//     reports the mode: where its settings turn it off, cards show.
//   - every other mode: a card. "Allow in this chat" adds the coding tool's own suggestion for the running process
//     and is remembered in the chat (grants): a process started again gets them with its start, and an ask that a
//     remembered grant covers is answered from it when a rule settles that kind of ask (the engine's `settled`).
const GRANTS_MAX = 500; // what "allow in this chat" covered, kept per chat (the oldest go first)

const fail = (status, message) => Object.assign(new Error(message), { status });

export const keepGrants = (list) => new Set((Array.isArray(list) ? list : []).filter((g) => typeof g === 'string').slice(-GRANTS_MAX));

/** An ask came: answered by the chat where the mode or a remembered grant settles it, else a card for the owner. */
export function askArrived(chat, ev) {
  const grant = ev.grant;
  // No card: the mode allows everything, or the owner already allowed exactly this for the chat and only the
  // process is new (it gets the rule again with the answer).
  const allowedBefore = !!grant && ev.settled && grant.atoms.every((a) => chat.grants.has(a));
  if (!ev.owner && (chat.bypass || allowedBefore) && chat.session) {
    chat.session.answer(ev.request, { allow: true, input: ev.full, permissions: chat.bypass ? null : grant.updates });
    return;
  }
  chat.pending.set(ev.request, ev);
  // The page gets the input to show and what "allow in this chat" covers; the rest stays here.
  const { full, interactive, reasonType, reason, ruleForced, manualOnly, noAlways, settled, owner, subjectCut, judged, grant: g, ...shown } = ev;
  chat.push({ ...shown, canAlways: !!grant, always: grant ? (grant.edits ? 'edits' : 'rule') : null, alwaysText: grant && !grant.edits ? grant.text : '' });
  chat.changed();
}

/**
 * The owner's answer to an ask. a: { allow, always (only for this chat: the coding tool's own session suggestions,
 * never a settings file), answers (a question: question → chosen label), mode (a plan approved: the permission mode
 * to go on in), message }.
 */
export function answerAsk(chat, request, a) {
  const ask = chat.pending.get(request);
  if (!ask) throw fail(409, 'that question was already answered');
  if (!chat.session) throw fail(409, `${chat.engine.label} is not running in this chat`);
  let outcome = 'denied';
  if (a.allow) {
    const input = ask.tool === 'AskUserQuestion' && a.answers ? { ...ask.full, answers: a.answers } : ask.full;
    const grant = a.always ? ask.grant : null;
    let permissions = grant ? grant.updates : null;
    if (ask.type === 'plan' && a.mode) {
      permissions = [{ type: 'setMode', mode: a.mode === 'manual' ? 'default' : a.mode, destination: 'session' }];
      chat.permissionMode = a.mode;
      chat.bypass = a.mode === 'bypassPermissions';
      chat.emit('record');
    }
    chat.session.answer(request, { allow: true, input, permissions });
    outcome = grant ? 'allowed-always' : 'allowed';
    if (grant) {
      for (const x of grant.atoms) chat.grants.add(x);
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

/** Switched to bypass: what waits for an OK that is not the owner's own word is allowed now. */
export function allowPending(chat) {
  for (const [r, ask] of [...chat.pending]) {
    if (ask.owner) continue;
    chat.session.answer(r, { allow: true, input: ask.full, permissions: null });
    chat.pending.delete(r);
    chat.push({ kind: 'ask-closed', request: r, outcome: 'allowed' });
  }
  chat.changed();
}

/** Every open ask is closed (the turn ended, the process stopped). */
export function cancelAsks(chat) {
  for (const r of chat.pending.keys()) chat.push({ kind: 'ask-closed', request: r, outcome: 'cancelled' });
  chat.pending.clear();
}
