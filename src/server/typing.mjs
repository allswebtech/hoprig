// What someone other than the owner's own keys types into a terminal session: the queue, the continue prompt after a
// move or a restart, the assistant, another computer through the send and key routes. It is meant for the coding
// tool, so it goes in only while the tool is the terminal's foreground program, and its text never carries a control
// byte. Once the tool has ended, the terminal's shell would read the text and its line ends as commands.
//
// Three checks, each right before the bytes:
//   the run record    read again now (deck.find); a terminal at its own shell has none
//   the typing lock   the record is read once more while holding it, and the launcher removes the record only under
//                     it, then throws away what its terminal's input holds (src/typinglock.mjs): text typed for a
//                     tool that ends the same moment is never left for the shell
//   the front group   the launcher's process group holds the terminal in front, checked by the backend in the step
//                     that writes (./backends/front.mjs). Windows: the built-in terminal's own child is the launcher
import path from 'node:path';
import { runsDir } from '../paths.mjs';
import { alive } from '../procid.mjs';
import { readRun } from '../runs.mjs';
import { noteTyped, whileTyping } from '../typinglock.mjs';
import { FRONT_GONE, groups, notInFront } from './backends/front.mjs';

/** The pause before Enter: the program finishes taking the text in, so Enter is read as "send", not as part of a paste. */
export const ENTER_PAUSE_MS = 250;

/**
 * Text as it is typed for a coding tool: every run of control characters becomes one space, so none of it acts on the
 * tool's screen (Ctrl-C interrupts, Escape starts a sequence, Tab completes). C0 (below 0x20), DEL and C1 (0x80 to
 * 0x9f: a UTF-8 terminal may read U+009B as the start of a sequence). Line breaks stay: several lines go as one paste,
 * as the tool's prompt takes them (the backends' sendText); CR LF and a lone CR are line breaks too.
 */
export const toolText = (text) => String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]+/g, ' ');

const noTool = (name) => `Nothing was typed: no coding tool runs in session "${name}" now (its terminal is at its own shell). Start the coding tool there again, then send it again`;

/**
 * The text went out, its Enter did not: the tool ended or the session changed in the pause between them. 409 with a
 * code of its own ("typed_not_sent"), so nobody takes it for "nothing was typed" and types the text a second time. On
 * Linux and macOS a launcher whose tool ended threw the text away; elsewhere it may stand on a line.
 */
export function typedNotSent(name) {
  const e = new Error(`The text was typed into session "${name}" but not sent: its coding tool ended or changed before the Enter. Look at the session before you send it again`);
  return Object.assign(e, { status: 409, code: 'typed_not_sent', details: { code: 'typed_not_sent' } });
}

/** Session `name`'s terminal, run record, record file and what must be in front; notInFront when there is no tool. */
async function look(deck, name) {
  const found = await deck.find(name);
  if (!found) throw notInFront(`Nothing was typed: there is no session "${name}" any more`);
  if (!found.run) throw notInFront(noTool(name));
  const { term, run } = found;
  const file = path.join(runsDir(), `${path.basename(String(run.runId))}.json`);
  return { term, run, file, front: frontOf(run) };
}

/**
 * What says the coding tool of `run` is in front: POSIX, the launcher's process group, which must be the one in front
 * (its tool runs in it). Windows has no groups: there the launcher itself must still run (a record whose launcher has
 * ended stands for a terminal back at its shell). Throws notInFront(FRONT_GONE) when it is not. The options: tests.
 */
export function frontOf(run, { platform = process.platform, groupsOf = groups, isAlive = alive } = {}) {
  const g = groupsOf(run.pid);
  if (g) return { group: g.pgrp, pid: run.pid };
  if (platform !== 'win32' || !isAlive(run.pid)) throw notInFront(FRONT_GONE);
  return { pid: run.pid };
}

/**
 * `act` under the run's typing lock, with its record read once more inside it. `guard(record, term)`: the caller's own
 * check of that record and the screen, as the last step before the bytes; it throws to type nothing.
 */
async function locked(l, name, act, guard = null) {
  try {
    await whileTyping(l.file, async () => {
      const now = readRun(l.file);
      if (!now || now.pid !== l.run.pid) throw notInFront(noTool(name));
      if (guard) await guard(now, l.term);
      noteTyped(l.file); // the launcher settles its terminal's input at its end
      await act();
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw notInFront(noTool(name)); // no runs folder: no record
    throw e;
  }
}

/**
 * Type `text` for the coding tool of session `name` and press Enter (unless `enter` is false). Throws 409 with code
 * "not_in_front" when nothing was typed, and typedNotSent() when the text went but its Enter did not. `guard`: see
 * locked(); asked once, before the text (after it, the screen holds the typed text in the message box, which can read
 * as a menu: "❯ 1. yes"). `enterGuard(record)`: the caller's check of the record alone, asked again under the lock
 * right before the Enter: in the pause the record may have turned to a question, which the Enter would answer.
 */
export async function sendToTool(deck, name, text, { enter = true, guard = null, enterGuard = null } = {}) {
  const clean = toolText(text);
  const first = await look(deck, name);
  await locked(first, name, () => deck.backend.sendText(first.term.id, clean, { front: first.front }), guard);
  if (!enter) return;
  await new Promise((r) => setTimeout(r, ENTER_PAUSE_MS));
  try {
    const again = await look(deck, name);
    if (again.term.id !== first.term.id || again.run.runId !== first.run.runId) throw notInFront(FRONT_GONE);
    await locked(again, name, () => deck.backend.sendKey(again.term.id, 'Enter', { front: again.front }), enterGuard && ((run) => enterGuard(run)));
  } catch {
    throw typedNotSent(name); // whatever stopped the Enter: the text is out there
  }
}

/**
 * Press `key` for the coding tool of session `name` (the key route for anyone but the owner: Enter, Escape, Tab, the
 * arrows, C-c, or a digit that answers a menu). The same checks as text: a key reaches a shell never (an Enter there
 * would run what stands on its line; Up then Enter its last command). Throws 409 "not_in_front" when nothing was sent.
 */
export async function keyToTool(deck, name, key) {
  const l = await look(deck, name);
  const digit = /^[1-9]$/.test(key);
  await locked(l, name, () => (digit ? deck.backend.sendText(l.term.id, key, { front: l.front }) : deck.backend.sendKey(l.term.id, key, { front: l.front })));
}
