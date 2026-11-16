// Recipes: "make my next computer like this one". A small JSON file with the kits, the projects folder and the
// repository addresses, and the coding tools Hoprig installs itself (codingTools: ids only); tool versions only as
// information. Never a key, a token, a password or (unless the
// user says yes) an e-mail address.
//
// A recipe comes from outside (a file someone sent, an https address), so validateRecipe is strict: only known
// keys, only known kits, only well-formed Git addresses, a projects folder under the home folder. Nothing in a
// recipe is ever run as a command: kits map to our own fixed commands, repositories go to `git clone -- <url>`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_TOOLS, TOOLS } from '../codetools/index.mjs';
import { KIT_IDS } from './kits.mjs';
import { parseRepo } from './projects.mjs';

export const RECIPE_VERSION = 1;
const MAX_BYTES = 64 * 1024;
const MAX_REPOS = 200;
const KEYS = ['hoprigRecipe', 'kits', 'tools', 'codingTools', 'projectsDir', 'repos', 'git', 'projectTemplate', 'workspaces'];
/** The coding tools a recipe may ask for: the offered ones Hoprig installs into its own tools folder (src/codetools). */
export const RECIPE_CODING_TOOLS = Object.freeze(TOOLS.filter((t) => t.managed).map((t) => t.id));
// A tool Hoprig has built but this version does not offer: a recipe from a version that offered it is read as if it
// did not name it (no error, nothing installed).
const LEFT_OUT = new Set(ALL_TOOLS.filter((t) => t.managed && !RECIPE_CODING_TOOLS.includes(t.id)).map((t) => t.id));

/** A home-relative form of `dir` for another computer ("~/projects"); null when it is outside the home folder. */
export function homeRelative(dir, home = os.homedir()) {
  if (dir === home) return '~';
  return dir.startsWith(home + path.sep) ? `~/${dir.slice(home.length + 1).split(path.sep).join('/')}` : null;
}

export function makeRecipe({ kits, tools = {}, codingTools = [], projectsDir, repos = [], identity = null, withEmail = false, workspaces = [] }) {
  const r = { hoprigRecipe: RECIPE_VERSION, kits: [...kits] };
  if (Object.keys(tools).length) r.tools = tools;
  if (codingTools.length) r.codingTools = [...new Set(codingTools)];
  const rel = projectsDir ? homeRelative(projectsDir) : null;
  if (rel) r.projectsDir = rel;
  if (repos.length) r.repos = [...new Set(repos)];
  if (workspaces.length) r.workspaces = [...new Set(workspaces)];
  if (identity && identity.name) r.git = { name: identity.name, ...(withEmail && identity.email ? { email: identity.email } : {}) };
  return r;
}

