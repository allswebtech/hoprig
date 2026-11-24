// A new project that starts from its owner's brief (`hoprig project new <name> --brief <file> --kind <kind> --start`,
// and the dashboard's New project). What it adds to the folder `project new` makes (project.mjs calls in here):
//
//   docs/brief.md                          the brief, byte for byte as the owner gave it
//   .claude/skills/new-project/            the bundled new-project skill (templates/skills/new-project), where every
//                                          coding tool that opens the project finds it; recorded in
//   .claude/skills/.hoprig-skills.json     as a bundled skill, so `hoprig skills list` and `update` know it
//   AGENTS.md                              a part "Every session": the memory, the brief, the applies table and the
//                                          skill to read in every later session (EVERY_SESSION)
//   decisions.md                           a dated entry "how the project starts": the owner's hint for the kind and
//                                          the scope, or that he chose none (always written: a start reads the newest)
//
// and, with --start, an App session in the new project whose first message names the skill and carries the brief
// (newprojectstart.mjs: through the running dashboard, as `hoprig tasks do` starts one).
//
// The kinds are the skill's own table (SKILL.md, step 2): a test holds both against each other, the references against
// the skill's applies table, and the skill's list of what `project new` makes against what it really makes
// (test/pcsetup/newproject-skill.test.mjs). A kind given here is the owner's HINT: the skill's fit decides the kind
// from the brief, and says so when the two differ. Which references a project reads is the fit's applies table, not
// the kind: that is what makes the skill fit each project.
import fs from 'node:fs';
import path from 'node:path';
import { bundledDir, catalogEntry, packageVersion } from '../skillhub/catalog.mjs';
import { sha256 } from '../skillhub/store.mjs';
import { hiddenIn, withoutHidden } from '../work/model.mjs';
import { brainDir, workspaceDir } from '../workspace/layout.mjs';
import { readIn, writeIn } from '../workspace/inside.mjs';

export const SKILL = 'new-project';
export const SKILL_DIR = `.claude/skills/${SKILL}`;
export const SKILLS_RECORD = '.claude/skills/.hoprig-skills.json';
export const BRIEF_FILE = 'docs/brief.md';
export const DEFAULTS_FILE = 'project-defaults.md'; // in the workspace's AI brain: the owner's own answers
// The brief goes into the session's first message whole; a chat's message is at most 32 KiB, so the brief is less.
export const BRIEF_MAX_BYTES = 24 * 1024;

/**
 * The references of the skill: those read always (how to work, the fit in detail, the final review and report, the
 * structure), then those the fit's applies table marks (one applies line each, in this order).
 */
export const ALWAYS_READ = ['working', 'fit', 'finish', 'structure'];
export const APPLIES = ['database', 'performance', 'security', 'ui', 'search', 'services', 'mobile', 'assistant', 'testing', 'docs'];
export const REFERENCES = [...ALWAYS_READ, ...APPLIES];
/**
 * The kinds of the skill (its table in step 2), in plain words for the page and the terminal. phrase: the kind inside
 * a sentence (its own words, as "API" keeps its capitals); stack: 'default' (the default stack builds it) or 'propose'
 * (it cannot: the AI proposes one in its one message).
 */
export const KINDS = [
  { id: 'website', phrase: 'a website', stack: 'default', label: 'A website', say: 'pages anyone can open; nobody logs in' },
  { id: 'web-app', phrase: 'a web app with accounts', stack: 'default', label: 'A web app with accounts', say: 'people log in and work with their own data' },
  { id: 'multi-tenant', phrase: 'a product for many businesses, or a marketplace', stack: 'default', label: 'A product for many businesses, or a marketplace', say: 'each business or seller has its own data and users, like a booking site for many salons' },
  { id: 'internal', phrase: 'an internal tool', stack: 'default', label: 'An internal tool', say: 'only your own staff use it; nothing is public' },
  { id: 'api', phrase: 'an API or backend only', stack: 'default', label: 'An API or backend only', say: 'other apps call it; it has no screens' },
  { id: 'mobile-first', phrase: 'a phone app first', stack: 'default', label: 'A phone app first', say: 'the apps are the product; the web is their server, the admin area and a few pages' },
  { id: 'cli', phrase: 'a command-line tool', stack: 'propose', label: 'A command-line tool', say: 'used in a terminal' },
  { id: 'library', phrase: 'a library', stack: 'propose', label: 'A library', say: 'a package other code uses' },
  { id: 'extension', phrase: 'a browser extension', stack: 'propose', label: 'A browser extension', say: 'it adds to the browser' },
  { id: 'desktop', phrase: 'a desktop app', stack: 'propose', label: 'A desktop app', say: 'installed on a computer' },
];
export const kindOf = (id) => KINDS.find((k) => k.id === id) || null;
/** The scope: the whole product (the skill's default), or the set-up only (the foundation and its checks, no feature). */
export const SCOPES = [
  { id: 'product', label: 'The whole product', say: 'set it up, then build everything the brief describes' },
  { id: 'setup', label: 'The set-up only', say: 'the structure, the documents and a foundation that builds and passes its checks; the features wait for a later session' },
];
export const scopeOf = (id) => SCOPES.find((s) => s.id === id) || null;

