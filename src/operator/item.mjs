// One thing on the operator's attention list, the acts the owner may tap for it, and the order of the list.
//
// An item is small on purpose: a weak model (or a person glancing at a phone) reads the whole list in one go.
// It carries names, states, numbers and times, never a transcript, a command's text, a file's content or a
// secret. Its id comes from its kind and its subject only, so the same thing is the same item on every look,
// and its `rev` changes only when what it says changes, so a tap made on an old picture can be refused.

import { createHash } from 'node:crypto';
import { PREPARED_ACTS } from './decide-table.mjs';

/** The detectors' kinds, one file each in `detect/`. */
export const KINDS = Object.freeze(['limit', 'stuck', 'asks', 'ended', 'provider', 'machine', 'leftover', 'repo', 'live', 'automation', 'providerstop', 'unknown']);

/**
 * The order of the list: what can harm the owner's data or computer, then stopped work, then what waits for
 * him, then the machine, then information. Inside a class the oldest comes first.
 */
export const CLASSES = Object.freeze(['harm', 'stopped', 'waits', 'machine', 'info']);

/**
 * Every act the panel can offer. Each one is an existing function of the product behind its existing route
 * and checks (see `acts.mjs`); "dismiss" is the panel's own "Not now". `risk` is one of: none, low, stops
 * (stops work that runs), others (other people see it).
 */
export const ACTS = Object.freeze({
  switch: { label: 'Continue on the next provider', risk: 'low', effect: 'The session goes on under the next provider.', undo: 'Choose the first one again in the session.' },
  open: { label: 'Open', risk: 'none', effect: 'Opens where it is.', undo: null },
  stop: { label: 'End the session', risk: 'stops', effect: 'The session and its coding tool stop.', undo: 'Continue it from the project\'s page.' },
  end: { label: 'End the process', risk: 'stops', effect: 'Ends it, and what runs in it, after reading its identity again.', undo: null },
  sync: { label: 'Bring up to date', risk: 'low', effect: 'Brings the newer work from the git server here; nothing of yours changes.', undo: 'The old commit stays in the reflog.' },
  push: { label: 'Push the branch', risk: 'others', effect: 'Sends it to the git server, where others see it.', undo: null },
  'restart-link': { label: 'Restart the public link', risk: 'low', effect: 'Away for a few seconds, then back.', undo: null },
  'restart-gateway': { label: 'Restart the gateway', risk: 'low', effect: 'Stops and starts the add-on.', undo: null },
  reopen: { label: 'Reopen the session', risk: 'low', effect: 'Starts the same conversation again where it stopped. Nothing is sent to it.', undo: 'Close the new session.' },
  clean: { label: 'Clean Hoprig\'s own old files', risk: 'low', effect: 'Removes only Hoprig\'s own old logs and temporary folders, never your files.', undo: null },
  'open-commit': { label: 'Open the commit', risk: 'none', effect: 'Shows what it changed.', undo: null },
  elsewhere: { label: 'Start new work elsewhere', risk: 'low', effect: 'Tia starts new work on that computer until this one has been calm for 10 minutes (2 hours at most). Nothing that runs moves.', undo: 'Its Undo under Computers ends it at once.' },
  dismiss: { label: 'Not now', risk: 'none', effect: 'Hides it until its facts change.', undo: 'It comes back by itself.' },
  // The steps a decision of Tia's may pick (decide-table.mjs): the owner's taps as well.
  ...PREPARED_ACTS,
});

export const MAX_FACTS = 8;
const FACT_CHARS = 100;
const SUBJECT_CHARS = 80;
const WHY_CHARS = 160;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** The stable id of a thing: the same kind and subject give the same id on every look. */
export function itemId(kind, subject) {
  return `${kind}-${hash(`${kind}\n${subject}`)}`;
}

