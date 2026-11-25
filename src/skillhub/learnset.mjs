// Learning skills from the owner's work: the switch and what it keeps on this computer (Hoprig's state folder,
// <state>/skillhub/learned/, never the brain):
//   settings.json   { on, provider, model, perWeek, last: { usd, tokens, at, billed } }   off until the owner turns it on
//   ledger.json     { looks: [{ at, run, trigger, result }], drafts: [{ at, id }] }   for the caps, newest last
//   declined.json   [{ key, name, words, steps?, at }]   ideas he discarded: never offered again (words, steps: hashes, wordPrints)
//
// The caps count the last seven days by the clock, and a time in the future counts too: a clock set back cannot
// make room for more looks. Only names (letters, digits, hyphens) and hashes are in declined.json, so that list can
// be shown to the model without carrying text a session wrote.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODELS } from '../config.mjs';
import { withLock } from '../work/lock.mjs';
import { hubDir } from './store.mjs';

export const WEEK_MS = 7 * 24 * 3600_000;
export const DRAFTS_PER_WEEK = 3;
export const PER_WEEK_MAX = 20;
export const PER_WEEK_DEFAULT = 5;
export const CHEAPEST = 'haiku';
const LEDGER_MAX = 500;
const DECLINED_MAX = 1000;

export const learnDir = () => path.join(hubDir(), 'learned');
const file = (n) => path.join(learnDir(), n);

/** A skill name as the Agent Skills specification allows it: lowercase letters, digits, single hyphens, 1-64. */
export const specName = (n) => typeof n === 'string' && n.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n);

/** The learned skill beside the generated `hoprig` one: what was learned about using Hoprig on this computer. */
export const HOPRIG_LEARNED = 'hoprig-learned';

function readJson(n, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file(n), 'utf8'));
  } catch {
    return dflt;
  }
}