const bad = (message, details) => Object.assign(new Error(message), { status: 400, ...(details ? { details } : {}) });
// Control characters other than a tab and line ends, and the Unicode line and paragraph separators: never typed text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');
// What a paste from a document brings: a line or paragraph separator, a vertical tab, a page break. Each ends a line.
const BREAKS = /[\u2028\u2029\u000b\u000c]/g;
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * A brief, checked and given back UNCHANGED (it is the owner's own words: kept and sent as he wrote them). Refused:
 * empty, more than BRIEF_MAX_BYTES, or a character that cannot be seen: a control character (a page break or a line
 * separator a paste from a document brings, too) or one Work's rule refuses (model.mjs). Then `details` holds
 * { code: 'brief-hidden', clean }: the brief without them (each of a paste's breaks a line end), for the owner to take
 * them out at once, as nobody can find one in a text box.
 */
export function checkProjectBrief(text) {
  if (typeof text !== 'string') throw bad('the brief must be text');
  if (!text.trim()) throw bad('the brief is empty');
  if (Buffer.byteLength(text) > BRIEF_MAX_BYTES) throw bad(`the brief is at most ${BRIEF_MAX_BYTES / 1024} KiB: keep it to what the product is, who uses it and its main features (more can follow in the chat)`);
  // One pass to find the first one (a brief of 24 KiB is checked in the dashboard's own thread, at every start too): a
  // character Work's rule refuses before the first control character comes first. Cut at a control character, the text
  // before it is read as in the whole (no character it allows needs one after it).
  const c = CONTROL.exec(text);
  const at = hiddenIn(c ? text.slice(0, c.index) : text) || (c && c[0]);
  if (at) {
    const clean = withoutHidden(text.replace(BREAKS, '\n').replace(CONTROL_ALL, ''));
    throw bad(`the brief has characters in it that cannot be seen (the first is ${hex(at)}): take them out`, { code: 'brief-hidden', clean });
  }
  return text;
}

/**
 * A choice on the command line given with no value: last on the line, or with another option taken for its value
 * (`--kind --start`). That is a choice the owner meant to make, never "no choice": → the sentence that says what it
 * takes, or null when each of `keys` the flags hold has a value.
 */
export function emptyChoice(o, keys) {
  for (const k of keys) {
    if (!Object.hasOwn(o, k) || (typeof o[k] === 'string' && o[k] && !o[k].startsWith('--'))) continue;
    if (k === 'kind') return `--kind needs one of: ${KINDS.map((x) => x.id).join(', ')}`;
    if (k === 'scope') return `--scope is ${SCOPES.map((x) => x.id).join(' or ')}`;
    return `--${k} needs a value`;
  }
  return null;
}

/** Bytes as text, strictly UTF-8 (a brief in another encoding would be changed by reading it): null when not. */
export function utf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
}

/** The brief of --brief: a file, or "-" for what is typed or piped in (stdin). → text (checked) or throws. */
export async function readBriefArg(value, { stdin = process.stdin } = {}) {
  if (typeof value !== 'string' || !value) throw bad('--brief needs a file (or "-" to type it)');
  let buf;
  if (value === '-') {
    const parts = [];
    let n = 0;
    for await (const ch of stdin) {
      n += ch.length;
      // Over the cap it is too big whatever it holds: said so before decoding, as the read may stop inside a character.
      if (n > BRIEF_MAX_BYTES * 4) throw bad(`the brief is at most ${BRIEF_MAX_BYTES / 1024} KiB`);
      parts.push(Buffer.from(ch));
    }
    buf = Buffer.concat(parts);
  } else {
    let st;
    try {
      st = fs.statSync(value);
    } catch {
      throw bad(`the brief file ${value} is not there`);
    }
    if (!st.isFile()) throw bad(`${value} is not a file`);
    if (st.size > BRIEF_MAX_BYTES * 4) throw bad(`the brief is at most ${BRIEF_MAX_BYTES / 1024} KiB`);
    buf = fs.readFileSync(value);
  }
  const text = utf8(buf);
  if (text === null) throw bad('the brief is not UTF-8 text: save it as UTF-8 first');
  return checkProjectBrief(text);
}

/** The bundled skill's files, as template files under .claude/skills/new-project: [{ rel, kind: 'file', data }]. */
export function skillFiles() {
  const base = bundledDir(catalogEntry(SKILL));
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(base, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push({ rel: `${SKILL_DIR}/${r}`, kind: 'file', data: fs.readFileSync(path.join(base, r)) });
    }
  };
  walk('');
  return out;
}

