// "Before you format this computer" in the dashboard, as a server feature: { name: 'leave', routes }.
//
//   GET  /api/workspace/leave           starts the whole check (leave.mjs, read only) in the background, or answers
//                                       the one that runs: { run, running }; ?run=<id> polls → { run, running, report? }
//   POST /api/workspace/onlyhere/push   the one press: committed work on every branch that is not the default branch,
//                                       in every place (branchpush.mjs and its own gates) → { repos: [{ label, pushed,
//                                       todo }] }
//   POST /api/workspace/leave/mark { kind, what } | { unmark }   keep / ignore a home dot-folder, leave a folder
//                                       outside, an engine that holds test data only (leavemarks.mjs)
//
// Both presses are the owner's own page only (whomay.mjs). No answer holds a path outside "~", a token, a key's
// content or the name of a file inside the credentials folder: every answer is built from named fields only (what
// the page shows), and each string is shortened and masked on its way out.
import crypto from 'node:crypto';
import os from 'node:os';
import { tildeText } from '../pcsetup/feature.mjs';
import { redact } from '../assistant/secrets.mjs';
import { tokenIdOf } from '../machines/index.mjs';
import { placeKey } from './branchpush.mjs';
import { placesOf } from './groups.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';
import { readMap } from './map.mjs';
import { ownerPageOnly } from './whomay.mjs';

/** A finished look is kept this long for the page to read; then it is gone and the page looks again. */
export const KEEP_MS = 15 * 60_000;
export const MARK_KINDS = Object.freeze(['keep', 'ignore', 'outside', 'testData']);
export const WHAT_MAX = 300;
export const LAST_NOTHING = 'Nothing is only here: this computer can be formatted.';
export const BUSY = 'Your other branches are being pushed right now. Wait until that ends, then press again if you need to.';

