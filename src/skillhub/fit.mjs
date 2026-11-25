// Skills that fit a project's technology: New project's box "Add skills that fit its technology" and a project's
// "Fits its technology" on the Skills page. Find before create, in this order:
//   1. a skill of the owner's own (his user scope) that fits is named "already yours": nothing is copied;
//   2. a reviewed catalog entry that fits and is LOW-RISK (lowRisk) goes in by itself, through the same review and
//      approve as a press (quarantine, scan, install, record), and the page offers Undo;
//   3. everything else waits for him, as a card whose review shows every file before he adds it.
// "Fits" is detect.mjs's facts (no AI): a catalog entry's technology signals, and the technology words of the project
// (its stacks, the dependencies the catalog names) in an own skill's name. Nothing is made for a technology here, and
// a skill from outside the catalog (skills.sh, a hub) never goes in by itself: only the catalog's reviewed version
// does.
//
// The choice per project lives in Hoprig's state (<state>/skillhub/fit.json: { [project]: { fit, firstCode, last } }),
// never in the project. The fit runs when the project is made (its route) and once when it first has code (the
// skills feature's hourly timer: firstCodeFits).
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog } from './catalog.mjs';
import { detectProject, signalEvidence } from './detect.mjs';
import { parseFrontMatter } from './frontmatter.mjs';
import * as hub from './hub.mjs';
import { hubDir, listInstalled, scopeOf } from './store.mjs';

/** A low-risk skill is small: at most this many files and bytes in all. */
export const LOW_RISK = { files: 50, bytes: 512 * 1024 };
const TEXT = /\.(md|txt)$/i;
// Front matter that asks for tools, pre-approves them or runs something: never low-risk.
const TOOL_KEYS = ['allowed-tools', 'tools', 'hooks', 'requires'];
// Stacks every web project has: no technology of their own to fit a skill's name to.
const GENERIC = new Set(['code', 'multi-repo', 'web', 'web-ui', 'server']);
// Signals that are not a technology: a skill for every project, the new-project skill's brief.
const NOT_TECH = new Set(['always', 'file:brief']);

/**
 * Whether a review (hub.prepare's) is low-risk: every file is text (.md or .txt), none can be run, none is a link; the
 * front matter asks for no tool; the catalog entry needs no tool; the scan found nothing; it is inside LOW_RISK.
 * → { ok, why: [plain reasons it is not] }.
 */
export function lowRisk(review, entry = null) {
  const why = [];
  const files = Array.isArray(review && review.files) ? review.files : [];
  if (!files.length) why.push('it has no files');
  for (const f of files) {
    if (f.kind === 'symlink') why.push(`${f.path} is a link`);
    else if ((f.mode || 0) & 0o111) why.push(`${f.path} can be run`);
    else if (f.kind !== 'text' || !TEXT.test(f.path)) why.push(`${f.path} is not a text file (.md or .txt)`);
  }
  const fm = parseFrontMatter(String((review && review.skillMd) || '')).data || {};
  for (const k of TOOL_KEYS) if (fm[k] !== undefined) why.push(`its SKILL.md asks for ${k}`);
  if ((entry && (entry.tool || entry.tools)) || (review && review.catalog && review.catalog.tool)) why.push('it needs a tool on this computer');
  const found = Array.isArray(review && review.findings) ? review.findings.length : 0;
  if (found) why.push(`the scan found ${found} thing${found > 1 ? 's' : ''} to look at`);
  if (files.length > LOW_RISK.files || Number((review && review.total) || 0) > LOW_RISK.bytes) why.push(`it is bigger than ${LOW_RISK.files} files or ${LOW_RISK.bytes / 1024} KB`);
  return { ok: !why.length, why: [...new Set(why)] };
}

/** The review is the very version the catalog reviewed (bundled with Hoprig, or its pinned commit). */
function catalogVersion(review, e) {
  const s = (review && review.source) || {};
  if (e.bundled) return s.type === 'bundled' && s.catalogId === e.id;
  return s.type === 'git' && /^[0-9a-f]{40}$/.test(e.commit || '') && s.commit === e.commit;
}

