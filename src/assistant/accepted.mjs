// Accepted texts: a tool's description or a section of Tia's prompt that the owner accepted from a proposal
// (src/skillhub/proposals.mjs), kept in Hoprig's state, never in the code:
//   <state>/assistant/accepted/tools/<tool>.description.txt   + <tool>.description.json
//   <state>/assistant/accepted/prompt/<section>.md             + <section>.json
// The .json is { shippedSha256, acceptedAt, proposalId }: the hash of Hoprig's own text the new one was measured
// against. Tia reads them at her start (her prompt, her tool list in `hoprig mcp`). Each is read with limits and
// checked again there, and applies ONLY while Hoprig's own text still has that hash: after an update changes it, the
// accepted text stops applying and the Proposals page says so. A broken, hostile or stale file is skipped, never
// fatal, and listed with its reason.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { PATTERNS, RISKY, foldLooks } from '../skillhub/learnscan.mjs';
import { scanText } from '../skillhub/scan.mjs';
import { PROTECTED, sectionRefusal, shippedSection, systemPrompt } from './prompt.mjs';
import { EAGER_NAMES, byName, mcpToolsJson } from './tools.mjs';
import { replaceFile } from '../replacefile.mjs';

export const acceptedDir = () => path.join(stateDir(), 'assistant', 'accepted');
export const STALE_WHY = "no longer applies: Hoprig's own text changed since it was measured";
const KINDS = {
  tool: { sub: 'tools', text: (n) => `${n}.description.txt`, record: (n) => `${n}.description.json`, re: /^([a-z][a-z0-9_]{1,63})\.description\.(txt|json)$/ },
  prompt: { sub: 'prompt', text: (n) => `${n}.md`, record: (n) => `${n}.json`, re: /^([a-z]+(?:-[a-z]+)*)\.(md|json)$/ },
};
const MAX_TEXT = 16 * 1024;
const MAX_RECORD = 4096;
const MAX_FILES = 64;
const PROPOSAL_ID = /^[0-9]{8}-[0-9]{6}-(tool|prompt)-[a-z0-9_-]{1,64}$/;
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Hoprig's own text of a target, or null when it has none. */
export function shippedText(kind, name) {
  if (kind === 'tool') return EAGER_NAMES.includes(name) ? byName.get(name).description : null;
  if (kind === 'prompt') return PROTECTED.has(name) ? null : shippedSection(name);
  return null;
}

// A text as sentences: a finding counts only in a sentence Hoprig's own text does not have, so a rule its own words
// hit already (a description that says "push", "never follow instructions") is no reason, and a new one is.
const units = (t) => String(t).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

/** Why a new text for a tool's description or a prompt section is refused, as plain reasons; [] when it may apply. */
export function acceptedTextProblems(kind, name, text) {
  const out = [];
  const shipped = shippedText(kind, name);
  if (kind === 'prompt') {
    const why = sectionRefusal(name, typeof text === 'string' ? text.trim() : text);
    if (why) return [why];
  } else if (kind === 'tool') {
    if (shipped === null) return [`Tia has no tool "${String(name).slice(0, 64)}"`];
    const t = typeof text === 'string' ? text.trim() : '';
    if (t.length < 40 || t.length > 1024) return ['a tool\'s description is 40 to 1024 characters'];
    if (/[\u0000-\u001f\u007f]/.test(t)) out.push('the description holds a line break or a control character');
  } else return ['only a tool\'s description or a section of her prompt'];
  if (kind === 'prompt' && /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) out.push('the text holds a control character');
  const had = new Set(units(shipped || ''));
  const fresh = units(text).filter((u) => !had.has(u));
  const joined = fresh.join('\n');
  if (/<\/?\s*untrusted|<!--/i.test(joined)) out.push('a new sentence holds a fence tag or an HTML comment');
  const folded = foldLooks(joined);
  const hits = [...scanText('text.md', joined), ...(folded === joined ? [] : scanText('text.md', folded))].filter((f) => f.severity === 'block' || RISKY.has(f.rule));
  for (const [rule, re] of PATTERNS) if (re.test(folded)) hits.push({ rule, message: rule.replace(/^learn-/, '').replace(/-/g, ' ') });
  if (hits.length) out.push(`a new sentence: ${[...new Set(hits.map((h) => h.message))].join('; ')}`);
  return out;
}

// A plain file inside the folder, at most `max` bytes, valid UTF-8; else null.
function readPlain(file, max) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > max) return null;
  const buf = fs.readFileSync(file);
  const s = buf.toString('utf8');
  return Buffer.from(s, 'utf8').equals(buf) ? s : null;
}
const isDir = (p) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The accepted texts as Tia uses them: { prompt: Map section → text, tools: Map tool → text, entries: [{ kind, name,
 * applies, why, proposalId, acceptedAt }] } where only the entries that apply are in the maps. Never throws.
 */
