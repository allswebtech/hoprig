// `hoprig adopt retire` from the page "Projects found on this computer": the terminal's retire, step for step.
// Nothing here decides what may be removed: the plan, the refusals, the words, the check right before anything goes
// and the removal are retire.mjs's own; this file only answers its one question with what the owner typed on the
// sheet, and binds that sheet to what retire found when it opened (the same pattern as the page's drop, dropweb.mjs).
//
//   check(name)              retirePlan: what would go, what stays and why, in retire's own lines, and a one-use
//                            ticket bound to what it found (the original's fingerprint, the lists), for ten minutes
//   retire(ticket, typed)    the ticket is used once; `typed` must be exactly the project's name (compared here);
//                            retireProject then reads everything again, removes nothing when it is not what the sheet
//                            showed, when the original changed or when the copy lacks anything
import crypto from 'node:crypto';
import { LEFT_HEAD, leftWords, refusalWords, retireLines, retirePlan, retireProject } from './retire.mjs';

export const TICKET_MS = 10 * 60_000;
export const NO_UNDO = 'There is no undo: nothing can bring these folders back from Hoprig. The copy in your workspace stays as it is.';
export const STALE = 'This changed since you looked: look again.';
const TICKET_RE = /^[0-9a-f]{64}$/;

/** What the sheet showed, as one id: the original's fingerprint as retire reads it, and what goes and what stays. */
export function sheetKey(r) {
  const keep = Object.entries(r.keep || {}).map(([g, list]) => [g, list.map((b) => b.toString('hex'))]);
  return crypto.createHash('sha256').update(JSON.stringify([r.fingerprint, r.go, keep, r.stay, (r.leftOut || []).map((l) => l.dir)])).digest('hex');
}

/** The page's retire. `projects()`: the projects folder; `tilde(text)`: paths as ~ for the page; `now()` for tests. */
export function pageRetire({ projects, tilde: tildeOf = (s) => s, now = () => Date.now() }) {
  const tilde = (s) => tildeOf(String(s));
  const tickets = new Map(); // ticket → { name, key, until }
  const used = new Map(); // ticket → until: a used one is named as used, not as old
  const sweep = () => {
    for (const [k, t] of tickets) if (t.until <= now()) tickets.delete(k);
    for (const [k, until] of used) if (until <= now()) used.delete(k);
  };

  /** retire's own look (read only). A ticket only when retire would go on to ask for the name. */
  async function check(name) {
    const r = await retirePlan(name, { projects: projects() });
    const no = refusalWords(name, r);
    const out = {
      name, refusal: no ? tilde(no) : null, undo: NO_UNDO,
      lines: no ? [] : retireLines(r).map(tilde),
      go: r.go.map((g) => ({ path: tilde(g), keeps: (r.keep[g] || []).length })),
      stay: r.stay.map((s) => ({ path: tilde(s.path), why: s.why })),
      // Not copied, removed with the old folder, made again by their command: said on the sheet before the press.
      leftOut: no ? [] : (r.leftOut || []).map((l) => ({ path: tilde(l.dir), bytes: l.bytes, files: l.files, remake: l.remake, at: tilde(l.at), words: tilde(leftWords(l)) })), leftHead: LEFT_HEAD,
    };
    if (!no && r.go.length) {
      sweep();
      const ticket = crypto.randomBytes(32).toString('hex');
      tickets.set(ticket, { name, key: sheetKey(r), until: now() + TICKET_MS });
      Object.assign(out, { ticket, until: now() + TICKET_MS });
    }
    return out;
  }

  /** The removal, on the owner's typed name. → { ok, result, words?, removed?, lines?, error?, check? } */
  async function retire(ticket, typed) {
    if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return { ok: false, result: 'expired', error: 'open the sheet again: it has no valid ticket' };
    sweep();
    const t = tickets.get(ticket);
    tickets.delete(ticket); // used once, whatever happens next
    if (!t) return { ok: false, result: 'expired', error: used.has(ticket) ? 'this sheet was used already: open it again, it looks again' : 'this sheet is older than ten minutes: open it again, it looks again' };
    used.set(ticket, t.until);
    if (typeof typed !== 'string' || typed !== t.name) return { ok: false, result: 'typed', error: `what was typed is not ${t.name}: nothing is removed`, check: await check(t.name) };
    const said = [];
    const r = await retireProject(t.name, { projects: projects(), ask: async () => typed, say: (s) => said.push(s), checked: (now2) => sheetKey(now2) === t.key });
    if (r.stale) return { ok: false, result: 'changed', error: `${STALE} Nothing was removed.`, check: await check(t.name) };
    return { ok: r.ok, name: t.name, result: r.ok ? 'removed' : 'refused', words: tilde(r.words), removed: r.removed.map(tilde), lines: said.map(tilde), ...(r.counts ? { counts: r.counts } : {}) };
  }

  return { check, retire, tickets };
}