/**
 * The record of the skill in the project's .claude/skills/.hoprig-skills.json, as `hoprig skills add` writes one for
 * a bundled skill (store.mjs placeSkill): its source, license and the SHA-256 of each file.
 */
export function skillRecord(files, now = new Date()) {
  const entry = catalogEntry(SKILL);
  const at = now.toISOString();
  const hashes = Object.fromEntries(files.map((f) => [f.rel.slice(SKILL_DIR.length + 1), sha256(f.data)]));
  const rec = { source: { type: 'bundled', catalogId: entry.id, path: entry.bundled, version: packageVersion() }, license: entry.license, files: hashes, installedAt: at, updatedAt: at };
  return `${JSON.stringify({ version: 1, skills: { [SKILL]: rec } }, null, 2)}\n`;
}

/**
 * The part of the parent's AGENTS.md that keeps the skill the rule book after the set-up: every coding tool reads
 * AGENTS.md at the start of a session, while a skill is read only when its description fits the task. So a later
 * session ("add feature X") reads the memory, the brief and the applies table, and follows the references that apply.
 */
export const EVERY_SESSION = `## Every session

This project is set up and kept with the ${SKILL} skill. At the start of every session read, in this order:
\`ai_brain/learnings.md\`, \`ai_brain/active_context.md\`, \`${BRIEF_FILE}\`, \`decisions.md\` and the applies table at
the top of \`docs/checklist.md\`. The rules are the skill in \`${SKILL_DIR}\`: its \`SKILL.md\` and the references
the applies table marks \`full\` or \`light\`. An instruction that changes the project is fitted again first (the
skill's step 4).
`;

/**
 * decisions.md's entry for how the project starts: the owner's hint for the kind and the scope as chosen when the
 * project was made, or that he chose none. Written for every project made with a brief, also when nothing was chosen:
 * a start reads the newest such entry (newprojectstart.mjs madeWith), and a template's decisions.md may hold one of its
 * own project's, which must not speak for this one.
 */
export function startDecision({ kind = null, scope = null }, day) {
  const lines = [
    kind ? `- The owner's hint for the kind: ${kindOf(kind).phrase} (\`${kind}\`). The new-project skill's fit decides the kind from the brief (.claude/skills/new-project/SKILL.md, step 2).`
      : '- No hint for the kind: the new-project skill\'s fit works it out from the brief (.claude/skills/new-project/SKILL.md, step 2).',
    scope ? `- The scope: ${scopeOf(scope).label.replace(/^The /, '').toLowerCase()} (\`${scope}\`): ${scopeOf(scope).say}.`
      : '- The scope: as the brief says; the whole product when it says nothing.',
  ];
  return `\n## ${day}: how the project starts\n\n${lines.join('\n')}\n`;
}

/** The owner's defaults file in the workspace's AI brain, when it is there (a regular file): its path, else null. */
export function defaultsFile(brain = brainDir(workspaceDir())) {
  const f = path.join(brain, DEFAULTS_FILE);
  return readIn(brain, f) ? f : null;
}

/**
 * The session's first message: the skill by name and place, the kind, the owner's defaults (a path from the project's
 * folder), and the brief as he wrote it, after a line of its own.
 */
