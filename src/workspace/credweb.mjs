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
import { cleanLabel } from './computer.mjs';
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

// ---- the encrypted move between the owner's computers (credmove.mjs) ----
// GET  /api/workspace/credmove           this computer's label and keys, the other computers and their key state, the
//                                        projects that name credentials
// POST /api/workspace/credmove/expect    on the receiver: a one-time nonce and its public keys
// POST /api/workspace/credmove/pack      on the sender: { to, nonce, project | all, typed?, machine? } → sealed bytes
// POST /api/workspace/credmove/upload    on the receiver: the sealed bytes as the raw body (the path ends in /upload: the
//                                        main computer streams such a body as it is); ?dryRun=1 | ?seen=<id>&replace=1
// POST /api/workspace/credmove/trust     { label }: pin the key the brain shows
// POST /api/workspace/credmove/own       { own }: this computer says it is the owner's own, or not
// POST /api/workspace/credmove/mark      { machine, own }: this main computer's own mark of a computer it controls
// Every leg is the owner's own page only (his page here, or a main computer's page relayed with its mark): never Tia,
// a script's token, a session, a linked computer without the page's mark, another site.
const MOVE = '/api/workspace/credmove';

/** The body of the raw upload, at most `max` bytes. */
function rawBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > max) return reject(fail(413, 'too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(fail(413, 'too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The routes. `mine(req, what)`: ownerPageOnly bound to the server → 'page' | 'hub'. `places()`: { dir, projects }.
 * `locked(fn)`: runs `fn` holding the brain's lock. `run`: the command runner (a stand-in in tests). `now()`: the clock.
 */
export function credMoveRoutes({ readJson, mine, places, locked = (fn) => fn(), run = capture, now = () => Date.now(), keys, bool }) {
  const lazy = () => Promise.all([import('./credmove.mjs'), import('./transferkeys.mjs'), import('./computer.mjs')]);
  /** This computer's public keys made (once) and its file in the brain written, when it can be. */
  const publish = async (T, C) => {
    const k = T.ensureKeys();
    try {
      await locked(() => C.writeOwnFile(places()));
    } catch {
      /* the brain is busy or not here: the upkeep writes it */
    }
    return k;
  };
  const labelOf = (v, what = 'say the other computer by its label') => {
    const l = cleanLabel(v);
    if (!l) throw fail(400, what);
    return l;
  };
  return [
    ['GET', new RegExp(`^${MOVE}$`), async (req) => {
      await mine(req, 'seeing what a move of credentials could do');
      const [, T, C] = await lazy();
      const me = C.thisComputer();
      const { dir, projects } = places();
      const peers = C.computersHere(dir).files.filter((f) => f.label !== me.label).map((f) => ({ label: f.label, key: T.peerState({ label: f.label, dir }), own: f.own !== false }));
      const names = [];
      try {
        const { projectsHere } = await import('./where.mjs');
        const { readManifest } = await import('../pcsetup/workspace.mjs');
        for (const f of await projectsHere({ dir, projects })) {
          const m = await readManifest(f.dir, run);
          if (m.manifest && m.manifest.credentials && Object.keys(m.manifest.credentials).length) names.push(f.ref || f.name);
        }
      } catch {
        /* no projects to name */
      }
      return { label: me.label, keys: Boolean(T.publicKeys()), notMine: me.notMine, peers, projects: names.sort() };
    }],
    ['POST', new RegExp(`^${MOVE}/expect$`), async (req) => {
      const by = await mine(req, 'receiving credentials from another computer');
      const b = await readJson(req);
      keys(b, ['from']);
      const [M, T, C] = await lazy();
      const me = C.thisComputer();
      if (!me.label || !me.id) throw fail(409, 'this computer has no label in the workspace yet: give it one first (hoprig workspace label)');
      const from = b.from === undefined ? null : labelOf(b.from);
      const k = await publish(T, C);
      const n = M.issueNonce({ from, now: now() });
      M.logLeg({ leg: 'expect', by, ...(from ? { from } : {}) });
      return { ...n, label: me.label, id: me.id, keys: k };
    }],
    ['POST', new RegExp(`^${MOVE}/pack$`), async (req) => {
      const by = await mine(req, 'sending credentials to another computer');
      const b = await readJson(req);
      keys(b, ['to', 'nonce', 'project', 'all', 'typed', 'machine']);
      const [M, T, C] = await lazy();
      let machineOwn = null;
      if (b.machine !== undefined) {
        if (typeof b.machine !== 'string' || b.machine.length > 40) throw fail(400, 'machine is the name of a computer in your list');
        const { getMachine } = await import('../machines/store.mjs');
        const m = getMachine(b.machine);
        machineOwn = m ? m.own !== false : null;
      }
      const scope = bool(b.all, 'all') ? { all: true } : { project: b.project };
      if (!scope.all && typeof b.project !== 'string') throw fail(400, 'say what to send: all, or one project');
      if (b.typed !== undefined && (typeof b.typed !== 'string' || b.typed.length > 100)) throw fail(400, 'typed is the computer\'s name as you typed it');
      const { dir, projects } = places();
      await publish(T, C);
      const r = await M.packFor({ dir, projects, to: b.to, nonce: b.nonce, scope, typed: b.typed, machineOwn, by, now: now(), run });
      // `from`: this computer's own public keys, so the page can show them to the receiver's Trust when the brain there has not got them yet.
      const me = C.thisComputer();
      return { ok: true, sealed: r.sealed.toString('base64'), files: r.files, bytes: r.bytes, skipped: r.skipped, from: { label: me.label, id: me.id, keys: T.publicKeys() } };
    }],
    ['POST', new RegExp(`^${MOVE}/upload$`), async (req, m, q) => {
      const by = await mine(req, 'receiving credentials from another computer');
      const [M] = await lazy();
      const dry = q.get('dryRun') === '1';
      const replace = q.get('replace') === '1';
      const seen = q.get('seen') || undefined;
      if (seen !== undefined && !/^[0-9a-f]{16}$/.test(seen)) throw fail(400, 'seen is the list you looked at');
      const body = await rawBody(req, M.MAX_SEALED);
      const { dir, projects } = places();
      const r = await M.receiveSealed({ dir, projects, sealed: body, dryRun: dry, replace, seen, by, now: now(), run });
      return r;
    }],
    ['POST', new RegExp(`^${MOVE}/trust$`), async (req) => {
      const by = await mine(req, 'trusting another computer\'s key');
      const b = await readJson(req);
      keys(b, ['label']);
      const [M, T] = await lazy();
      const label = labelOf(b.label);
      const r = T.trustPeer({ label, dir: places().dir });
      M.logLeg({ leg: 'trust', by, peer: label });
      (await import('../machines/tokenaudit.mjs')).recordHubActivity(`You trusted the key of ${label} for moving credentials`);
      return { ok: true, ...r };
    }],
    ['POST', new RegExp(`^${MOVE}/own$`), async (req) => {
      const by = await mine(req, 'saying whether this computer is yours');
      const b = await readJson(req);
      keys(b, ['own']);
      if (typeof b.own !== 'boolean') throw fail(400, 'own is true or false');
      const [M, T, C] = await lazy();
      const me = C.thisComputer();
      if (!me.label) throw fail(409, 'this computer has no label in the workspace yet');
      const { loadConfig, saveConfig } = await import('../config.mjs');
      const c = loadConfig().computer || {};
      const { notMine, ...rest } = c;
      saveConfig({ computer: b.own ? rest : { ...rest, notMine: true } });
      await publish(T, C);
      M.logLeg({ leg: 'own', by, own: b.own });
      return { ok: true, notMine: !b.own };
    }],
    ['POST', new RegExp(`^${MOVE}/mark$`), async (req) => {
      const by = await mine(req, 'saying whether a computer in your list is yours');
      const b = await readJson(req);
      keys(b, ['machine', 'own']);
      if (typeof b.machine !== 'string' || typeof b.own !== 'boolean') throw fail(400, 'say the computer and own: true or false');
      const { setOwn } = await import('../machines/store.mjs');
      if (!setOwn(b.machine, b.own)) throw fail(404, 'no such computer');
      (await lazy())[0].logLeg({ leg: 'mark', by, own: b.own });
      return { ok: true, own: b.own };
    }],
  ];
}