const RUN_RE = /^[0-9a-f]{24}$/;
const CONTROL = /[\0-\x1f\x7f]/;
// A name after the credentials folder ("credentials/server.env"): the folder is named, a file in it never is.
const CRED_FILE = /(credentials[\\/])[^\s"'`),;]+/g;
// A full path that is not under the home (the home was made "~" before): only its last name is kept.
const FULL_PATH = /(?<![\w.~:/\\-])\/(?:[^\s/"'`]+\/)+([^\s/"'`]+)/g;

/** The last line of the report, as the command prints it (SHAPE.md): the count is what is not proven safe. */
export function lastLine(r) {
  const n = r.items.length + r.asks.length + r.notChecked.length;
  if (r.nothingOnlyHere && !n) return LAST_NOTHING;
  return n === 1 ? '1 thing exists only on this computer (above).' : `${n} things exist only on this computer (above).`;
}

export function leaveFeature(sctx, opts = {}) {
  const now = opts.now || Date.now;
  const fail = (status, message) => (sctx.HttpError ? new sctx.HttpError(status, message) : Object.assign(new Error(message), { status }));
  const home = () => opts.home || os.homedir();
  const cfg = () => {
    const c = { ...(sctx.config ? sctx.config() : {}) };
    if (opts.dir) c.workspaceDir = opts.dir;
    return c;
  };
  const where = () => {
    const c = cfg();
    return { dir: workspaceDir(c), projects: opts.projectsDir ? opts.projectsDir() : projectsIn(c), home: home() };
  };
  // The modules of the check are loaded only when used: a dashboard that never opens the page loads none.
  const leaveCheck = async () => opts.leaveCheck || (await import('./leave.mjs')).leaveCheck;
  const marks = async () => opts.marks || (await import('./leavemarks.mjs'));
  const pushBranches = async () => opts.pushBranches || (await import('./branchpush.mjs')).pushBranches;

  // ---- what leaves: named fields only, each string shortened and masked ----
  const safe = (s) => (s === null || s === undefined ? s : redact(tildeText(String(s), home())).replace(CRED_FILE, '$1(a file)').replace(FULL_PATH, '…/$1'));
  const str = (s) => (typeof s === 'string' ? safe(s) : '');
  const size = (n) => (Number.isFinite(n) && n >= 0 ? n : null);
  const list = (v) => (Array.isArray(v) ? v : []);
  const cleanReport = (r) => {
    if (!r || typeof r !== 'object') return null;
    const out = {
      at: str(r.at), cheap: r.cheap === true,
      items: list(r.items).map((i) => ({ id: str(i.id), kind: str(i.kind), where: str(i.where), what: str(i.what), size: size(i.size), todo: str(i.todo), command: str(i.command), pushable: i.pushable === true })),
      asks: list(r.asks).map((a) => ({ id: str(a.id), kind: str(a.kind), where: str(a.where), size: size(a.size), question: str(a.question) })),
      outside: list(r.outside).map((o) => ({ where: str(o.where), why: str(o.why) })),
      notChecked: list(r.notChecked).map((o) => ({ where: str(o.where), why: str(o.why) })),
      nothingOnlyHere: r.nothingOnlyHere === true,
    };
    out.last = lastLine(out);
    return out;
  };
  const mine = (req, what) => ownerPageOnly(req, sctx, what, { tokenId: tokenIdOf, card: false });

  // ---- the whole check: one at a time, in the background; the newest finished one is kept a while ----
  let look = null; // { id, running, report?, error?, done? }
  const expired = (l) => !l.running && now() - l.done > KEEP_MS;
  function startLook() {
    if (look && look.running) return look;
    const me = { id: crypto.randomBytes(12).toString('hex'), running: true };
    look = me;
    (async () => (await leaveCheck())({ ...where(), cheap: false }))()
      // The raw report is cleaned at once: nothing of it but what the page shows stays in memory.
      .then((r) => { me.report = cleanReport(r); }, (e) => { me.error = safe((e && e.message) || 'the look failed'); })
      .finally(() => { me.running = false; me.done = now(); });
    return me;
  }
  const lookView = (l) => ({ run: l.id, running: l.running, ...(l.report ? { report: l.report } : {}), ...(l.error ? { error: l.error } : {}) });

  let pushing = false;
  const routes = [
    ['GET', /^\/api\/workspace\/leave$/, async (req, m, q) => {
      await mine(req, 'the look before a format');
      const run = q && q.get('run');
      if (!run) return lookView(startLook());
      if (!RUN_RE.test(run)) throw fail(400, 'that is not a look of this page');
      if (look && expired(look)) look = null;
      if (!look || look.id !== run) throw fail(404, 'That look is over. Press Look now to look again.');
      return lookView(look);
    }],
    ['POST', /^\/api\/workspace\/onlyhere\/push$/, async (req) => {
      await mine(req, 'a push of your other branches');
      if (pushing) throw fail(409, BUSY);
      pushing = true;
      let r;
      try {
        const at = where();
        const m = readMap(at.dir);
        // Every place of the map, the projects folder first. A default branch is never pushed by this: branchpush.mjs
        // leaves it, and every branch whose upstream is it, to the owner.
        const on = [...new Set(placesOf(m.exists && !m.errors ? m.map : null, at).map((p) => placeKey(p.id)))];
        r = await (await pushBranches())({ dir: at.dir, projects: at.projects, on });
      } finally {
        pushing = false;
      }
      return { repos: list(r && r.repos).map((x) => ({ label: str(x.label), pushed: list(x.pushed).map(str), todo: list(x.todo).map((t) => ({ why: str(t && t.why), command: str(t && t.command) })) })) };
    }],
    ['POST', /^\/api\/workspace\/leave\/mark$/, async (req) => {
      await mine(req, 'a mark of what the look leaves out');
      const b = await sctx.readJson(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'send a kind and what it is for, or one name to check again');
      const keys = Object.keys(b).sort().join(',');
      if (keys !== 'kind,what' && keys !== 'unmark') throw fail(400, 'send either a kind and what it is for, or one name to check again');
      const what = keys === 'unmark' ? b.unmark : b.what;
      if (typeof what !== 'string' || !what.trim()) throw fail(400, 'name the folder or the engine');
      if (what.length > WHAT_MAX) throw fail(400, `a name of at most ${WHAT_MAX} characters`);
      if (CONTROL.test(what)) throw fail(400, 'a name without line breaks or other control characters');
      if (keys === 'kind,what' && !MARK_KINDS.includes(b.kind)) throw fail(400, `the kind is one of: ${MARK_KINDS.join(', ')}`);
      const M = await marks();
      const at = where();
      const r = keys === 'unmark' ? await M.unmark({ dir: at.dir, home: at.home, what }) : await M.setMark({ dir: at.dir, home: at.home, kind: b.kind, what });
      if (!r || !r.ok) throw fail(400, str((r && r.why) || 'that cannot be marked'));
      const k = r.marks || {};
      return { ok: true, marks: { keep: list(k.keep).map(str), ignore: list(k.ignore).map(str), outside: list(k.outside).map(str), testData: list(k.testData).map(str), label: k.label ? str(k.label) : null } };
    }],
  ];
  return { name: 'leave', routes };
}
