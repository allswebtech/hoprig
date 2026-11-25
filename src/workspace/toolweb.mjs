// A group's own command on the Workspace page (docs/WORKSPACE.md, "A group's own command"): the routes' work, with
// the very functions `hoprig workspace tool` calls (grouptool.mjs). Nothing here decides anything of its own:
//   view(places)              toolsState for the page, short paths only (the home as ~)
//   allow(group, places, { dryRun, seen })
//                             dryRun: allowTool's dry run (everything checked, nothing written) and a `seen` id of what
//                             the sheet shows: the group, the name, the run, the address, the file and the file's
//                             content. The real call (the caller checks it is the owner's own page) makes that id
//                             again from a new dry run and is refused when it differs; then allowTool with that plan.
//   remove(group, { dryRun }) removeTool: only a launcher Hoprig made for this group, and the yes
// A refusal keeps allowTool's status and words, with the home as ~.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tildeText } from '../pcsetup/feature.mjs';
import { allowTool, removeTool, toolsState } from './grouptool.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const CHANGED = 'This changed since you looked: look again.';

/** A refusal of grouptool with the home as ~ (its words name full paths for the terminal). */
const short = (e) => Object.assign(new Error(tildeText(e.message)), { status: e.status || 500 });
const tryShort = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    throw short(e);
  }
};

/** The id of what a dry run shows: bound to the name, the run, the address, the file and what the file holds now. */
export function seenOf(plan) {
  let body;
  try {
    body = sha(fs.readFileSync(plan.file));
  } catch {
    body = 'unreadable';
  }
  return sha(JSON.stringify([plan.group, plan.name, plan.run, plan.url, plan.file, body]));
}

/** Every group tool of the map on this computer, as the page shows it. */
export async function view({ dir, projects }) {
  const tools = await toolsState({ dir, projects });
  return {
    tools: tools.map((t) => ({
      group: t.group, name: t.name, run: t.run, file: tildeText(t.file), launcher: tildeText(t.launcher), state: t.state,
      ...(t.changed ? { changed: true } : {}), ...(t.why ? { why: tildeText(t.why) } : {}), ...(t.fix ? { fix: t.fix } : {}),
      missing: t.missing.map((m) => ({ program: m.program, ...(m.kit ? { kit: m.kit } : {}) })),
    })),
  };
}

const planView = (p) => ({
  group: p.group, name: p.name, run: p.run, url: p.url, file: tildeText(p.file), launcher: tildeText(p.launcher),
  onPath: p.onPath, ...(p.removed ? { removed: tildeText(p.removed) } : {}),
});

/** The sheet's question (dryRun) or the owner's yes (with the sheet's `seen`). */
export async function allow(group, { dir, projects }, { dryRun = false, seen = null } = {}) {
  const plan = await tryShort(() => allowTool(group, { dir, projects, dryRun: true }));
  const now = seenOf(plan);
  if (dryRun) return { ...planView(plan), dryRun: true, seen: now };
  if (seen !== now) throw fail(409, CHANGED);
  const r = await tryShort(() => allowTool(group, { dir, projects, plan }));
  return { ...planView(r), made: true };
}

/** Take the command away again (only a launcher Hoprig made for this group) and forget the yes. */
export function remove(group, { dryRun = false } = {}) {
  const r = removeTool(group, { dryRun });
  return { group: r.group, ...(r.name ? { name: r.name } : {}), removed: r.removed.map((f) => tildeText(f)), dryRun: r.dryRun, ...(r.note ? { note: r.note } : {}) };
}