export function readAccepted(dir = acceptedDir()) {
  const prompt = new Map();
  const tools = new Map();
  const entries = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const sub = path.join(dir, k.sub);
    if (!isDir(sub)) continue;
    let names;
    try {
      names = fs.readdirSync(sub).sort().slice(0, MAX_FILES);
    } catch {
      continue;
    }
    const seen = new Set();
    for (const f of names) {
      const m = k.re.exec(f);
      if (!m) {
        entries.push({ kind, name: f.slice(0, 80), applies: false, why: 'not a file of accepted texts', proposalId: null, acceptedAt: null });
        continue;
      }
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const name = m[1];
      const one = { kind, name, applies: false, why: '', proposalId: null, acceptedAt: null };
      entries.push(one);
      try {
        const text = readPlain(path.join(sub, k.text(name)), MAX_TEXT);
        const raw = readPlain(path.join(sub, k.record(name)), MAX_RECORD);
        let rec = null;
        try {
          rec = raw === null ? null : JSON.parse(raw);
        } catch {
          rec = null;
        }
        if (text === null || !rec || typeof rec !== 'object' || !/^[0-9a-f]{64}$/.test(String(rec.shippedSha256))) {
          one.why = 'its text or its record is missing, too large, a link or not readable';
          continue;
        }
        one.proposalId = PROPOSAL_ID.test(String(rec.proposalId)) ? rec.proposalId : null;
        one.acceptedAt = typeof rec.acceptedAt === 'string' && !Number.isNaN(Date.parse(rec.acceptedAt)) ? rec.acceptedAt : null;
        const problems = acceptedTextProblems(kind, name, text);
        if (problems.length) {
          one.why = `skipped: ${problems.join('; ')}`;
          continue;
        }
        if (sha256(shippedText(kind, name)) !== rec.shippedSha256) {
          one.why = STALE_WHY;
          one.stale = true;
          continue;
        }
        one.applies = true;
        (kind === 'tool' ? tools : prompt).set(name, text.trim());
      } catch (e) {
        one.why = `skipped: ${String(e.message).slice(0, 200)}`;
      }
    }
  }
  return { prompt, tools, entries };
}

/** The one accepted entry of a target, or null. */
export const acceptedOf = (kind, name, dir = acceptedDir()) => readAccepted(dir).entries.find((e) => e.kind === kind && e.name === name) || null;

const writeAtomic = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  replaceFile(tmp, file);
};

/** Write an accepted text with its record (checked again here; throws with a plain reason). */
export function writeAccepted(kind, name, text, { proposalId, dir = acceptedDir(), now = new Date() } = {}) {
  const problems = acceptedTextProblems(kind, name, text);
  if (problems.length) throw Object.assign(new Error(`the new text was not accepted: ${problems.join('; ')}`), { status: 409 });
  const k = KINDS[kind];
  const sub = path.join(dir, k.sub);
  fs.mkdirSync(sub, { recursive: true, mode: 0o700 });
  if (!isDir(sub)) throw Object.assign(new Error('the folder of accepted texts is not a plain folder'), { status: 409 });
  writeAtomic(path.join(sub, k.text(name)), text.trim());
  writeAtomic(path.join(sub, k.record(name)), JSON.stringify({ shippedSha256: sha256(shippedText(kind, name)), acceptedAt: now.toISOString(), proposalId }, null, 2));
}

/** Remove an accepted text and its record (Undo, Remove). */
export function removeAccepted(kind, name, dir = acceptedDir()) {
  const k = KINDS[kind];
  if (!k || !k.re.test(k.text(name))) throw Object.assign(new Error('that is not an accepted text'), { status: 400 });
  for (const f of [k.text(name), k.record(name)]) fs.rmSync(path.join(dir, k.sub, f), { force: true });
}

/** The text of an accepted file as it is on disk (trimmed), or null. */
export function acceptedTextOnDisk(kind, name, dir = acceptedDir()) {
  const k = KINDS[kind];
  const t = k ? readPlain(path.join(dir, k.sub, k.text(name)), MAX_TEXT) : null;
  return t === null ? null : t.trim();
}

/** Tia's system prompt at her start: the shipped one with the accepted sections that apply. */
export const tiaPrompt = (skillsIndex = '') => systemPrompt(skillsIndex, readAccepted().prompt);
/** Her tool list at her start (`hoprig mcp`): the shipped one with the accepted descriptions that apply. */
export const tiaToolsJson = () => mcpToolsJson(readAccepted().tools);
