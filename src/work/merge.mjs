// Two computers' versions of the Work list brought together BY ITEM, not by text: git would merge the file line by
// line and stop at the first two changes that touch neighbouring lines of one JSON list. Pure: no files, no git.
//
// An item is known by its id: "<id>#0". An entry of the list that is no item with an id (a value a person wrote by
// hand) is known by its whole content ("~<json>#<n>": entries with the same content are the same).
//
// An id that two items share in ANY of the three versions (two computers that added the same title) is never merged
// item by item: which of them is which cannot be told, and pairing them by place removes or offers the wrong one.
// All items with that id are taken together: the group as one side left it when the other side did not change it,
// else one conflict for the whole group, the owner's to decide ("<id>#*").
//
// mergeItems(base, mine, theirs): base is the common ancestor (from git), mine this computer's, theirs the server's.
//   - an item changed on one side only takes that side; one changed the same way on both sides is that;
//   - an item added on either side is kept; two different items added with one id on both sides are both kept, and
//     this computer's gets a new id;
//   - an item removed on one side and untouched on the other is removed;
//   - an item changed differently on both sides (or changed on one, removed on the other) is a conflict: the owner
//     decides per item, this computer's version or the other's (`decisions`: key → "mine" | "theirs");
//   - the keys of the file that are not the list (Work does not know them) merge by the same rule, key by key;
//   - the order is the server's, with this computer's new items placed as an add places them (by date); when only
//     one side changed the list at all, the result is that side's list as it stands, order included.
import { insertItem, makeId, viewItem } from './model.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The entries of a list file, each with its key, in order: [{ key, item }]. */
export function keyed(doc) {
  const list = isObj(doc) && Array.isArray(doc.items) ? doc.items : [];
  const seen = new Map();
  return list.map((item) => {
    const base = isObj(item) && typeof item.id === 'string' ? item.id : `~${JSON.stringify(item)}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { key: `${base}#${n}`, item };
  });
}
const byKey = (doc) => new Map(keyed(doc).map((e) => [e.key, e.item]));
/** How a key is shown to the owner and given back by the command: the id (a group of doubled ids too). */
export const keyName = (key) => key.replace(/#(?:0|\*)$/, '');
const idOf = (x) => (isObj(x) && typeof x.id === 'string' ? x.id : null);
const listOf = (doc) => (isObj(doc) && Array.isArray(doc.items) ? doc.items : []);
/** The ids that two or more items share in any of the versions. */
function doubledIn(...docs) {
  const out = new Set();
  for (const d of docs) {
    const seen = new Set();
    for (const x of listOf(d)) {
      const id = idOf(x);
      if (id === null) continue;
      if (seen.has(id)) out.add(id);
      seen.add(id);
    }
  }
  return out;
}
const titleOf = (item, ownerId) => (isObj(item) ? viewItem(item, { ownerId }).title : String(JSON.stringify(item)).slice(0, 60));

/** What changed per item between two versions of the list: [{ key, id, title, what }]. */
export function itemChanges(beforeDoc, afterDoc, ownerId = 'me') {
  const a = byKey(beforeDoc);
  const b = byKey(afterDoc);
  const out = [];
  const added = [];
  for (const [key, x] of b) {
    const old = a.get(key);
    const entry = { key, id: isObj(x) && typeof x.id === 'string' ? x.id : null, title: titleOf(x, ownerId) };
    if (old === undefined) added.push({ ...entry, what: 'added', item: x });
    else if (!same(old, x)) {
      const st = isObj(x) && isObj(old) && x.status !== old.status ? ({ done: 'done', dropped: 'dropped', open: 'opened again' }[x.status] || `now ${x.status}`) : 'changed';
      out.push({ ...entry, what: st });
    }
  }
  const removed = [];
  for (const [key, x] of a) if (!b.has(key)) removed.push({ key, id: isObj(x) ? x.id : null, title: titleOf(x, ownerId), what: 'removed', item: x });
  // An item that is the same in everything but its id was given a new id (doubled ids made single), not removed.
  for (const r of removed) {
    const j = added.findIndex((x) => isObj(x.item) && isObj(r.item) && same({ ...x.item, id: null }, { ...r.item, id: null }));
    if (j >= 0) {
      const [x] = added.splice(j, 1);
      out.push({ key: x.key, id: x.id, title: x.title, what: 'new id', from: r.id });
      r.matched = true;
    }
  }
  for (const x of added) out.push({ key: x.key, id: x.id, title: x.title, what: 'added' });
  for (const r of removed) if (!r.matched) out.push({ key: r.key, id: r.id, title: r.title, what: 'removed' });
  return out;
}

/** The three-way rule for one value: { value, conflict } (value undefined: not there). */
function pick(b, m, t) {
  const has = (v) => v !== undefined;
  if (same(m, t)) return { value: t };
  if (same(m, b)) return { value: t };
  if (same(t, b)) return { value: m };
  if (!has(b) && has(m) && has(t)) return { value: t, both: true }; // both added, differently
  return { value: t, conflict: true };
}

/**
 * → { doc, conflicts: [{ key, name, title, base, mine, theirs, decided }], undecided, renamed: [{ from, to }],
 *     mine: changes base → mine, theirs: changes base → theirs }. Until every conflict is decided, `doc` holds the
 * server's version of each conflicted item (nothing is written from it: save.mjs asks first).
 */
export function mergeItems(baseDoc, mineDoc, theirsDoc, { decisions = {}, ownerId = 'me', today = '1970-01-01' } = {}) {
  for (const d of [mineDoc, theirsDoc]) if (!isObj(d) || (own(d, 'items') && !Array.isArray(d.items))) throw Object.assign(new Error('one version of the Work file has no list of items, so it cannot be merged by item'), { status: 409, code: 'unmergeable' });
  const base = isObj(baseDoc) ? baseDoc : {};
  const changes = { mine: itemChanges(base, mineDoc, ownerId), theirs: itemChanges(base, theirsDoc, ownerId) };
  // Only one side changed anything: that side as it stands, its order and its new items' places included.
  if (same(theirsDoc, base)) return { doc: mineDoc, conflicts: [], undecided: 0, renamed: [], ...changes };
  if (same(mineDoc, base)) return { doc: theirsDoc, conflicts: [], undecided: 0, renamed: [], ...changes };
  const B = byKey(base);
  const M = byKey(mineDoc);
  const conflicts = [];
  // A choice is given by key (the page) or by the name the owner sees (the command).
  const chosen = (key) => {
    const d = own(decisions, key) ? decisions[key] : own(decisions, keyName(key)) ? decisions[keyName(key)] : null;
    return d === 'mine' || d === 'theirs' ? d : null;
  };
  const decide = (key, b, m, t, title) => {
    const d = chosen(key);
    conflicts.push({ key, name: keyName(key), title, base: b ?? null, mine: m ?? null, theirs: t ?? null, decided: d });
    return d === 'mine' ? m : t;
  };
  // Doubled ids: the group of each, decided as one value (an empty group: none left on that side).
  const doubled = doubledIn(base, mineDoc, theirsDoc);
  const groupOf = (doc, id) => listOf(doc).filter((x) => idOf(x) === id);
  const groups = new Map();
  const resolveGroup = (id) => {
    if (!groups.has(id)) {
      const [b, m, t] = [groupOf(base, id), groupOf(mineDoc, id), groupOf(theirsDoc, id)];
      const r = pick(b, m, t);
      const n = Math.max(b.length, m.length, t.length);
      groups.set(id, r.conflict ? decide(`${id}#*`, b, m, t, `${n} tasks with the id "${id}"`) || [] : r.value);
    }
    return groups.get(id);
  };
  const isDoubled = (x) => idOf(x) !== null && doubled.has(idOf(x));

  // The list: the server's order first.
  const items = [];
  const clashes = []; // this computer's items added with a key the server added differently
  const placed = new Set(); // doubled ids whose group is placed
  for (const { key, item: t } of keyed(theirsDoc)) {
    if (isDoubled(t)) {
      // The server's group stays where its items are; another group goes where the server has its first one.
      const group = resolveGroup(idOf(t));
      if (same(group, groupOf(theirsDoc, idOf(t)))) items.push(t);
      else if (!placed.has(idOf(t))) items.push(...group);
      placed.add(idOf(t));
      continue;
    }
    const b = B.get(key);
    const m = M.get(key);
    const r = pick(b, m, t);
    if (r.both) {
      items.push(t);
      clashes.push(m);
    } else if (r.conflict) {
      const v = decide(key, b, m, t, titleOf(t, ownerId));
      if (v !== undefined) items.push(v);
    } else if (r.value !== undefined) items.push(r.value);
  }
  // Removed on the server: gone, unless this computer changed it (then the owner decides).
  const theirKeys = new Set(keyed(theirsDoc).map((e) => e.key));
  const later = [];
  for (const [key, b] of B) {
    if (theirKeys.has(key) || !M.has(key) || isDoubled(b)) continue;
    const m = M.get(key);
    if (same(m, b)) continue;
    const v = decide(key, b, m, undefined, titleOf(m, ownerId));
    if (v !== undefined) later.push(v);
  }
  // Added here only, then the clashes with a new id: placed as an add places them.
  for (const [key, m] of M) if (!B.has(key) && !theirKeys.has(key) && !isDoubled(m)) later.push(m);
  // Doubled ids the server has no item with: their group (this computer's) placed as an add places them.
  for (const id of doubled) if (!placed.has(id)) later.push(...resolveGroup(id));
  const renamed = [];
  for (const m of clashes) {
    const taken = [...items, ...later].filter(isObj).map((x) => ({ id: x.id }));
    const id = makeId(isObj(m) ? m.id : 'item', taken, today);
    renamed.push({ from: m.id, to: id });
    later.push({ ...m, id });
  }
  for (const x of later) insertItem(items, x);

  // The keys of the file beside the list: the server's order, then keys only this computer has.
  const doc = {};
  const keys = [...Object.keys(theirsDoc), ...Object.keys(mineDoc).filter((k) => !own(theirsDoc, k))];
  for (const k of keys) {
    if (k === 'items') {
      Object.defineProperty(doc, k, { value: items, enumerable: true, writable: true, configurable: true });
      continue;
    }
    const b = own(base, k) ? base[k] : undefined;
    const m = own(mineDoc, k) ? mineDoc[k] : undefined;
    const t = own(theirsDoc, k) ? theirsDoc[k] : undefined;
    const r = pick(b, m, t);
    const v = r.conflict || r.both ? decide(`key:${k}`, b, m, t, `the file's "${k}"`) : r.value;
    if (v !== undefined) Object.defineProperty(doc, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  if (!own(doc, 'items') && items.length) doc.items = items;
  return { doc, conflicts, undecided: conflicts.filter((c) => !c.decided).length, renamed, ...changes };
}