export function firstMessage({ brief, kind = null, scope = null, defaults = null }) {
  const k = kind ? kindOf(kind) : null;
  return [
    `Use the ${SKILL} skill (${SKILL_DIR}/SKILL.md) to set up this new project from my brief.`,
    scope === 'setup' ? 'Scope: set-up only. Do the skill\'s set-up steps and the foundation\'s checks, then the final report, and stop: build no feature of the brief.'
      : scope === 'product' ? 'Scope: the whole product. Set it up, then build everything the brief describes.'
      : 'Scope: as my brief says; the whole product when it says nothing.',
    k ? `My hint for the kind: ${k.phrase} (\`${k.id}\`). It is a hint: your fit decides the kind from the brief, and your one message says so when the two differ.` : 'I chose no kind: your fit works it out from the brief.',
    defaults ? `My defaults for every project are in ${defaults}: read them first. They are my answers to the skill's details and its defaults.` : null,
    `My brief is below, exactly as I wrote it; it is also kept unchanged in ${BRIEF_FILE}.`,
    '',
    'Start with the skill\'s first steps: understand the brief, do the fit (the kind, both size tiers, the applies table and the stack), and send me ONE message with the six points the skill names, in its order. Read the references the skill reads always, and any other only when your applies table marks it full or light. Then wait for my reply.',
    '',
    '----- my brief -----',
    brief,
  ].filter((l) => l !== null).join('\n');
}

/**
 * What `project new` adds for a brief, a kind and --start, worked out BEFORE anything is written (a refusal leaves no
 * folder behind). o: the parsed flags (brief, kind, start); given: { brief } typed text (the dashboard). → { error } or
 * { brief, kind, start, files (template files to add), said: [what a dry run says, after "would "], after(root, ui) }.
 */
