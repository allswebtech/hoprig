// The eval's --candidate folder: a changed text tried in place of the shipped one, for one run only, as an outside
// improvement loop asks for it. The folder holds only
//   skills/<name>/SKILL.md            one of Tia's built-in skills, changed (it loads before the built-in one)
//   tools/<tool>.description.txt     one tool's description, changed (its schema, level and note stay)
//   prompt/<section>.md               one section of her system prompt, changed (its heading stays); never one of
//                                     the safety sections (PROTECTED in src/assistant/prompt.mjs)
// A link, any other file or folder, a name Tia does not have, or a text that does not load refuses the whole run
// (CandidateError: the runner exits 2 and runs nothing). Nothing here is written anywhere but a temporary folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_DIR, Skills } from '../../../src/assistant/skills.mjs';
import { byName } from '../../../src/assistant/tools.mjs';
import { MAX_SECTION, sectionRefusal, shippedSection } from '../../../src/assistant/prompt.mjs';

export class CandidateError extends Error {}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(HERE, 'mcp-candidate.mjs');
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOL_FILE = /^([a-z][a-z0-9_]{1,63})\.description\.txt$/;
const SECTION_FILE = /^([a-z]+(?:-[a-z]+)*)\.md$/;
const MAX_SKILL = 64 * 1024;
const MAX_DESCRIPTION = 4000;
const builtIn = () => new Skills({ dirs: [{ dir: BUILTIN_DIR, source: 'built-in' }] });

/** The live text of a part ("skills/<name>", "tools/<tool>" or "prompt/<section>"), exactly as the eval would use it. */
export function liveText(part) {
  const m = /^(skills|tools|prompt)\/([a-z0-9_-]{1,64})$/.exec(String(part || ''));
  if (!m) throw new CandidateError(`"${String(part).slice(0, 80)}" is not a part: skills/<name>, tools/<tool> or prompt/<section>`);
  if (m[1] === 'prompt') {
    const body = shippedSection(m[2]);
    if (body === null) throw new CandidateError(`her prompt has no section "${m[2]}"`);
    return body;
  }
  if (m[1] === 'skills') {
    const s = builtIn().get(m[2]);
    if (!s) throw new CandidateError(`Tia has no built-in skill "${m[2]}"`);
    return fs.readFileSync(s.file, 'utf8');
  }
  const t = byName.get(m[2]);
  if (!t) throw new CandidateError(`Tia has no tool "${m[2]}"`);
  return t.description;
}

const kindOf = (full) => {
  const st = fs.lstatSync(full);
  return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
};

/** Read and check a candidate folder: { dir, skills: Map name → text, tools: Map tool → text, prompt: Map section → text, parts }. */
export function readCandidate(dir) {
  let k;
  try {
    k = kindOf(dir);
  } catch {
    throw new CandidateError('the candidate folder does not exist');
  }
  if (k !== 'dir') throw new CandidateError('the candidate is a link or not a folder');
  const skills = new Map();
  const tools = new Map();
  const prompt = new Map();
  const refuse = (rel, why) => {
    throw new CandidateError(`candidate ${rel}: ${why}`);
  };
  for (const top of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, top);
    if (kindOf(full) !== 'dir' || !['skills', 'tools', 'prompt'].includes(top)) refuse(top, 'only the folders skills/, tools/ and prompt/ are taken');
    for (const name of fs.readdirSync(full).sort()) {
      const rel = `${top}/${name}`;
      const f = path.join(full, name);
      const kind = kindOf(f);
      if (kind === 'link') refuse(rel, 'a link is never followed');
      if (top === 'prompt') {
        const m = SECTION_FILE.exec(name);
        if (kind !== 'file' || !m) refuse(rel, 'only prompt/<section>.md files are taken');
        if (fs.statSync(f).size > MAX_SECTION) refuse(rel, 'larger than 16 KiB');
        const buf = fs.readFileSync(f);
        const text = buf.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(buf)) refuse(rel, 'not UTF-8 text');
        const why = sectionRefusal(m[1], text.trim());
        if (why) refuse(rel, why);
        prompt.set(m[1], text.trim());
        continue;
      }
      if (top === 'tools') {
        const m = TOOL_FILE.exec(name);
        if (kind !== 'file' || !m) refuse(rel, 'only tools/<tool>.description.txt files are taken');
        if (!byName.has(m[1])) refuse(rel, `Tia has no tool "${m[1]}"`);
        if (fs.statSync(f).size > MAX_DESCRIPTION * 4) refuse(rel, 'too large');
        const text = fs.readFileSync(f, 'utf8').trim();
        if (!text || text.length > MAX_DESCRIPTION) refuse(rel, `a description of 1 to ${MAX_DESCRIPTION} characters`);
        tools.set(m[1], text);
        continue;
      }
      if (kind !== 'dir' || !NAME_RE.test(name) || name.length > 64) refuse(rel, 'only skills/<name>/SKILL.md is taken');
      if (!builtIn().get(name)) refuse(rel, `Tia has no built-in skill "${name}"`);
      const inside = fs.readdirSync(f);
      if (inside.length !== 1 || inside[0] !== 'SKILL.md') refuse(rel, 'the folder holds SKILL.md and nothing else');
      const file = path.join(f, 'SKILL.md');
      if (kindOf(file) !== 'file') refuse(`${rel}/SKILL.md`, 'not a plain file');
      if (fs.statSync(file).size > MAX_SKILL) refuse(`${rel}/SKILL.md`, 'larger than 64 KiB');
      skills.set(name, fs.readFileSync(file, 'utf8'));
    }
  }
  if (!skills.size && !tools.size && !prompt.size) throw new CandidateError('the candidate folder holds no skill, no tool description and no prompt section');
  // The same loader Tia uses: a candidate that would not load (bad front matter, an unknown tool) is refused here,
  // never silently replaced by the built-in skill.
  if (skills.size) {
    const s = new Skills({ dirs: [{ dir: path.join(dir, 'skills'), source: 'owner' }] });
    if (s.problems.length) throw new CandidateError(`candidate skills/${s.problems[0].folder}: ${s.problems[0].problem}`);
  }
  return { dir, skills, tools, prompt, parts: [...[...skills.keys()].map((n) => `skills/${n}`), ...[...tools.keys()].map((n) => `tools/${n}`), ...[...prompt.keys()].map((n) => `prompt/${n}`)] };
}

/**
 * What a run needs to use a candidate: { skills() (a Skills for one case), mcpCommand (for the engine), prompt (the
 * sections it replaces, for systemPrompt, or null), cleanup() }.
 * Without a candidate every field is empty and the eval runs the shipped texts.
 */
export function prepare(cand) {
  if (!cand) return { skills: null, mcpCommand: null, prompt: null, cleanup: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-eval-candidate-'));
  let mcpCommand = null;
  if (cand.tools.size) {
    const file = path.join(tmp, 'descriptions.json');
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(cand.tools)), { mode: 0o600 });
    mcpCommand = { command: process.execPath, args: [MCP_SERVER, file] };
  }
  const skillsDir = path.join(cand.dir, 'skills');
  return {
    skills: cand.skills.size ? () => new Skills({ dirs: [{ dir: skillsDir, source: 'owner' }, { dir: BUILTIN_DIR, source: 'built-in' }] }) : null,
    mcpCommand,
    prompt: cand.prompt && cand.prompt.size ? cand.prompt : null,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}
