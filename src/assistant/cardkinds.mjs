// Tia's cards: what a tool's RESULT shows the owner, as data made by this code, never as markup from a model.
//
// A closed set of kinds, each a small typed shape defined here: its fields, their types and a size limit for each.
// The server makes a card from what a tool did (cardmake.mjs) and checks it here; a shape that fails the check is
// dropped and the result stays plain text. The page draws a card with text nodes only (web/tiacards.js): no field is
// ever read as HTML, and a link is only ever a page address of this dashboard ("#/…"). The model writes words; it
// never writes a card's field, a link or a button.
//
//   confirm   an act that waits for the owner's OK (cards.mjs; as before)
//   form      a confirm card whose value the owner may change before his OK (two to four fields, checked again)
//   choice    a question with two to four answers; a tap sends the answer's words as his message, nothing else
//   status    a session or a computer: its state now, since when, the one step          (follows its subject)
//   progress  a job or a Work run: steps done and to come, the time so far              (follows its subject)
//   list      a few items, each with one step; "Show all" opens the page that has them
//   numbers   usage, limits and load: figures put in by code, with their unit and their time
//   result    done or failed: what changed, where to see it, Undo where the tool has one
//   plan      several acts as one plan: every step with its state, run by code after one tap (follows its subject)
//   needs     items of the attention list with the recommended step                    (follows its subject)
//   open      one page of the dashboard (open_screen)
import crypto from 'node:crypto';
import { stripped } from './fence.mjs';
import { looksSecret, redact } from './secrets.mjs';

export const KINDS = Object.freeze(['confirm', 'form', 'choice', 'status', 'progress', 'list', 'numbers', 'result', 'needs', 'plan', 'open']);
/** The kinds that follow their subject while they are in view (web/tiacards.js). */
export const DYNAMIC = Object.freeze(['status', 'progress', 'needs', 'plan']);
export const PLAN_STEP_STATES = Object.freeze(['waiting', 'running', 'holding', 'done', 'failed', 'undone', 'undo-failed', 'skipped']);
export const PLAN_STATES = Object.freeze(['running', 'done', 'failed', 'stopped', 'gone']);
export const STATES = Object.freeze(['starting', 'working', 'waiting', 'asks', 'limit', 'ended', 'shell', 'online', 'offline', 'unknown', 'gone']);
export const RUN_STATES = Object.freeze(['working', 'waiting', 'done', 'stuck', 'stopped', 'failed', 'limit', 'unknown', 'gone']);
export const UNITS = Object.freeze(['%', 'sessions', 'load', 'tasks']);
// A page address of this dashboard and nothing else: no scheme, no query, no space (web/tiacards.js checks it again).
export const HREF = /^#\/[A-Za-z0-9_\-./%:]{0,190}$/;
const ID = /^v_[0-9a-f]{12}$/;

