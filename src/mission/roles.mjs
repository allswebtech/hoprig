// The roles of a mission's sessions: files of the product, `roles/<name>/ROLE.md` (front matter, then the text the
// session is given), in the shape of the bundled skills. They are taken as they ship, never made here; each is read
// strictly: every key known and present, every value of its kind, so a broken role file makes no session at all.
//
// A role says its purpose, the skills it loads, what it may touch, the kind of work it does (code: written and checked
// by the strong model; run: running and recording, by the fast one), the model and effort per kind of work, the tools
// its session has (allow: file tools only) and may never use (deny), what it may never do, how its result is checked
// (tests, file, diff, verdict) and whether it may write (readonly). A role never asks the owner: its session runs where
// nobody is asked (a run that ends by itself), and what it could not do comes back as the mission's word to him.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORTS, MODELS } from '../config.mjs';

export const ROLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles');
export const ROLE_NAMES = Object.freeze(['developer', 'reviewer', 'tester', 'researcher', 'writer', 'ops']);
export const CHECKS = Object.freeze(['tests', 'file', 'diff', 'verdict']);
export const WORKS = Object.freeze(['code', 'run']);
const KEYS = ['name', 'purpose', 'skills', 'touch', 'work', 'model-run', 'model-code', 'model-unknown', 'allow', 'deny', 'never', 'check', 'readonly'];
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^()\r\n,]{1,80}\))?$/;
// The tools a mission's session may have: the coding tool's file tools, and nothing else. A session has no shell, no
// git and nothing that reaches the network (alone.mjs starts it in the coding tool's restricted mode with exactly
// these tools, so a wider list in a role file could never be given anyway: it is refused here, by name).
export const FILE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
const bad = (name, why) => Object.assign(new Error(`the role file of "${name}" ${why}`), { status: 500, details: { code: 'role' } });

/** A role file's text, read strictly. → { name, purpose, skills, touch, work, models: { run, code, unknown }, allow, deny, never, check, readonly, text }. */
export function parseRole(text, name) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!m) throw bad(name, 'has no front matter');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) throw bad(name, `has a line that is no "key: value" (${line.slice(0, 40)})`);
    const k = line.slice(0, i).trim();
    if (!KEYS.includes(k)) throw bad(name, `has an unknown key "${k.slice(0, 30)}"`);
    if (k in fm) throw bad(name, `names "${k}" twice`);
    fm[k] = line.slice(i + 1).trim();
  }
  for (const k of KEYS) if (!(k in fm)) throw bad(name, `has no "${k}"`);
  if (fm.name !== name) throw bad(name, 'names another role');
  if (!WORKS.includes(fm.work)) throw bad(name, `has a bad "work" (one of ${WORKS.join(', ')})`);
  if (!CHECKS.includes(fm.check)) throw bad(name, `has a bad "check" (one of ${CHECKS.join(', ')})`);
  if (!['yes', 'no'].includes(fm.readonly)) throw bad(name, 'has a bad "readonly" (yes or no)');
  const models = {};
  for (const w of ['run', 'code', 'unknown']) {
    const [model, effort, ...rest] = fm[`model-${w}`].split('/');
    if (rest.length || !MODELS.includes(model) || !EFFORTS.includes(effort)) throw bad(name, `has a bad "model-${w}" (model/effort)`);
    models[w] = { model, effort };
  }
  const tools = (k) => {
    const list = fm[k] ? fm[k].split(',').map((x) => x.trim()) : [];
    if (list.length > 40 || list.some((x) => !TOOL_RE.test(x))) throw bad(name, `has a bad "${k}" list`);
    return list;
  };
  const allow = tools('allow');
  const other = allow.find((x) => !FILE_TOOLS.includes(x));
  if (other) throw bad(name, `allows ${other.slice(0, 60)}: a mission's session has the file tools only (${FILE_TOOLS.join(', ')}), no shell, no git and nothing that reaches the network`);
  const deny = tools('deny');
  const readonly = fm.readonly === 'yes';
  // A role that may not write is denied every writing tool, whatever its file says it allows.
  if (readonly && allow.some((x) => /^(Edit|Write)$/.test(x))) throw bad(name, 'may not write and still allows a writing tool');
  if (readonly && !['Edit', 'Write'].every((x) => deny.includes(x))) throw bad(name, 'may not write and does not deny Edit and Write');
  const body = m[2].trim();
  if (!body || body.length > 4000) throw bad(name, 'has no text, or too long a text');
  return { name, purpose: fm.purpose, skills: fm.skills ? fm.skills.split(',').map((x) => x.trim()) : [], touch: fm.touch, work: fm.work, models, allow, deny, never: fm.never, check: fm.check, readonly, text: body };
}

let cache = null;
/** Every role, read once from the product's roles folder (`dir`: a test's own). → Map name → role. */
export function loadRoles(dir = ROLES_DIR) {
  if (cache && cache.dir === dir) return cache.roles;
  const roles = new Map();
  for (const n of ROLE_NAMES) roles.set(n, parseRole(fs.readFileSync(path.join(dir, n, 'ROLE.md'), 'utf8'), n));
  cache = { dir, roles };
  return roles;
}

/**
 * Whether a session of hers may take a task, from who does it in Work's words (model.mjs whoOf: "me" for the owner, in
 * a planner's file too): "ai" is the developer's, a role of the closed list is that role's. "me" (an account, a
 * purchase, a yes, anything that goes out) and anyone else stay his: no session is started for them.
 * → { role } or { role: null, his: why }.
 */
export function takeOf(who) {
  if (who === 'ai') return { role: 'developer' };
  // A plan's "review it" task: every task of a mission is read by a reviewer session already, after its own work; a
  // review run on a branch of its own would read nothing. It is his to close once he has seen those reviews.
  if (who === 'reviewer') return { role: null, his: 'a reviewer session reads every task of this mission after its work already: close this one in Work when you agree' };
  if (ROLE_NAMES.includes(who)) return { role: who };
  if (who === 'me') return { role: null, his: 'the plan gives it to you: only you can do it' };
  return { role: null, his: `the plan gives it to "${String(who).slice(0, 40)}", not to one of her roles` };
}

/**
 * The tools a role's session has: its file's alone, all of them file tools (parseRole). The project's test command is
 * never one of them, and neither is git: the gate runs the tests, in a box or not at all (gate.mjs), and the
 * dashboard makes the commit (src/work/alonecommit.mjs). A reviewer gets the branch's diff in its brief.
 */
export const toolsFor = (role) => [...role.allow];

/** The model and effort for a role's work: the fast model runs and records, the strong one writes and reviews code. */
export const choiceOf = (role) => role.models[role.work];
