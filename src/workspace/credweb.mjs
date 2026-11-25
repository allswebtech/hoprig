// The credentials folder as a private repository from the Workspace page: GET and POST /api/workspace/credentials.
// The command's own functions (credrepo.mjs), never a second copy of them: the state is credentialsState, the dry run
// is planCredentialsRepo in the page's words, the typed name is compared by typedMatches (as typedYes does in the
// terminal), and the real call is applyCredentialsRepo as the page's background job, which asks the visibility once
// more right before the push. A change is two calls: the dry run answers a `seen` id of its plan, and the real call is
// refused when the plan made now is another one. What leaves is counts and addresses, never a file name, a value or a
// diff of the folder.
import crypto from 'node:crypto';
import { jobUi, tildeText } from '../pcsetup/feature.mjs';
import { capture } from '../setup/system.mjs';
import { credsDir } from './credlinks.mjs';
import { COST, NOT_GITHUB, applyCredentialsRepo, credentialsState, planCredentialsRepo, typedMatches } from './credrepo.mjs';
import { readMap } from './map.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Said before the yes: a push to a git server is not taken back by Hoprig. */
export const NO_UNDO = 'There is no undo: Hoprig does not take a push to a git server back. The folder on this computer stays as it is.';
export const STALE = 'This changed since you looked: look again.';

/** The state for the page: credentialsState with short paths, and the map's version (the step needs version 2). */
export function credentialsView({ dir, tilde = tildeText } = {}) {
  const s = credentialsState({ dir });
  const m = readMap(dir);
  return {
    ...s,
    ...(s.remote ? { remote: tilde(s.remote) } : {}),
    ...(s.map ? { map: tilde(s.map) } : {}),
    short: tilde(credsDir(dir)),
    mapVersion: m.exists && m.map ? m.map.version : null,
  };
}

/** A short id of exactly what the plan would do (the address, the repository and every step). */
const seenOf = (p) => crypto.createHash('sha256').update(JSON.stringify([p.url, p.github, p.create, p.name, p.steps, p.changes, p.head, p.repoHere, p.have, p.recordOnly])).digest('hex').slice(0, 16);

/**
 * POST /api/workspace/credentials. `b`: { github?: true | "<name>", repo?: "<address>", dryRun?, typed?, seen?,
 * confirmNotGithub? }. `mine(what)`: throws unless the owner's own page (whomay.mjs); `startJob(kind, fn)`: the
 * page's one background job; `keys`, `bool`: the feature's own checks of a body.
 */
export async function pageCredentials(b, { dir, run = capture, startJob, mine, keys, bool, tilde = tildeText }) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'send what to do: github or repo');
  keys(b, ['github', 'repo', 'dryRun', 'typed', 'seen', 'confirmNotGithub']);
  const dry = bool(b.dryRun, 'dryRun');
  const confirmed = bool(b.confirmNotGithub, 'confirmNotGithub');
  if ((b.github === undefined) === (b.repo === undefined)) throw fail(400, 'say one: github (a new private repository on GitHub) or repo (the address of one you made)');
  if (b.github !== undefined && b.github !== true && typeof b.github !== 'string') throw fail(400, 'github is true or the name of the new repository');
  if (b.repo !== undefined && (typeof b.repo !== 'string' || !b.repo.trim() || b.repo.length > 500)) throw fail(400, 'repo is the address of the repository');
  if (b.typed !== undefined && (typeof b.typed !== 'string' || b.typed.length > 200)) throw fail(400, 'typed is the repository\'s name as you typed it');
  if (!dry) {
    // His yes, before anything is asked of git or GitHub: never Tia, a script's or a session's token, another site.
    await mine('making the credentials folder a repository (it pushes every key in it)');
    if (typeof b.seen !== 'string' || !/^[0-9a-f]{16}$/.test(b.seen)) throw fail(400, 'seen is the plan the sheet showed: look again');
  }
  let plan;
  try {
    plan = await planCredentialsRepo({ dir, repo: b.repo === undefined ? null : b.repo.trim(), github: b.github === undefined ? null : b.github === true ? '' : b.github, run });
  } catch (e) {
    throw fail(e.status || 500, tilde(e.message));
  }
  const seen = seenOf(plan);
  if (dry) {
    return {
      ok: true, dryRun: true, seen, cost: COST, url: tilde(plan.url), github: plan.github, create: plan.create, name: plan.name,
      steps: plan.steps.map((s) => tilde(s)), recordOnly: plan.recordOnly, undo: NO_UNDO,
      visibility: plan.github ? (plan.create ? 'GitHub creates it private.' : 'GitHub says it is private. It is asked again right before the push.') : NOT_GITHUB,
    };
  }
  if (b.seen !== seen) throw fail(409, STALE);
  if (!typedMatches(b.typed, plan.name)) throw fail(400, 'nothing was done: what was typed is not the repository\'s name');
  if (!plan.github && !confirmed) throw fail(400, `nothing was done: ${NOT_GITHUB}`);
  return startJob('credentials', async (onLine) => {
    const { ui } = jobUi(onLine);
    const r = await applyCredentialsRepo(plan, { dir, run, ui });
    if (!r.ok) ui.line('fail', r.why);
    else ui.line('ok', `the map names ${plan.url} as the credentials repository now: restore clones it right after the brain`);
    return r;
  });
}
