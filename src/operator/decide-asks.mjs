// The one place where a decision meets a question of a session (the kind "asks"): the question's own card, whether
// Hands-off is on for that session, and the answer.
//
// Only a chat's question (the App) can be answered here: its exact card is the chat's own (askcard.mjs cardOf, made by
// chat/asks.mjs when it was shown), its Hands-off switch is chat/handsoff.mjs chatSwitch, and the answer goes through
// answerAsk, the very function the owner's own press uses, with the card's key checked again. A terminal session's
// question is answered in its terminal (Hands-off answers it inside the hook, before it is drawn): no way of the
// product answers it afterwards, so it is never offered to a decision and stays his.
//
// The tool's own recommended mark (`marked`) is passed on only so that decide-table.mjs answerable() refuses such a
// question: a marked option is Hands-off's, never a model's. Hands-off not offered on this computer means the switch
// reads off, so every question is his.
import { ownersAlone } from '../handsoff.mjs';

const fail = (message) => Object.assign(new Error(message), { status: 409 });
const CHAT = /^chat:(.{1,80})$/;

/** `chat`: the chat feature (its `question(id)` and `answerQuestion(id, request, a)`), or null: then nothing is offered. */
export function asksAdapter({ chat = null } = {}) {
  const find = (name) => {
    const m = typeof name === 'string' ? CHAT.exec(name) : null;
    if (!m || !chat || typeof chat.question !== 'function') return null;
    const q = chat.question(m[1]);
    return q && q.card ? { id: m[1], q } : null;
  };
  const card = (name) => {
    const f = find(name);
    if (!f) return null;
    const c = f.q.card;
    const qs = c.kind === 'question' && Array.isArray(c.questions) ? c.questions : [];
    const q = qs[0] || {};
    const sw = f.q.handsOff || {};
    return {
      handsOff: sw.on === true,
      kind: c.kind,
      count: f.q.only === true ? qs.length : 0, // another ask waits beside it: his
      masked: c.masked === true,
      cut: c.cut === true,
      multi: q.multiSelect === true,
      marked: Number.isInteger(q.recommended) ? q.recommended : null,
      question: typeof q.question === 'string' ? q.question : '',
      header: typeof q.header === 'string' ? q.header : '',
      options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: o.label, description: o.description || '' })),
      freeText: q.freeText === true,
      note: typeof sw.note === 'string' ? sw.note : '',
    };
  };
  const answer = async (name, a) => {
    const f = find(name);
    const c = f ? card(name) : null;
    if (!c || !c.handsOff || c.kind !== 'question' || c.count !== 1) throw fail('that question is not one Tia may answer now: answer it in the session');
    const q = f.q.card.questions[0];
    let text = null;
    if (a && a.note === true) text = c.freeText && c.note.trim() ? c.note.trim().slice(0, 2000) : null;
    else if (a && Number.isInteger(a.option) && q.options[a.option - 1]) text = q.options[a.option - 1].label;
    if (text == null) throw fail('that answer is not one of the question\'s own');
    chat.answerQuestion(f.id, f.q.request, { allow: true, answers: { [q.question]: text }, key: f.q.card.key, by: 'decide' });
  };
  return { card, alone: (texts) => ownersAlone(texts), answer };
}