// A path of the computer (a home folder, a drive) or a secret never goes into a card: a builder keeps the folder's
// last part only (shortText), and the check below drops a card that still holds one.
const PRIVATE_PATH = /(?:^|[\s"'(=:])(?:\/(?:home|Users|root|private|var\/folders)\/|[A-Za-z]:\\)/;
export const looksPrivate = (v) => PRIVATE_PATH.test(v) || looksSecret(v);

/** Text for a card: no hidden or control characters, no secret, a path of the computer cut to its last part, clipped. */
export function shortText(v, max) {
  const one = redact(stripped(String(v ?? ''))).replace(/(?:\/(?:home|Users|root|private|var\/folders)\/|[A-Za-z]:\\)[^\s"']*/g, (m) => `…/${m.split(/[\\/]/).filter(Boolean).pop() || ''}`).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ---- the checks: each returns true when the value has the right type and size ----
const str = (max, opt = false) => (v) => (v === undefined ? opt : typeof v === 'string' && v.length > 0 && v.length <= max && stripped(v) === v && !looksPrivate(v));
const int = (min, max, opt = false) => (v) => (v === undefined ? opt : Number.isInteger(v) && v >= min && v <= max);
const num = (opt = false) => (v) => (v === undefined ? opt : typeof v === 'number' && Number.isFinite(v));
const bool = (opt = false) => (v) => (v === undefined ? opt : typeof v === 'boolean');
const oneOf = (list, opt = false) => (v) => (v === undefined ? opt : list.includes(v));
const time = (opt = true) => (v) => (v === undefined || v === null ? opt : Number.isInteger(v) && v > 0 && v < 1e13);
const href = (opt = true) => (v) => (v === undefined || v === null ? opt : typeof v === 'string' && HREF.test(v));
const list = (item, min, max, opt = false) => (v) => (v === undefined ? opt : Array.isArray(v) && v.length >= min && v.length <= max && v.every(item));
const value = (v) => v === null || (typeof v === 'string' && v.length <= 500 && stripped(v) === v && !looksPrivate(v)) || (typeof v === 'number' && Number.isFinite(v));
const obj = (spec, opt = false) => (v) => (v === undefined || v === null ? opt
  : typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => Object.hasOwn(spec, k)) && Object.entries(spec).every(([k, c]) => c(v[k])));

const step = obj({ label: str(40), href: href(false) }, true);
// `term`: the terminal's own id, which a rename keeps, so a card follows the session and not its name. `created`: when
// it was made (a card without `term` checks it, so a new session that took the old name is not taken for its own).
const planStep = obj({ label: str(120), state: oneOf(PLAN_STEP_STATES), note: str(160, true) });
const subject = (types) => obj({ type: oneOf(types), computer: str(32), id: str(80), created: time(), term: str(40, true) });

/** Every kind's fields (besides kind, id and at). confirm is cards.mjs's own record; form rides on it (`form`). */
export const SHAPES = Object.freeze({
  form: obj({
    title: str(160),
    // `password`: a field the owner types a secret into (an administrator password). Its value is never
    // placed in the card's input, the audit log, the card record or a "changed by the owner" line — core.mjs confirm()
    // pulls it out of the confirm values before the form merge and carries it only to the act (ctx), scrubbed.
    fields: list(obj({ name: str(40), label: str(60), type: oneOf(['readonly', 'text', 'number', 'choice', 'password']), value, min: num(true), max: num(true), options: list(str(60), 1, 8, true) }), 2, 4),
  }),
  choice: obj({ question: str(300), options: list(str(60), 2, 4), free: bool() }),
  status: obj({ subject: subject(['session', 'computer']), title: str(120), state: oneOf(STATES), since: time(), note: str(200, true), step }),
  progress: obj({ subject: subject(['job', 'run']), title: str(160), steps: list(str(60), 1, 6), done: int(0, 6), state: oneOf(RUN_STATES), started: time(), ended: time(), step }),
  list: obj({ title: str(120), items: list(obj({ label: str(120), sub: str(120, true), state: oneOf(STATES, true), href: href() }), 0, 8), total: int(0, 1_000_000), all: step }),
  numbers: obj({ title: str(120), rows: list(obj({ label: str(60), value: num(), unit: oneOf(UNITS), of: num(true), note: str(80, true) }), 1, 8), asOf: time(false) }),
  result: obj({ ok: bool(), title: str(160), changed: list(str(160), 0, 6), see: step, undo: bool(true) }),
  plan: obj({ subject: subject(['plan']), title: str(120), steps: list(planStep, 2, 12), state: oneOf(PLAN_STATES), started: time(), ended: time(), note: str(200, true), step }),
  needs: obj({
    items: list(obj({
      id: str(40), rev: str(12), subject: str(80), kind: str(20), facts: list(str(100), 0, 4), why: str(160, true), since: str(30, true),
      act: obj({ id: str(20), label: str(40), risk: oneOf(['none', 'low', 'stops', 'others'], true), href: href() }),
      gone: bool(true),
    }), 1, 3),
    total: int(0, 1_000_000),
    all: step,
  }),
  open: obj({ label: str(80), href: href(false) }),
});

/** Whether `card` is a card of a kind this module knows, of exactly its shape. */
export function validCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
  const { kind, id, at, ...fields } = card;
  return Object.hasOwn(SHAPES, kind) && typeof id === 'string' && ID.test(id) && time(false)(at) && SHAPES[kind](fields);
}

/** A card from a builder's fields: checked, or null (the result then stays plain text). */
export function makeCard(kind, fields, now = Date.now()) {
  const card = { kind, id: `v_${crypto.randomBytes(6).toString('hex')}`, at: Math.floor(now), ...fields };
  return validCard(card) ? card : null;
}

/** A form's fields alone (a confirm card carries them as `form`): checked, or null. */
export const validForm = (form) => SHAPES.form(form);

const KEEP = 500;

/**
 * The cards this dashboard showed, by id, with the conversation each belongs to and what only the server keeps for
 * it (`hidden`: the undo record a result card offers). Kept until the dashboard restarts, as the conversations are.
 */
export class ViewStore {
  constructor() {
    this.views = new Map();
  }

  add(conversation, card, hidden = {}) {
    this.views.set(card.id, { card, conversation, hidden });
    if (this.views.size > KEEP) this.views.delete(this.views.keys().next().value);
    return card;
  }

  get(id) {
    return typeof id === 'string' && ID.test(id) ? this.views.get(id) || null : null;
  }

  /** The cards of one conversation, oldest first. */
  of(conversation) {
    return [...this.views.values()].filter((v) => v.conversation === conversation).map((v) => v.card);
  }
}
