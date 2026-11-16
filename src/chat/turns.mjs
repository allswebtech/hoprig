// What each turn of a conversation cost and took, kept beside the chats (<stateDir>/chat-turns/<conversation>.jsonl):
// the coding tool's transcript has no line for a turn's end, so without this a page opened again (a reload, a
// dashboard restart, a conversation a terminal went on with) lost every turn's cost, tokens and time, and its Stop.
// One line per turn the owner started: { messageId (his message), end (the turn-end event) }.
import fs from 'node:fs';
import path from 'node:path';

const READ_MAX = 2000; // the newest turns of one conversation that are read back
const ID = /^[0-9A-Za-z-]{1,100}$/;

const fileOf = (dir, id) => (dir && ID.test(String(id || '')) ? path.join(dir, `${id}.jsonl`) : null);

/** Keep the end of the turn that started with the owner's message `messageId`. Never throws (a turn is not lost for it). */
export function rememberTurn(dir, id, messageId, end) {
  const file = fileOf(dir, id);
  if (!file || !messageId) return;
  const { kind, i, at, agent, ...rest } = end;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ messageId, at: at || Date.now(), end: rest })}\n`, { mode: 0o600 });
  } catch {
    /* a full disk: the turn is shown now, only not after a reload */
  }
}

/** The kept ends of conversation `id`: Map(messageId → turn-end event). */
export function readTurns(dir, id) {
  const out = new Map();
  const file = fileOf(dir, id);
  if (!file) return out;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const l of text.split('\n').slice(-READ_MAX)) {
    try {
      const x = JSON.parse(l);
      if (x && typeof x.messageId === 'string' && x.end && typeof x.end === 'object') out.set(x.messageId, { kind: 'turn-end', ...x.end, at: x.at, agent: null });
    } catch {
      /* the last line may be half written */
    }
  }
  return out;
}

/** The events of a transcript with each kept turn end put back where its turn ended (before the next message). */
export function withTurns(events, ends) {
  if (!ends.size) return events;
  const out = [];
  let open = null; // the end of the turn being read
  const close = () => {
    if (!open) return;
    // A stop reads back as "Stopped." from the transcript; the kept end says it (and what the turn cost) instead.
    if (open.stopped && out.length && out.at(-1).kind === 'notice' && out.at(-1).text === 'Stopped.') out.pop();
    out.push(open);
  };
  for (const e of events) {
    if (e.kind === 'user' && !e.agent) {
      close();
      open = e.messageId ? ends.get(e.messageId) || null : null;
    }
    out.push(e);
  }
  close();
  return out;
}