/** { ok: true, recipe } or { ok: false, errors: [plain sentences] }. Every refusal says why. */
export function validateRecipe(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['a recipe is a JSON object'] };
  for (const k of Object.keys(input)) if (!KEYS.includes(k)) errors.push(`unknown key "${String(k).slice(0, 40)}"`);
  if (input.hoprigRecipe !== RECIPE_VERSION) errors.push(`"hoprigRecipe" must be ${RECIPE_VERSION}`);
  const out = { hoprigRecipe: RECIPE_VERSION, kits: [] };
  if (!Array.isArray(input.kits)) errors.push('"kits" must be a list');
  else {
    for (const k of input.kits) {
      if (typeof k !== 'string' || !KIT_IDS.includes(k)) errors.push(`unknown kit "${String(k).slice(0, 40)}"`);
      else if (!out.kits.includes(k)) out.kits.push(k);
    }
  }
  if (input.tools !== undefined) {
    if (!input.tools || typeof input.tools !== 'object' || Array.isArray(input.tools)) errors.push('"tools" must be an object');
    else {
      out.tools = {};
      for (const [k, v] of Object.entries(input.tools)) {
        if (!/^[a-z0-9-]{1,30}$/.test(k) || typeof v !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(v)) errors.push(`"tools.${String(k).slice(0, 30)}" is not a name with a version`);
        else out.tools[k] = v;
      }
    }
  }
  if (input.codingTools !== undefined) {
    if (!Array.isArray(input.codingTools)) errors.push('"codingTools" must be a list');
    else {
      out.codingTools = [];
      for (const t of input.codingTools) {
        if (LEFT_OUT.has(t)) continue;
        if (typeof t !== 'string' || !RECIPE_CODING_TOOLS.includes(t)) errors.push(`"${String(t).slice(0, 40)}" is not a coding tool a recipe installs (${RECIPE_CODING_TOOLS.join(', ')})`);
        else if (!out.codingTools.includes(t)) out.codingTools.push(t);
      }
    }
  }
  if (input.projectsDir !== undefined) {
    const d = input.projectsDir;
    if (typeof d !== 'string' || !/^~(\/[A-Za-z0-9._ -]{1,100}){0,8}$/.test(d) || d.split('/').some((p) => p === '..' || p === '.')) errors.push('"projectsDir" must be a folder in the home folder, like "~/projects"');
    else out.projectsDir = d;
  }
  for (const key of ['repos', 'workspaces']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || input[key].length > MAX_REPOS) errors.push(`"${key}" must be a list of at most ${MAX_REPOS} Git addresses`);
    else {
      out[key] = [];
      for (const u of input[key]) {
        const p = typeof u === 'string' ? parseRepo(u) : null;
        if (!p) errors.push(`"${String(u).slice(0, 80)}" is not a Git address Hoprig accepts (https or SSH, no user name or password in it)`);
        else if (!out[key].includes(p.url)) out[key].push(p.url);
      }
    }
  }
  if (input.git !== undefined) {
    const g = input.git;
    if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).some((k) => !['name', 'email'].includes(k))) errors.push('"git" may hold only "name" and "email"');
    else {
      if (typeof g.name !== 'string' || !/^[^\0-\x1f\x7f"\\<>]{1,100}$/.test(g.name)) errors.push('"git.name" must be a plain name');
      if (g.email !== undefined && (typeof g.email !== 'string' || !/^[^\s@<>"\\]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(g.email))) errors.push('"git.email" must be an e-mail address');
      out.git = { name: g.name, ...(g.email ? { email: g.email } : {}) };
    }
  }
  if (input.projectTemplate !== undefined) {
    if (typeof input.projectTemplate !== 'string' || !parseRepo(input.projectTemplate)) errors.push('"projectTemplate" must be a Git address');
    else out.projectTemplate = parseRepo(input.projectTemplate).url;
  }
  return errors.length ? { ok: false, errors } : { ok: true, recipe: out };
}

/** Parse recipe text. */
export function parseRecipeText(text) {
  if (Buffer.byteLength(String(text)) > MAX_BYTES) return { ok: false, errors: ['the recipe is larger than 64 KB'] };
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['the recipe is not valid JSON'] };
  }
  return validateRecipe(j);
}

/** Read a recipe from a file or an https address (nothing else: no http, no file://). */
export async function loadRecipe(src, { fetchImpl = globalThis.fetch } = {}) {
  const s = String(src || '');
  if (/^[a-z]+:\/\//i.test(s)) {
    if (!/^https:\/\//i.test(s)) return { ok: false, errors: ['a recipe address must start with https://'] };
    try {
      const r = await fetchImpl(s, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return { ok: false, errors: [`${s} answered ${r.status}`] };
      if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) return { ok: false, errors: ['the recipe is larger than 64 KB'] };
      return parseRecipeText(await r.text());
    } catch (e) {
      return { ok: false, errors: [`could not download the recipe: ${e.message}`] };
    }
  }
  try {
    const st = fs.statSync(s);
    if (st.size > MAX_BYTES) return { ok: false, errors: ['the recipe is larger than 64 KB'] };
    return parseRecipeText(fs.readFileSync(s, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`cannot read ${s}: ${e.code || e.message}`] };
  }
}