/** Written through a temporary file and a rename, so a reader never sees half a file. */
function writeJson(n, value) {
  fs.mkdirSync(learnDir(), { recursive: true, mode: 0o700 });
  const tmp = file(`${n}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file(n));
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/; // a provider's name (as runs.mjs takes it)

export function readLearnSettings() {
  const s = readJson('settings.json', {});
  const last = s.last && Number.isFinite(s.last.usd) ? { usd: s.last.usd, tokens: Number(s.last.tokens) || 0, at: String(s.last.at || ''), billed: s.last.billed === true } : null;
  return {
    on: s.on === true && typeof s.provider === 'string' && NAME_RE.test(s.provider),
    provider: typeof s.provider === 'string' && NAME_RE.test(s.provider) ? s.provider : null,
    model: MODELS.includes(s.model) ? s.model : CHEAPEST,
    perWeek: Number.isInteger(s.perWeek) && s.perWeek >= 1 && s.perWeek <= PER_WEEK_MAX ? s.perWeek : PER_WEEK_DEFAULT,
    last,
  };
}

/** Change the settings; `providers`: the names that may be chosen. Throws 400 on a bad value. */
export function writeLearnSettings(patch, { providers = [] } = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const cur = readLearnSettings();
  const next = { ...cur };
  for (const k of Object.keys(patch)) if (!['on', 'provider', 'model', 'perWeek'].includes(k)) throw bad(`"${String(k).slice(0, 30)}" is not a setting of learning`);
  if ('on' in patch) {
    if (typeof patch.on !== 'boolean') throw bad('on is true or false');
    next.on = patch.on;
  }
  if ('provider' in patch) {
    if (typeof patch.provider !== 'string' || !providers.includes(patch.provider)) throw bad('choose one of your providers');
    next.provider = patch.provider;
  }
  if ('model' in patch) {
    if (!MODELS.includes(patch.model)) throw bad(`the model is one of ${MODELS.join(', ')}`);
    next.model = patch.model;
  }
  if ('perWeek' in patch) {
    if (!Number.isInteger(patch.perWeek) || patch.perWeek < 1 || patch.perWeek > PER_WEEK_MAX) throw bad(`looks per week: 1 to ${PER_WEEK_MAX}`);
    next.perWeek = patch.perWeek;
  }
  if (next.on && !(next.provider && providers.includes(next.provider))) throw bad('choose the provider that does the looking first');
  writeJson('settings.json', { on: next.on, provider: next.provider, model: next.model, perWeek: next.perWeek, last: cur.last });
  return readLearnSettings();
}

/** What the last look cost (the look and its test prompts together). `billed`: its provider is billed by use. */
export function noteCost(usd, tokens, now = Date.now(), billed = false) {
  const s = readJson('settings.json', {});
  writeJson('settings.json', { ...s, last: { usd: Math.round(usd * 1e6) / 1e6, tokens, at: new Date(now).toISOString(), billed: billed === true } });
}

export function readLedger() {
  const l = readJson('ledger.json', {});
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && Number.isFinite(x.at)) : []);
  return { looks: list(l.looks), drafts: list(l.drafts) };
}

/** How many of `list` fall in the last seven days (a time ahead of the clock counts: a clock set back). */
export const inWeek = (list, now = Date.now()) => list.filter((x) => x.at > now - WEEK_MS).length;

// A look still running counts toward the drafts of the week (it may make one); one older than this was stopped by a
// restart and counts no more.
export const LOOK_RUNS_MS = 30 * 60_000;

/**
 * Book a look, or say why not, in one step under the ledger's lock (also between two dashboards on one state folder):
 * the looks of the week, the drafts of the week with the looks still running, and a run looked at for this trigger.
 * → { at } | { skipped, why }.
 */
export function bookLook({ run, trigger, perWeek, now = Date.now() }) {
  return withLock(file('ledger.json'), async () => {
    const l = readLedger();
    if (inWeek(l.looks, now) >= perWeek) return { skipped: 'cap', why: `the ${perWeek} looks of this week are used` };
    const running = l.looks.filter((x) => x.result === 'looking' && x.at > now - LOOK_RUNS_MS).length;
    if (inWeek(l.drafts, now) + running >= DRAFTS_PER_WEEK) {
      return { skipped: 'drafts', why: running ? `${DRAFTS_PER_WEEK} drafts of this week are made or may come from the looks running now` : `${DRAFTS_PER_WEEK} drafts were made this week` };
    }
    if (l.looks.some((x) => x.run === run && x.trigger === trigger)) return { skipped: 'looked', why: 'this run was looked at already' };
    l.looks.push({ at: now, run, trigger, result: 'looking' });
    l.looks = l.looks.slice(-LEDGER_MAX);
    writeJson('ledger.json', l);
    return { at: now };
  });
}

/** The end of a look: its result, and the draft it made (counted for the week's drafts). Under the ledger's lock. */
export function settleLook(run, at, result, { draft = null, now = Date.now() } = {}) {
  return withLock(file('ledger.json'), async () => {
    const l = readLedger();
    const e = l.looks.find((x) => x.run === run && x.at === at);
    if (e) e.result = String(result).slice(0, 200);
    if (draft) {
      l.drafts.push({ at: now, id: draft });
      l.drafts = l.drafts.slice(-LEDGER_MAX);
    }
    writeJson('ledger.json', l);
  });
}

/** Has this run been looked at already for this trigger (two presses, a send back twice)? */
export const lookedAt = (run, trigger) => readLedger().looks.some((x) => x.run === run && x.trigger === trigger);

// ---------- ideas he discarded ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The skill a draft is about: a parsed look names a patch's skill `target`, a stored draft keeps it as `name`. */
const skillOf = (d) => (d.kind === 'new' ? d.name : d.target || d.name);

// hoprig-learned grows one lesson at a time, and each of its drafts holds every lesson before it: an idea of it is its
// lesson alone, so one lesson he discarded never stops the next one.
const isLesson = (d) => skillOf(d) === HOPRIG_LEARNED && typeof d.lesson === 'string';
const ideaText = (d) => (isLesson(d) ? d.lesson : d.body);
const hashOf = (s) => crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 24);

/** The key of a draft's idea: a new skill by its name, a change of a skill by the skill and the new text. */
export function ideaKey(d) {
  if (isLesson(d)) return `${d.kind}:${HOPRIG_LEARNED}:${hashOf(d.lesson)}`;
  if (d.kind === 'new') return `new:${d.name}`;
  return `patch:${skillOf(d)}:${hashOf(d.body)}`;
}

/**
 * The words of a draft's text as short hashes (its distinct words of three letters or more, headings left out: every
 * new skill has the same ones): enough to tell that a later draft is nearly the same, while declined.json still holds
 * no text a session wrote.
 */
export const wordPrints = (text) => [...new Set(norm(String(text || '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).split(' ').filter((w) => w.length >= 3))].slice(0, 400)
  .map((w) => crypto.createHash('sha256').update(w).digest('hex').slice(0, 10));
const PRINT_RE = /^[0-9a-f]{10}$/;
/** Two drafts are the same idea from this share of their words on (shared words / all words). */
export const SAME_IDEA = 0.8;
// The Steps part of a new skill's body (parseLook writes it under "## Steps"): a close copy may come with another
// name and another description, so its steps are compared on their own as well.
const stepsOf = (body) => (/^## Steps\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(String(body || '')) || [])[1] || '';
// Steps of fewer distinct words than this say too little to call two skills the same.
const STEPS_MIN = 5;
const likeness = (a, b) => {
  const A = new Set(a);
  const all = new Set([...a, ...b]).size;
  return all ? b.filter((x) => A.has(x)).length / all : 0;
};

const prints = (v) => (Array.isArray(v) ? v.filter((w) => PRINT_RE.test(w)) : []);

export function readDeclined() {
  const v = readJson('declined.json', []);
  return Array.isArray(v) ? v.filter((x) => x && typeof x.key === 'string' && specName(x.name))
    .map((x) => ({ ...x, words: prints(x.words), steps: prints(x.steps) })) : [];
}

/**
 * Did he discard this idea before? The same key; or, for a new skill, any discarded new skill whose text has nearly
 * the same words, or whose steps alone have (the same steps under another name and description); for a change, one
 * of the same skill with nearly the same words.
 */
export function declinedLike(d) {
  const key = ideaKey(d);
  const words = wordPrints(ideaText(d));
  const steps = d.kind === 'new' && !isLesson(d) ? wordPrints(stepsOf(d.body)) : [];
  const like = (a, b) => a.length > 0 && likeness(a, b) >= SAME_IDEA;
  // A lesson about Hoprig is held against the lessons he discarded, made as a new skill or as a change alike.
  const near = (x) => (isLesson(d) ? x.name === HOPRIG_LEARNED : x.key.startsWith(d.kind === 'new' ? 'new:' : `patch:${skillOf(d)}:`));
  return readDeclined().some((x) => x.key === key || (near(x)
    && (like(x.words, words) || (steps.length >= STEPS_MIN && x.steps.length >= STEPS_MIN && like(x.steps, steps)))));
}

export function addDeclined(d, now = Date.now()) {
  const list = readDeclined().filter((x) => x.key !== ideaKey(d));
  list.push({ key: ideaKey(d), name: skillOf(d), words: wordPrints(ideaText(d)), ...(d.kind === 'new' && !isLesson(d) ? { steps: wordPrints(stepsOf(d.body)) } : {}), at: now });
  writeJson('declined.json', list.slice(-DECLINED_MAX));
}