/** One act of the catalog; `href` is where an "open" act leads (a page address, never one with a token). */
export function act(id, extra = {}) {
  const a = ACTS[id];
  if (!a) throw new Error(`unknown act: ${id}`);
  // An act's label, risk, effect and undo are the same for every item: they are sent once with the list
  // (`actCatalog`), so each item stays small enough that a list of 20 fits a weak model and a phone. An item
  // carries only the act's id, and a label or an address of its own when it has one.
  const out = { id };
  if (extra.label) out.label = clip(extra.label, 40);
  if (extra.href) {
    if (!/^#\/[\w\-./%?=&]*$/.test(extra.href)) throw new Error(`an act leads only to a page address: ${extra.href}`);
    out.href = extra.href;
  }
  return out;
}

/**
 * Builds an item. `target` is what the server needs to do an act (a session's name, a process id with its
 * start time, a repository's path inside the workspace); it stays on the server (`publicItem` leaves it out).
 */
export function makeItem({ kind, subject, key = null, since = null, facts = [], acts = [], recommended, why = '', cls, target = null, state = null }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  if (!CLASSES.includes(cls)) throw new Error(`unknown class: ${cls}`);
  const subj = clip(subject, SUBJECT_CHARS);
  if (!subj) throw new Error('an item needs a subject');
  const list = acts.map((a) => (typeof a === 'string' ? act(a) : a)).filter((a) => a.id !== 'dismiss');
  if (!list.length) throw new Error('an item needs at least one act');
  const rec = recommended ?? list[0].id;
  if (!list.some((a) => a.id === rec)) throw new Error(`the recommended act is not one of the item's acts: ${rec}`);
  const lines = facts.filter((f) => f != null && String(f).trim()).slice(0, MAX_FACTS).map((f) => clip(f, FACT_CHARS));
  const item = {
    // `key`: what the id is made from when the subject's words may change (a label renamed): an id is stable.
    id: itemId(kind, key == null ? subj : clip(String(key), SUBJECT_CHARS)),
    kind,
    class: cls,
    subject: subj,
    since: since == null ? null : new Date(since).toISOString(),
    facts: lines,
    acts: list,
    recommended: rec,
    why: clip(why, WHY_CHARS),
  };
  fit(item);
  item.rev = itemRev(item, state);
  if (target) Object.defineProperty(item, 'target', { value: target, enumerable: false });
  return item;
}

/** The most an item may weigh as JSON, so that a list of 20 stays small for a weak model and a phone. */
export const ITEM_BYTES = 700;
const REV_BYTES = 24; // "rev":"<12 hex>", added after fitting

const size = (item) => Buffer.byteLength(JSON.stringify(item)) + REV_BYTES;

/**
 * Small by construction: first the text gets shorter (the reason, then the facts), then the last facts go, so
 * the first facts, which detectors put first because they matter most, stay.
 */
function fit(item) {
  for (let n = 80; size(item) > ITEM_BYTES && n >= 40; n -= 20) {
    item.why = clip(item.why, n);
    item.facts = item.facts.map((f) => clip(f, n));
    item.subject = clip(item.subject, Math.max(n, 40));
  }
  while (size(item) > ITEM_BYTES && item.facts.length > 1) item.facts.pop();
}

/**
 * Each act's label, risk, effect and undo, sent once with a list. `ways`: the places its words name, as codes of the
 * page's one table of places (web/errorways.js); the page draws a link from each code it knows, and nothing for another.
 */
export function actCatalog(items) {
  const ids = new Set([...PANEL_ACTS, ...items.flatMap((i) => i.acts.map((a) => a.id))]);
  return Object.fromEntries([...ids].map((id) => {
    const { label, risk, effect, undo, ways } = ACTS[id];
    return [id, { label, risk, effect, ...(undo ? { undo } : {}), ...(ways ? { ways } : {}) }];
  }));
}

// How long ago and when it was last checked change on every look without anything having changed: they are left
// out of the rev, so a tap made a minute later is still a tap on the same thing, and "Not now" holds.
const ELAPSED = /\b(?:under a minute|\d+ days|\d+ h(?: \d+ min)?|\d+ min)\b|\bchecked at [^,;]*/g;

/**
 * What the item says, as a short hash: the same facts and acts give the same rev, a change gives another. Elapsed
 * times do not count. `state`: a detector's own words for what matters, when its facts hold figures that move all
 * the time (the load, a percentage of use): then only `state` and the acts count.
 */
export function itemRev(item, state = null) {
  const said = state != null ? state : item.facts.map((f) => f.replace(ELAPSED, '…'));
  return hash(JSON.stringify([said, item.acts.map((a) => a.id), item.recommended]));
}

/** The item as a page or Tia sees it (the server-side target is never sent). */
export function publicItem(item) {
  return JSON.parse(JSON.stringify(item));
}

/**
 * "Not now" belongs to the panel, not to one item: every item may be put off, so it is not repeated in each
 * item's list (that keeps an item small) and the server allows it for every item.
 */
export const PANEL_ACTS = Object.freeze(['dismiss']);

/** The acts the server allows for an item: its own, and the panel's. */
export const allowedActs = (item) => [...item.acts.map((a) => a.id), ...PANEL_ACTS];

const t = (s) => (s == null ? Infinity : Date.parse(s));

/** The attention list's order: class first, then the oldest; the id breaks a tie so the order never wobbles. */
export function rank(items) {
  return [...items].sort((a, b) => CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) || t(a.since) - t(b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