/** The evidence of an entry's technology signals in a detected project ("package.json has next 16.0.1"). */
function techWhy(det, e) {
  const why = [];
  for (const s of e.signals || []) {
    if (NOT_TECH.has(s)) continue;
    const ev = signalEvidence(det, s);
    if (ev && !why.includes(ev)) why.push(ev);
  }
  return why;
}

/** The project's technology words with their evidence: its stacks, and the dependencies the catalog's signals name. */
function techWords(det, entries) {
  const words = new Map();
  for (const [s, ev] of Object.entries(det.stacks)) if (!GENERIC.has(s)) words.set(s, ev);
  const named = new Set(entries.flatMap((e) => e.signals || []).filter((s) => /^(npm|pub|pypi|go|cargo):/.test(s)).map((s) => s.slice(s.indexOf(':') + 1)));
  for (const [eco, deps] of Object.entries(det.deps)) {
    for (const [n, d] of Object.entries(deps)) {
      if (!named.has(n)) continue;
      const word = n.replace(/^@[^/]+\//, '').toLowerCase();
      if (!words.has(word)) words.set(word, signalEvidence(det, `${eco}:${n}`) || `${d.where} has ${n}`);
    }
  }
  return words;
}

/**
 * An own skill fits when its name holds one of the project's technology words as a whole word ("next-patterns" holds
 * "next"; "react-native" is one word of two parts).
 */
function nameFits(name, words) {
  const n = `-${String(name).toLowerCase().replace(/[_.]/g, '-')}-`;
  return [...words].filter(([w]) => n.includes(`-${w}-`)).map(([, ev]) => ev);
}

/**
 * The fit of one project. dir: the project; allowed(realPath): the folders the caller may touch (refused: throws,
 * nothing changed). entries: the catalog's (tests give their own); prepare(entry, opts): hub.prepare by default.
 * → { project, at, code (detect.mjs found code), mine: [{ name, why }], added: [{ id, name, for, license, why }],
 *     waiting: [{ …, reasons }] }.
 */
export async function fitProject({ dir, allowed = null, entries = null, prepare = null } = {}) {
  const scope = scopeOf({ project: dir }, allowed);
  const det = detectProject(scope.root);
  const list = entries || loadCatalog().entries;
  const own = listInstalled(scopeOf({}));
  const here = new Set(listInstalled(scope).map((s) => s.name));
  const words = techWords(det, list);
  const mine = [];
  const added = [];
  const waiting = [];
  const named = new Set();
  const name = (n, why) => {
    if (named.has(n)) return;
    named.add(n);
    mine.push({ name: n, why });
  };
  for (const s of own) {
    if (here.has(s.name)) continue;
    const why = nameFits(s.name, words);
    if (why.length) name(s.name, why);
  }
  const take = prepare || ((e, o) => hub.prepare(e.id, o));
  for (const e of list) {
    const why = techWhy(det, e);
    if (!why.length || here.has(e.skill)) continue;
    if (own.some((s) => s.name === e.skill)) {
      name(e.skill, why);
      continue;
    }
    const card = { id: e.id, name: e.skill, for: e.for, license: e.license, why };
    // A skill that needs a program on the computer is never low-risk: a card, without fetching it now.
    if (e.tool || e.tools) {
      waiting.push({ ...card, reasons: ['it needs a tool on this computer'] });
      continue;
    }
    let review;
    try {
      review = await take(e, { project: scope.root, forceProject: true, allowed });
    } catch (err) {
      waiting.push({ ...card, reasons: [`it could not be fetched: ${err.message}`] });
      continue;
    }
    const risk = lowRisk(review, e);
    const pinned = catalogVersion(review, e);
    if (risk.ok && pinned) {
      try {
        hub.approve(review.id);
        added.push({ ...card, name: review.name });
        continue;
      } catch (err) {
        risk.why.push(err.message);
      }
    }
    hub.cancel(review.id);
    waiting.push({ ...card, name: review.name || card.name, reasons: [...(pinned ? [] : ['it is not the version the catalog reviewed']), ...risk.why] });
  }
  return { project: scope.root, at: new Date().toISOString(), code: hasCode(det), mine, added, waiting };
}

/** What a fit did, in one line (the New project job's output). */
export function fitSaid(r) {
  const parts = [r.added.length ? `${r.added.length} added by themselves (Undo on the project's Skills page)` : '', r.mine.length ? `${r.mine.length} of your own fit` : '', r.waiting.length ? `${r.waiting.length} waiting for you on its Skills page` : ''].filter(Boolean);
  return `Skills that fit its technology: ${parts.length ? parts.join(', ') : 'none yet; Hoprig looks again once it has code'}`;
}

// ---- the choice per project, in Hoprig's state ----

const fitFile = () => path.join(hubDir(), 'fit.json');
const keyOf = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

export function readFits() {
  try {
    const j = JSON.parse(fs.readFileSync(fitFile(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeFits(all) {
  fs.mkdirSync(hubDir(), { recursive: true });
  const tmp = `${fitFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, fitFile());
}

/** A project's choice: { fit (off unless he chose it), firstCode (the first-code fit ran), last (the last fit) }. */
export function fitChoice(dir) {
  const r = readFits()[keyOf(dir)];
  return { fit: Boolean(r && r.fit === true), firstCode: Boolean(r && r.firstCode === true), last: (r && r.last) || null };
}

export function setFitChoice(dir, fit) {
  const all = readFits();
  const k = keyOf(dir);
  all[k] = { ...(all[k] || {}), fit: fit === true };
  writeFits(all);
  return fitChoice(dir);
}

/** Keep a fit's result; firstCode: it ran on a project that has code (no first-code fit is needed after it). */
export function recordFit(dir, result, { firstCode = false } = {}) {
  const all = readFits();
  const k = keyOf(dir);
  all[k] = { ...(all[k] || {}), last: result, ...(firstCode ? { firstCode: true } : {}) };
  writeFits(all);
}

/** Whether detect.mjs finds an ecosystem or a stack: the project has code. */
export const hasCode = (det) => Object.keys(det.stacks).length > 0 || Object.values(det.deps).some((d) => Object.keys(d).length > 0);

/**
 * The first-code fit: each project whose choice is on and that had no first-code fit yet gets one, once it has code.
 * fit: fitProject (tests give a stand-in). → the fits it ran.
 */
export async function firstCodeFits({ allowed = null, fit = fitProject } = {}) {
  const done = [];
  for (const [dir, r] of Object.entries(readFits())) {
    if (!r || r.fit !== true || r.firstCode === true) continue;
    let det;
    try {
      if (allowed && !allowed(fs.realpathSync(dir))) continue;
      det = detectProject(dir);
    } catch {
      continue; // gone, or not readable now: the next hour looks again
    }
    if (!hasCode(det)) continue;
    const result = await fit({ dir, allowed });
    recordFit(dir, result, { firstCode: true });
    done.push(result);
  }
  return done;
}

/**
 * The project's "Fits its technology", for its Skills page: the choice and the last fit's three lists, each skill marked
 * `here` when it is in the project now (an added one he took out, a waiting one he added).
 */
export function fitLists(dir, { allowed = null } = {}) {
  const scope = scopeOf({ project: dir }, allowed);
  const c = fitChoice(scope.root);
  const here = new Set(listInstalled(scope).map((s) => s.name));
  const last = c.last || { mine: [], added: [], waiting: [] };
  const mark = (list) => (Array.isArray(list) ? list : []).map((x) => ({ ...x, here: here.has(x.name) }));
  return { project: scope.root, fit: c.fit, firstCode: c.firstCode, at: last.at || null, code: last.code === true, mine: Array.isArray(last.mine) ? last.mine : [], added: mark(last.added), waiting: mark(last.waiting) };
}
