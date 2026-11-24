// The earlier conversations of a chat's folder, for the chat's history list: each with its name as Claude Code
// shows it (the name given in Hoprig, else the one given in Claude Code, its generated title, its summary, the first
// thing the owner typed: titles.mjs) and when it last changed.
import { sessionsIn } from '../sessions.mjs';
import { readTitles, sessionName } from '../titles.mjs';

const LIST_MAX = 50;

/** The folder's conversations, newest first: [{ id, at, title }]. Only the ones it lists are read, in pieces. */
export async function folderHistory(cwd) {
  const list = sessionsIn(cwd).slice(0, LIST_MAX);
  await readTitles(list.map((s) => s.file));
  return list.map((s) => ({ id: s.id, at: s.mtimeMs, title: sessionName(s.file, s.id) }));
}
