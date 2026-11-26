// Every move of a session to another provider, by whoever made it (a tap on the page, Auto mode's watcher, a rule of
// Tia's), for the last day: <state>/moves.json, [{ session, from, to, at }]. The Operator's limit rule reads it so that
// it never moves a session back to a provider it left within the hour, whoever moved it then. Written atomically;
// a broken or missing file is an empty log.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';
import { replaceFile } from './replacefile.mjs';

const DAY = 24 * 3600_000;
const MAX = 200;
const file = () => path.join(stateDir(), 'moves.json');

/** The moves of the last day (a time later than `now` counts as now). */
export function recentMoves(now = Date.now()) {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return (Array.isArray(d) ? d : [])
      .filter((m) => m && typeof m.session === 'string' && typeof m.to === 'string' && Number.isFinite(m.at))
      .map((m) => ({ session: m.session, from: typeof m.from === 'string' ? m.from : null, to: m.to, at: Math.min(m.at, now) }))
      .filter((m) => now - m.at < DAY);
  } catch {
    return [];
  }
}

/** Note one move; never in the way of the move itself. */
export function noteMove({ session, from, to, at = Date.now() }) {
  try {
    const list = [...recentMoves(at), { session: String(session), from: from == null ? null : String(from), to: String(to), at }].slice(-MAX);
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    replaceFile(tmp, file());
  } catch {
    /* a move that is not noted is still a move */
  }
}
