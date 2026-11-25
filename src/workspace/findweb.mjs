// "Look on the git server" on the Workspace page (feature.mjs routes /api/workspace/find/*): the same functions as the
// command, never a second copy of their checks.
//   add   `hoprig workspace find --in <place> --add`: findcmd.mjs addFound (a dry run first, its `seen` on the yes)
//   undo  "Take them out again": map.mjs forget, for exactly the entries the add wrote and only while each is unchanged
//   get   `hoprig get <owner/name> --in <place>`: getbyrule.mjs ruleTarget + getByRule (the clone), as a background job
// The place is checked by placeRule (findcmd.mjs) and a repository name by the pattern GitHub names have; nothing
// typed becomes a path without that.
import { jobUi, tildeText } from '../pcsetup/feature.mjs';
import { capture, stream } from '../setup/system.mjs';
import { CHANGED, findInPlace, placeRule, planId } from './findcmd.mjs';
import { forget, readMap, refOf, writeMap } from './map.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SEEN = /^[0-9a-f]{64}$/;

/** The place as typed, checked the way the command checks `--in`. → the place's id */
export function placeOf(v, ctx) {
  if (typeof v !== 'string' || !v || v.length > 200) throw fail(400, 'say the place: a group or a held folder of the map');
  return placeRule(v, ctx).place;
}

/** A repository the page names: owner/name, as GitHub writes it. */
export function repoOf(v) {
  if (typeof v !== 'string' || !REPO.test(v)) throw fail(400, 'name the repository as owner/name');
  return v;
}

/** The `seen` of a real call: the id the dry run gave. */
export function seenOf(v) {
  if (typeof v !== 'string' || !SEEN.test(v)) throw fail(400, 'seen is what the look showed: look again');
  return v;
}

/** The one project of the look-up that `repo` is the parent of: what a get of it does, and that plan's id. */
async function pickFound(place, repo, ctx, gh) {
  const f = await findInPlace(place, { ...ctx, gh });
  const p = f.found.find((x) => x.parent.toLowerCase() === repo.toLowerCase());
  if (!p) throw fail(404, `${repo} is not a project of ${f.place} that the map does not have yet: look again`);
  const plan = { place: f.place, folder: p.folder, parent: p.parent, url: p.url, code: p.code.map((c) => c.name), skipped: p.skipped.map((c) => c.name) };
  return { ...plan, seen: planId(plan) };
}

/** `hoprig get <repo> --in <place>`'s own path: the rule's target, then getByRule with its getProject. */
async function runGet(place, repo, { ui, ctx, gh, runner = stream }) {
  const byRule = await import('../pcsetup/getbyrule.mjs');
  const { getProject } = await import('../pcsetup/getproject.mjs');
  const cur = readMap(ctx.dir);
  if (cur.errors || !cur.exists) throw fail(409, 'the workspace map cannot be read');
  const t = byRule.ruleTarget(repo, place, cur.map);
  if (!t) throw fail(409, `${repo} is in the map already: get it from the project's own row`);
  // Never a password prompt on the server's own terminal: a private repository needs the GitHub sign-in first.
  const quiet = (argv, o = {}) => runner(argv, { ...o, env: { ...(o.env || process.env), GIT_TERMINAL_PROMPT: '0' } });
  return byRule.getByRule(repo, t, { ui, dir: ctx.projects, gh, runner: quiet, map: cur.map, ask: false, getProject });
}

/** The dry run of a get: where it lands and what is cloned (getByRule's own dry run and its lines), and its `seen`. */
export async function getPlan(place, repo, { ctx, gh = capture }) {
  const p = await pickFound(place, repo, ctx, gh);
  const lines = [];
  const { ui } = jobUi((l) => lines.push(tildeText(l)));
  ui.dryRun = true;
  const r = await runGet(place, repo, { ui, ctx, gh });
  if (!r.ok) throw fail(409, tildeText(r.message || 'it cannot be fetched'));
  return { ...p, into: r.dir ? tildeText(r.dir) : null, lines, dryRun: true };
}

/** Before the real get starts: the plan made now is the one he saw, else refused (nothing started). */
export async function getChecked(place, repo, seen, { ctx, gh = capture }) {
  const p = await pickFound(place, repo, ctx, gh);
  if (p.seen !== seen) throw fail(409, CHANGED);
  return p;
}

/** The real get, in the job. */
export async function getIt(place, repo, { ctx, gh = capture, ui, runner }) {
  const r = await runGet(place, repo, { ui, ctx, gh, runner });
  // As the command does after a get: this computer's own file in the brain says what is here now (only with a label).
  if (['cloned', 'here'].includes(r.result)) await (await import('./computer.mjs')).writeOwnFile({ dir: ctx.dir, projects: ctx.projects }).catch(() => null);
  return { ok: r.ok !== false, result: r.result, ...(r.folder ? { ref: `${place}/${r.folder}` } : {}), ...(r.message ? { message: tildeText(r.message) } : {}) };
}

/** What the map keeps of an entry, in one order: compared to tell "unchanged since the add". */
const kept = (e) => JSON.stringify({ name: e.name, in: e.in || '', url: e.url || null, repos: (e.repos || []).map((r) => ({ dir: r.dir, url: r.url || null })) });

/**
 * "Take them out again": each entry the add wrote (as its answer gave it) leaves the map by forget, only while the
 * map's entry is still exactly that one; one changed since is left and named. forget also puts the name on the map's
 * skip list; that is taken back for these names (unless it was there before): the entry was not in the map before the
 * add, and a skip would keep a later add of it out of the map.
 */
export function undoAdd(entries, { dir }) {
  const cur = readMap(dir);
  if (cur.errors || !cur.exists) throw fail(409, 'the workspace map cannot be read');
  const before = new Set(cur.map.skip || []);
  const out = { removed: [], kept: [] };
  for (const e of entries) {
    const ref = refOf(e);
    const now = cur.map.projects.find((x) => refOf(x) === ref);
    if (!now) continue; // out of the map already
    if (kept(now) !== kept(e)) {
      out.kept.push({ ref, why: 'it changed since it was added, so it stays in the map' });
      continue;
    }
    forget(ref, dir);
    out.removed.push(ref);
  }
  if (out.removed.length) {
    const { skip, ...m } = readMap(dir).map;
    const left = (skip || []).filter((s) => before.has(s) || !out.removed.includes(s));
    writeMap(left.length ? { ...m, skip: left } : m, dir);
  }
  return out;
}

/** The entries as the page sends them back (the add's answer): { name, in, url, repos: [{ dir, url }] }, each checked. */
export function entriesOf(v) {
  const NAME = /^[A-Za-z0-9._-]{1,100}$/;
  const IN = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100}){0,3}$/;
  const url = (u) => typeof u === 'string' && u.length <= 300 && /^https:\/\/[A-Za-z0-9.-]+\/[^\s"'<>\\]+$/.test(u);
  const ok = Array.isArray(v) && v.length > 0 && v.length <= 500 && v.every((e) => e && typeof e === 'object' && !Array.isArray(e)
    && NAME.test(e.name) && IN.test(e.in) && url(e.url) && Array.isArray(e.repos) && e.repos.length <= 100
    && e.repos.every((r) => r && typeof r === 'object' && /^code\/[A-Za-z0-9._-]{1,100}$/.test(r.dir) && url(r.url)));
  if (!ok) throw fail(400, 'entries are the ones the add named');
  return v;
}