export async function prepareNew(o, { ui, brief: typed = undefined, stdin = process.stdin } = {}) {
  const given = typed !== undefined && typed !== null && typed !== '';
  // `--brief` last on the line has no value, and one before another option took that option as its file: both are a
  // brief the owner meant to give, never a project without one.
  if (!given && Object.hasOwn(o, 'brief') && (typeof o.brief !== 'string' || o.brief.startsWith('--'))) return { error: '--brief needs a file (or - to type it)' };
  // A brief typed at the terminal (--brief -) is read to its end, and then the terminal has nothing left to answer a
  // question with: the questions come first there, the brief after them.
  const fromStdin = !given && o.brief === '-';
  const coming = given || o.brief !== undefined;
  let kind = o.kind === undefined ? null : String(o.kind);
  if (kind !== null && !kindOf(kind)) return { error: `the kind is one of: ${KINDS.map((k) => k.id).join(', ')}` };
  let scope = o.scope === undefined ? null : String(o.scope);
  if (scope !== null && !scopeOf(scope)) return { error: `the scope is one of: ${SCOPES.map((s) => s.id).join(', ')}` };
  if (o.start && !coming) return { error: '--start needs a brief: --brief <file> (or --brief - to type it)' };
  if ((kind !== null || scope !== null) && !coming) return { error: `--${kind !== null ? 'kind' : 'scope'} goes with a brief: --brief <file> (or --brief - to type it)` };
  let brief = null;
  const read = async () => {
    try {
      brief = given ? checkProjectBrief(typed) : await readBriefArg(o.brief, { stdin });
      return null;
    } catch (e) {
      return { error: e.message, details: e.details };
    }
  };
  if (coming && !fromStdin) {
    const refused = await read();
    if (refused) return refused;
  }
  // Asked only where a terminal is, and only for a project that starts from a brief: both are the owner's to give.
  const asks = coming && !ui.dryRun && ui.interactive && !ui.yes;
  if (kind === null && asks) {
    const opts = [...KINDS.map((k, i) => ({ key: String(i + 1), label: `${k.label}: ${k.say} (${k.id})` })), { key: '0', label: 'Not sure, or a mix: the AI works it out from the brief' }];
    const key = await ui.choose('What kind of project is it? (a hint: the AI works it out from the brief and says so when it differs)', opts, '0');
    kind = key && key !== '0' ? KINDS[Number(key) - 1].id : null;
  }
  if (scope === null && asks) {
    const key = await ui.choose('What should the AI do?', SCOPES.map((x, i) => ({ key: String(i + 1), label: `${x.label}: ${x.say}` })), '1');
    scope = SCOPES[Number(key) - 1] ? SCOPES[Number(key) - 1].id : 'product';
  }
  if (fromStdin) {
    // At a terminal nothing would show while it waits for the brief: say what to type and how to end it.
    if (stdin && stdin.isTTY) ui.note(`Type the brief (at most ${BRIEF_MAX_BYTES / 1024} KiB), then press Ctrl-D on a line of its own${process.platform === 'win32' ? ' (Ctrl-Z, then Enter, on Windows)' : ''}:`);
    const refused = await read();
    if (refused) return refused;
  }
  // The skill comes with a brief only: it is how a project is set up from one, and a plain project stays as it was.
  const skill = brief !== null ? skillFiles() : [];
  const files = brief === null ? [] : [...skill, { rel: SKILLS_RECORD, kind: 'file', data: Buffer.from(skillRecord(skill)) }, { rel: BRIEF_FILE, kind: 'file', data: Buffer.from(brief, 'utf8') }];
  // What a dry run says, each after "would ".
  const said = [
    brief !== null ? `add the ${SKILL} skill in ${SKILL_DIR} (where every coding tool that opens the project finds it)` : null,
    brief !== null ? `add the brief, unchanged, as ${BRIEF_FILE} (${Buffer.byteLength(brief)} bytes)` : null,
    brief !== null ? 'add the part "Every session" to AGENTS.md, unless it has it (the memory, the brief, the applies table and the skill every later session reads)' : null,
    brief !== null ? `add ${kind ? `your hint for the kind (${kind})` : 'that you gave no hint for the kind'} and ${scope ? `the scope (${scope})` : 'that the scope is as the brief says'} to decisions.md, as the entry "how the project starts"` : null,
    o.start ? 'then start a session in the App with a first message that names the skill and carries the brief' : null,
  ].filter(Boolean);
  return {
    brief, kind, scope, start: Boolean(o.start), files, said,
    /**
     * After the template is written, before the first commit: with a brief, AGENTS.md's "Every session" part, and the
     * entry "how the project starts" in decisions.md.
     */
    after(root, now = new Date()) {
      if (brief === null) return;
      const add = (rel, fresh, text) => {
        const file = path.join(root, rel);
        const cur = readIn(root, file);
        writeIn(root, file, `${cur ? cur.toString('utf8').replace(/\n*$/, '\n') : fresh}${text}`);
      };
      // A template made from such a project has the part already: once is enough (its words may be the owner's own).
      const agents = readIn(root, path.join(root, 'AGENTS.md'));
      if (!(agents && /^## Every session[ \t]*\r?$/m.test(agents.toString('utf8')))) add('AGENTS.md', '# Rules for AI tools\n', `\n${EVERY_SESSION}`);
      add('decisions.md', '# Decisions\n', startDecision({ kind, scope }, now.toISOString().slice(0, 10)));
    },
  };
}

/** The files a brief adds, by place (New project's preview lists them before anything is made). */
export const briefFileList = () => [...skillFiles().map((f) => f.rel), SKILLS_RECORD, BRIEF_FILE];

/**
 * The template's files with the new project's own: a template file at the same place as the brief is replaced by the
 * brief (it was given now), and the skill is left out when the owner's own template has one (his own version). A
 * template with a skills record of its own (other skills added with `hoprig skills add`) but without this skill keeps
 * its record, with this skill's entry added to it: the skill is then known as bundled, as anywhere else.
 */
export function withProjectFiles(templateFiles, extra, fill = (s) => s) {
  const theirs = new Set(templateFiles.map((f) => fill(f.rel)));
  const hasSkill = [...theirs].some((r) => r === SKILL_DIR || r.startsWith(`${SKILL_DIR}/`));
  const ours = extra.files.find((f) => f.rel === SKILLS_RECORD);
  const merged = !hasSkill && ours && ours.data && theirs.has(SKILLS_RECORD) ? mergedRecord(templateFiles.find((f) => fill(f.rel) === SKILLS_RECORD), ours) : null;
  const keep = extra.files.filter((f) => !(hasSkill && (f.rel.startsWith(`${SKILL_DIR}/`) || f.rel === SKILLS_RECORD)) && !(f.rel !== BRIEF_FILE && theirs.has(f.rel)));
  const tpl = templateFiles.filter((f) => !(fill(f.rel) === BRIEF_FILE && extra.brief !== null)).map((f) => (merged && fill(f.rel) === SKILLS_RECORD ? { ...f, data: merged } : f));
  return [...tpl, ...keep];
}

/** The template's skills record with this skill's entry added (or put anew); null when the template's is not one. */
function mergedRecord(theirs, ours) {
  try {
    const t = JSON.parse(Buffer.from(theirs.data).toString('utf8'));
    if (!t || typeof t !== 'object' || Array.isArray(t) || (t.skills !== undefined && (typeof t.skills !== 'object' || t.skills === null || Array.isArray(t.skills)))) return null;
    const o = JSON.parse(Buffer.from(ours.data).toString('utf8'));
    return Buffer.from(`${JSON.stringify({ ...t, version: t.version || o.version, skills: { ...(t.skills || {}), [SKILL]: o.skills[SKILL] } }, null, 2)}\n`);
  } catch {
    return null; // not JSON: his file stays as it is
  }
}
