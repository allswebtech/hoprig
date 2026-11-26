// What Tia keeps of the owner's corrections: ONE small record each time he declines her card, presses Undo on her act,
// sends a mission's task back with words, changes her plan before he accepts it, taps another step than the one she
// recommended, or lifts her hold. Nothing changes by itself from them: they are only SHOWN where he decides (the
// Operator page under each rule and under "Tia decides", the Team tab under each role, the Skills page per skill), and
// "Use these as evidence" (his press) writes the skill corrections in the improvement loop's evidence shape.
//
//   operator.corrections   { on }   off unless on is exactly true; at most PER_DAY records a day; no model, no cost
//   <state>/operator/corrections.jsonl   one record a line: { at, kind, about: { rule? decision? skill? role? }, words? }
//                   words: his own typed words only, at most 500 characters, masked (keptWords: folders, keys, e-mail);
//                   never a transcript. Kept KEEP_DAYS days. They never leave this computer: no field report carries one.
//   <state>/operator/evidence.jsonl      written by "Use these as evidence" only; its lines go after KEEP_DAYS as the
//                   records do, and the whole file with "Forget these"

import fs from 'node:fs';
import path from 'node:path';
import { cleanInput } from '../assistant/fence.mjs';
import { stateDir, tilde } from '../paths.mjs';
import { cleanText, pathsOf } from '../work/runs.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { replaceFile } from '../replacefile.mjs';

