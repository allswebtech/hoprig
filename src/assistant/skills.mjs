// Skills: procedures, not tools. A skill is a folder with a SKILL.md in the agentskills.io format:
//
//   ---
//   name: get-coding-done              lower-case-with-dashes, the same as the folder name
//   description: When to use it …      at most 1024 characters
//   allowed-tools: start_session watch_session read_session …     (space- or comma-separated)
//   ---
//   ## When to use / ## Procedure / ## Pitfalls / ## Verification / ## Examples
//
// Found before created, in this order (the first with a name wins):
//   1. the owner's own skills          <configDir>/assistant/skills/<name>/SKILL.md
//   2. the built-in pack                <repo>/skills/<name>/SKILL.md
// Only then may the assistant draft a new one (manage_procedures action draft, an L2 card). A draft never becomes active by itself:
// it is written to the owner's folder only when he confirms the card.
//
// A skill that names a tool the catalog does not have is not loaded (reported in `problems`), so a skill can
// never widen what the assistant can do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../paths.mjs';
import { OLD_NAMES, TOOL_NAMES } from './tools.mjs';
import { loadCatalog } from '../skillhub/catalog.mjs';

export const BUILTIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
export const ownerSkillsDir = () => path.join(configDir(), 'assistant', 'skills');
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_FILE = 64 * 1024;

/** Parse a SKILL.md. Returns { name, description, allowedTools, body } or throws with a plain reason. */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no front matter (--- … ---) at the top');
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && listKey) {
      meta[listKey] = [...(Array.isArray(meta[listKey]) ? meta[listKey] : []), unquote(item[1])];
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = kv[2] === '' ? kv[1] : null;
    meta[kv[1]] = kv[2] === '' ? [] : unquote(kv[2]);
  }
  const name = typeof meta.name === 'string' ? meta.name : '';
  if (!NAME_RE.test(name) || name.length > 64) throw new Error('name must be lower-case-with-dashes, at most 64 characters');
  const description = typeof meta.description === 'string' ? meta.description : '';
  if (!description || description.length > 1024) throw new Error('description must be 1 to 1024 characters');
  const raw = meta['allowed-tools'];
  const allowedTools = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/).filter(Boolean);
  return { name, description, allowedTools, body: m[2].trim() };
}

function unquote(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s); // YAML double quotes escape like JSON for the strings we write
    } catch {
      return s.slice(1, -1);
    }
  }
  return s.replace(/^'(.*)'$/, '$1');
}

/** The text of a SKILL.md for a skill object. */
export function formatSkill({ name, description, allowedTools, body }) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nallowed-tools: ${allowedTools.join(' ')}\n---\n\n${body.trim()}\n`;
}

// The built-in folder also holds skills for the coding tools that ship with Hoprig (bundled entries of the skill
// catalog, such as plan-work): those are not the assistant's, and are passed over here.
const forCodingTools = () => new Set(loadCatalog().entries.filter((e) => e.bundled && e.bundled.startsWith('skills/')).map((e) => e.bundled.slice('skills/'.length)));

function readDir(dir, source, problems) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return out;
  }
  const skip = source === 'built-in' && path.resolve(dir) === BUILTIN_DIR ? forCodingTools() : new Set();
  for (const folder of names) {
    if (skip.has(folder)) continue;
    const file = path.join(dir, folder, 'SKILL.md');
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE) throw new Error('SKILL.md is larger than 64 KiB');
      const s = parseSkill(fs.readFileSync(file, 'utf8'));
      if (s.name !== folder) throw new Error(`name "${s.name}" differs from the folder name`);
      // A tool that got a new name is read as the tool it became: a skill written before the change still loads.
      s.allowedTools = [...new Set(s.allowedTools.map((t) => OLD_NAMES.get(t)?.tool ?? t))];
      const unknown = s.allowedTools.filter((t) => !TOOL_NAMES.includes(t));
      if (unknown.length) throw new Error(`allowed-tools names unknown tools: ${unknown.join(', ')}`);
      if (!s.allowedTools.length) throw new Error('allowed-tools is empty');
      out.push({ ...s, source, file });
    } catch (e) {
      if (e.code !== 'ENOENT') problems.push({ source, folder, problem: e.message });
    }
  }
  return out;
}

const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** The first sentence of a skill's description, at most 90 characters, cut at a word (the rest is read with the procedure). */
const clause = (d) => {
  const text = String(d).replace(/\s+/g, ' ').trim();
  const first = (/^.*?[.!?](?=\s|$)/.exec(text) || [text])[0];
  return first.length > 90 ? first.slice(0, 90).replace(/\s+\S*$/, '') : first;
};

export class Skills {
  /** dirs: [{ dir, source }] in find order. Defaults: the owner's folder, then the built-in pack. */
  constructor({ dirs = [{ dir: ownerSkillsDir(), source: 'owner' }, { dir: BUILTIN_DIR, source: 'built-in' }] } = {}) {
    this.dirs = dirs;
    this.reload();
  }

  reload() {
    this.problems = [];
    const seen = new Map();
    for (const { dir, source } of this.dirs) {
      for (const s of readDir(dir, source, this.problems)) if (!seen.has(s.name)) seen.set(s.name, s);
    }
    this.all = [...seen.values()];
    return this;
  }

  get(name) {
    return this.all.find((s) => s.name === name) || null;
  }

  /** The best matches for a plain-words query: name hits count most, then description, then the body. */
  find(query, n = 3) {
    const q = words(query);
    if (!q.length) return [];
    const scored = this.all.map((s) => {
      const name = words(s.name.replace(/-/g, ' '));
      const desc = words(s.description);
      const body = new Set(words(s.body));
      let score = 0;
      for (const w of q) {
        if (name.some((x) => x.startsWith(w) || w.startsWith(x))) score += 5;
        if (desc.some((x) => x.startsWith(w) || w.startsWith(x))) score += 2;
        if (body.has(w)) score += 0.5;
      }
      return { s, score };
    });
    return scored.filter((x) => x.score >= 2).sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).slice(0, n).map((x) => x.s);
  }

  /** One line per skill for the system prompt (name and description), stable order. */
  index() {
    // A name and the first clause of what it is for (the rest is read with the procedure): the index is paid for in every first request.
    return this.all.map((s) => `- ${s.name}: ${clause(s.description)}`).join('\n');
  }

  /** Write a confirmed draft into the first (owner's) folder and load it. Only core.mjs calls this, on Confirm. */
  save({ name, description, body, allowedTools }) {
    const target = this.dirs[0];
    if (!target || target.source !== 'owner') throw new Error('there is no owner skills folder to write to');
    const text = formatSkill({ name, description, allowedTools, body });
    parseSkill(text); // the same checks as loading
    const dir = path.join(target.dir, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text, { mode: 0o600, flag: 'wx' });
    this.reload();
    return this.get(name);
  }
}