export const KINDS = Object.freeze(['declined', 'undo', 'sent-back', 'plan-changed', 'other-answer', 'hold-lifted']);
export const ABOUT = Object.freeze(['rule', 'decision', 'skill', 'role']);
export const PER_DAY = 200;
export const KEEP_DAYS = 90;
export const WORDS_MAX = 500;
const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
const ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const KIND_WORDS = { declined: 'declined it', undo: 'took it back with Undo', 'sent-back': 'sent it back', 'plan-changed': 'changed the plan before accepting it', 'other-answer': 'picked another step than the one recommended', 'hold-lifted': 'lifted the hold' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const file = () => path.join(stateDir(), 'operator', 'corrections.jsonl');
export const evidenceFile = () => path.join(stateDir(), 'operator', 'evidence.jsonl');

/** The switch as it applies now: missing or broken is off. */
export const readCorrections = (cfg) => ({ on: isObj(cfg?.operator) && isObj(cfg.operator.corrections) && cfg.operator.corrections.on === true, perDay: PER_DAY });

/** The owner's change of the switch, checked → the new operator.corrections. */
export function applyCorrectionsPatch(cfg, p) {
  if (!isObj(p) || Object.keys(p).some((k) => k !== 'on') || typeof p.on !== 'boolean') throw new Error('corrections is { on: true or false }');
  return { ...(isObj(cfg?.operator?.corrections) ? cfg.operator.corrections : {}), on: p.on };
}

// A home folder of any user on any system, and an e-mail address: masked in his words whoever's they are.
// Only where a path begins (not "/home" inside a longer path).
// A home folder after anything that is not part of a name: a space, a quote, a backtick, a bracket, '<', or the
// slashes of file:///home/... A folder named home inside a path (/srv/data/home) follows a letter and stays.
const HOMES = [/(?<![A-Za-z0-9_.~-])(?:\/home|\/Users)\/[^\s/\\`'")\]>]+/g, /(?<![A-Za-z0-9_.-])[A-Za-z]:\\Users\\[^\s\\`'")\]>]+/gi];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A user at a computer with no domain (ssh alex@box2, also at a sentence's end: "as alex@box2."): a host name starts
// with a letter, so react@18.3.1 stays; a package's tag (lodash@latest, react@next) is no computer and stays too.
const AT_HOST = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@([A-Za-z][A-Za-z0-9-]*)(?!\.?[A-Za-z0-9@-])/g;
const TAGS = new Set(['latest', 'next', 'beta', 'alpha', 'canary', 'rc', 'nightly', 'stable', 'lts', 'dev', 'experimental', 'insiders', 'edge', 'preview']);
// A user at an address (ssh alex@192.168.1.5): four numbers, so a version of three (react@18.3.1) stays.
const AT_ADDRESS = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/g;

/**
 * His words as kept, at most WORDS_MAX characters: no characters nobody can see; this computer's folders (its home,
 * workspace and projects folder, as a run's words) and any home folder shown as ~; this computer's name, keys and
 * e-mail addresses masked.
 */
export function keptWords(s, cfg = {}) {
  if (typeof s !== 'string' || !s.trim()) return null;
  let paths = [];
  try {
    paths = pathsOf({ projectsDir: projectsIn(cfg), workspace: workspaceDir(cfg) });
  } catch {
    /* the folders cannot be told: the home folders below still go */
  }
  let t = cleanText(cleanInput(s).value.replace(/\s+/g, ' ').trim(), WORDS_MAX, paths);
  for (const re of HOMES) t = t.replace(re, '~');
  return t.replace(EMAIL, '***').replace(AT_ADDRESS, '***').replace(AT_HOST, (all, host) => (TAGS.has(host.toLowerCase()) ? all : '***'));
}

const okRecord = (r) => isObj(r) && typeof r.at === 'number' && Number.isFinite(r.at) && KINDS.includes(r.kind) && isObj(r.about)
  && Object.entries(r.about).every(([k, v]) => ABOUT.includes(k) && typeof v === 'string' && ID.test(v)) && (r.words === undefined || (typeof r.words === 'string' && r.words.length <= WORDS_MAX));

/**
 * Every record kept (KEEP_DAYS), oldest first. What is older, or a broken line, goes from the file at this read,
 * whatever the switch says: the pages read it on every view, so his words are never kept longer than said.
 */
export function listCorrections(now = Date.now()) {
  let text = '';
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const all = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((r) => okRecord(r) && now - r.at < KEEP_DAYS * DAY_MS);
  if (all.length < lines.length) {
    try {
      const tmp = `${file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, all.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
      replaceFile(tmp, file());
    } catch {
      /* written again at the next read */
    }
  }
  return all;
}

/**
 * Keep one correction, when the switch is on. c: { kind, about: { rule? decision? skill? role? }, words? }. → whether
 * it was kept. Never throws: a correction that cannot be kept changes nothing of what he did.
 */
export function noteCorrection(cfg, c, now = Date.now()) {
  try {
    if (!readCorrections(cfg).on || !isObj(c) || !KINDS.includes(c.kind) || !isObj(c.about)) return false;
    const about = Object.fromEntries(Object.entries(c.about).filter(([k, v]) => ABOUT.includes(k) && typeof v === 'string' && ID.test(v)));
    if (!Object.keys(about).length) return false;
    const all = listCorrections(now);
    if (all.filter((r) => now - r.at < DAY_MS).length >= PER_DAY) return false;
    const words = keptWords(c.words, cfg);
    const rec = { at: now, kind: c.kind, about, ...(words ? { words } : {}) };
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file(), `${JSON.stringify(rec)}\n`, { mode: 0o600 }); // what is older went at the read above
    return true;
  } catch {
    return false;
  }
}

/** "Forget these": every record goes, in one press, and the evidence written from them with it. → how many there were. */
export function forgetCorrections(now = Date.now()) {
  const n = listCorrections(now).length;
  fs.rmSync(file(), { force: true });
  fs.rmSync(evidenceFile(), { force: true });
  return n;
}

/** The evidence file keeps his words no longer than the records do: a line seen KEEP_DAYS ago or before goes. */
function pruneEvidence(now) {
  let text;
  try {
    text = fs.readFileSync(evidenceFile(), 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  const keep = lines.filter((l) => {
    try {
      const seen = Date.parse(`${JSON.parse(l).seen}T00:00:00Z`);
      return Number.isFinite(seen) && now - seen < KEEP_DAYS * DAY_MS;
    } catch {
      return false;
    }
  });
  if (keep.length === lines.length) return;
  try {
    if (!keep.length) return fs.rmSync(evidenceFile(), { force: true });
    const tmp = `${evidenceFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map((l) => `${l}\n`).join(''), { mode: 0o600 });
    replaceFile(tmp, evidenceFile());
  } catch {
    /* again at the next read */
  }
}

/** The evidence file as the panel names it after the toast has gone: { file (home as ~), lines }, or null. */
export function evidenceKept() {
  try {
    const lines = fs.readFileSync(evidenceFile(), 'utf8').split('\n').filter(Boolean).length;
    return lines ? { file: tilde(evidenceFile()), lines } : null;
  } catch {
    return null;
  }
}

/** What the pages show: this week's count per rule, decision kind, skill and role, and the whole by kind. */
export function correctionCounts(now = Date.now()) {
  pruneEvidence(now);
  const all = listCorrections(now);
  const week = all.filter((r) => now - r.at < WEEK_MS);
  const per = Object.fromEntries(ABOUT.map((k) => [k, {}]));
  for (const r of week) for (const [k, v] of Object.entries(r.about)) per[k][v] = (per[k][v] || 0) + 1;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, all.filter((r) => r.kind === k).length]));
  // This week's corrections of a decision by their kind: an Undo of her act is not a chat card he declined, nor a plan
  // he changed, so the page names each where it belongs.
  const decisionKinds = Object.fromEntries(KINDS.map((k) => [k, week.filter((r) => r.about.decision && r.kind === k).length]));
  return { week: per, weekTotal: week.length, total: all.length, byKind, decisionKinds, days: KEEP_DAYS, evidence: evidenceKept() };
}

/**
 * "Use these as evidence": the corrections of a skill in the improvement loop's evidence shape, written into ONE file
 * of the state folder. Those of a rule, a decision or a role are not targets of the loop: they are counted as left out.
 * The loop itself is not started here. → { file, lines, leftOut }.
 */
export function writeEvidence(now = Date.now()) {
  const all = listCorrections(now);
  const lines = all.filter((r) => r.about.skill).map((r) => ({ target: `skill:${r.about.skill}`, kind: 'correction', text: r.words || `The owner ${KIND_WORDS[r.kind]}.`, seen: new Date(r.at).toISOString().slice(0, 10) }));
  fs.mkdirSync(path.dirname(evidenceFile()), { recursive: true, mode: 0o700 });
  const tmp = `${evidenceFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { mode: 0o600 });
  replaceFile(tmp, evidenceFile());
  return { file: evidenceFile(), lines: lines.length, leftOut: all.length - lines.length };
}
