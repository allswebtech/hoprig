// The unreleased block of the changelog (site/content/changelog.md, from "## 0.3.3" to the next "## ") quotes what a
// person sees and types: the labels and buttons in bold, the words of a page in quotes, the commands and options in
// code. Each one must exist at this head, spelled as there. This test reads the block and looks each one up in the
// product's own files (web/, src/, bin/, the installer and the skill package's command); a quoted name that points
// to another entry or section of the block must name one that stands. A name the test cannot place by itself is in
// one of the lists below with its reason, and each such list is held to the block, so none is skipped in silence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = fs.readFileSync(path.join(ROOT, 'site/content/changelog.md'), 'utf8').replace(/\r\n?/g, '\n');
const at = text.indexOf('\n## 0.3.3 ');
const end = text.indexOf('\n## ', at + 1);
const block = text.slice(at, end);

/** The product's files a person reads or types: the page, the server, the command line, the installer, the skill. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p, out); } else if (/\.(m?js|cjs|json|html)$/.test(e.name)) out.push(p);
  }
  return out;
}
// String escapes undone and the names the code puts in by a variable written out, as the page shows them.
const undo = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\u2192/g, '→').replace(/\\u2026/g, '…').replace(/\\u00b7/g, '·')
  .replace(/\$\{(?:NAME|ASSISTANT_NAME)\}/g, 'Tia').replace(/\$\{APP_NAME\}/g, 'Hoprig');
const FILES = [...['web', 'src', 'bin', 'tools', 'packages/hoprig-skill/bin'].flatMap((d) => walk(path.join(ROOT, d))), path.join(ROOT, 'install.sh')]
  .map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: undo(fs.readFileSync(f, 'utf8')) }));

const swapFirst = (s) => (s[0] === s[0].toUpperCase() ? s[0].toLowerCase() : s[0].toUpperCase()) + s.slice(1);
// A placeholder of the block (<name>, …, [instructions], a number of an example) stands for any text in the code.
const pieces = (name) => name.split(/<[^>]*>|…|\[[^\]]*\]|\b\d+(?:[.,]\d+)*\b|\bN\b/).map((s) => s.trim()).filter((s) => s.length > 1);
/** The first file (under `place`, default all) that holds every piece of `name`, its first letter in either case. */
function where(name, place = '') {
  const want = pieces(name);
  if (!want.length) return null;
  const f = FILES.find((x) => x.file.startsWith(place) && want.every((p) => x.text.includes(p) || x.text.includes(swapFirst(p))));
  return f ? f.file : null;
}

/** Every entry of the block: its lead-in and its whole line. */
const entries = [...block.matchAll(/^- (?:\*\*(.+?)\*\*)?.*$/gm)].map((m) => ({ lead: m[1] || '', line: m[0] }));
const heads = [...block.matchAll(/^###? (.+)$/gm)].map((m) => m[1]);
/** A quoted name that names another entry or a section of the block ("see "Tia can decide" below"). */
const inBlock = (name) => entries.some((e) => e.lead.startsWith(name)) || heads.some((h) => h.startsWith(name));

/** The names an entry quotes: bold after its lead-in, a quoted phrase, and in code a command, an option or a doc. */
function quoted({ lead, line }) {
  const body = line.slice(lead ? line.indexOf('**', 4) + 2 : 2);
  const out = [];
  for (const m of body.matchAll(/\*\*(.+?)\*\*/g)) out.push({ kind: 'label', name: m[1].replace(/`/g, '') });
  for (const m of body.replace(/`[^`]*`/g, '').matchAll(/"([^"]+)"/g)) out.push({ kind: 'words', name: m[1] });
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const c = m[1];
    if (/^(hoprig|npx hoprig-skill) /.test(c)) out.push({ kind: 'command', name: c });
    else if (/^--[a-z]/.test(c)) out.push({ kind: 'option', name: c.split(' ')[0] });
    else if (/^\/[a-z]+( |$)/.test(c)) out.push({ kind: 'slash', name: c.split(' ')[0] });
    else if (/^docs\/[A-Z-]+\.md$/.test(c)) out.push({ kind: 'doc', name: c });
  }
  return out;
}

/** A command: its words up to the first value or option stand in one file, each option of it somewhere. */
function placeCommand(c) {
  // A help word at the end is the example of what a help word did before ("hoprig link help"): the command stands.
  const words = c.split(/\s+/).filter((w, i, all) => !(i === all.length - 1 && /^(help|--help|-h)$/.test(w) && i > 1));
  const verb = [];
  for (const w of words) { if (!/^[a-z][a-z-]*(\|[a-z-]+)*$/.test(w)) break; verb.push(w); }
  const last = verb.pop() || '';
  const verbs = last.split('|').map((v) => [...verb, v].join(' '));
  const opts = words.filter((w) => /^--[a-z]/.test(w)).map((w) => w.replace(/[=\]].*$/, ''));
  const miss = [...verbs.filter((v) => !where(v)), ...opts.filter((o) => !FILES.some((f) => new RegExp(`${o}(?![a-z-])`).test(f.text)))];
  return miss.length ? null : 'command';
}

/** Quoted with a made-up value of an example: the words the code writes it from, and where. */
const EXAMPLE = {
  'Automatic (now: Claude Max)': ['web/tia.js', 'Automatic (now: '],
  'when Claude Max reaches its limit, Auto mode may move this session to API (pay as you go), which costs money': ['src/assistant/policy.mjs', 'reaches its limit, Auto mode may move this session to'],
  'Sonnet · Low': ['web/chat/words.js', '`${model} · ${effort}`'],
  'Java 21.0.6, found in Android Studio': ['src/pcsetup/java.mjs', "from: 'Android Studio'"],
  'at the pace of the last hour this window is used up in about N hours': ['src/providers/left.mjs', 'At the pace of the last hour ${WINDOWS[win]} is used up ${when}'],
  'A folder bakery-website with your brief and the starting files the AI needs (35 files). Nothing else on the computer changes.': ['web/projects.js', 'Nothing else on the computer changes.'],
  'Hoprig asked the AI to set up <project> from your brief': ['web/chat/timeline.js', 'Hoprig asked the AI to set up ${name} from your brief'],
  'session … in …, not started by Hoprig': ['src/operator/detect/util.mjs', ', not started by Hoprig'],
  '6 running · 3 wait for you · 2 done · 1 failed': ['src/work/pulse.mjs', "wait${c.waiting === 1 ? 's' : ''} for you"],
  '4 files are not saved to your git server yet': ['web/gitsetup.js', "'files are')} not saved to your git server yet"],
  ' (2)': ['src/workspace/brainmove.mjs', '`${stem} (${n})${ext}`'],
  'This kind of command: npm install': ['web/lib.js', 'This kind of command: ${kind}'],
  'Kept a copy of your list (N changes) and uploaded it to your git server.': ['src/work/save.mjs', 'Kept a copy of your list ('],
  // The plus button is a glyph with no words: the box's (Add files or photos, slash commands) and the diff pane's.
  '+': ['web/chat/composer.js', "'aria-label': 'Add files or photos, slash commands'"],
};

/** Quoted words that are not a label of today: what it said before, a word of a tool or a person, a value. */
const NOT_A_LABEL = {
  '22 or newer': 'the old floor, said as what it was',
  'missing': 'the old state of a project only in the map, said as what it was',
  'moved on both sides': 'git\'s state of two computers that both moved, said as what it was',
  'fast-forward failed': 'the old bare message, said as what it was',
  'spawn npm ENOENT': 'the error a shell without nvm\'s path printed before',
  'Starting': 'the old state of a session at a first question of Claude Code, said as what it was',
  'Bakery Website': 'an example of a name a person types',
  'Settings → …': 'the old form of a sentence on the pages, said as what it was',
  '/rename': 'a command of Claude Code itself, typed in Claude Code',
  '/exit': 'a command of Claude Code itself, typed in a terminal session',
};

/**
 * Labels the code writes in another form than the block quotes (a number put in by a variable): each is looked up
 * in its folder by the code's own spelling, the renamed one only (End, not Close, for Home's act; the one name of
 * Tia's limit).
 */
const PAIRS = {
  'End them…': ['web/', ['End them…']],
  'End 5 sessions': ['web/', ['End ${n} session']],
  // The field of Tia's limit: one name, "daily limit for paid use", which the field's label has too.
  'Daily limit for paid use (US $)': ['web/', ['Daily limit for paid use (US $)']],
};

function place({ kind, name }) {
  if (NOT_A_LABEL[name]) return 'listed';
  if (EXAMPLE[name]) {
    const [file, words] = EXAMPLE[name];
    return FILES.find((f) => f.file === file)?.text.includes(words) ? file : null;
  }
  if (PAIRS[name]) {
    const [dir, spellings] = PAIRS[name];
    return FILES.some((f) => f.file.startsWith(dir) && spellings.some((s) => f.text.includes(s))) ? 'pair' : null;
  }
  if (kind === 'doc') return fs.existsSync(path.join(ROOT, name)) ? name : null;
  if (kind === 'command') return placeCommand(name);
  if (kind === 'option') return FILES.some((f) => new RegExp(`${name}(?![a-z-])`).test(f.text)) ? 'option' : null;
  if (kind === 'slash') return FILES.some((f) => f.text.includes(`'${name}`) || f.text.includes(`name: '${name.slice(1)}'`)) ? 'slash' : null;
  if (kind === 'words' && inBlock(name)) return 'block';
  const parts = name.split(/\s*→\s*/).filter(Boolean);
  return parts.every((p) => where(p)) ? 'found' : null;
}

test('the unreleased block is found and quotes names', () => {
  assert.ok(at >= 0 && end > at);
  assert.ok(entries.length > 100, `${entries.length} entries`);
  assert.ok(entries.flatMap(quoted).length > 300);
});

test('every label, button, command, option and page word the block quotes exists at this head, spelled as there', () => {
  const lost = [];
  for (const e of entries) {
    for (const q of quoted(e)) if (!place(q)) lost.push(`${q.kind} "${q.name}" (in "${e.lead || e.line.slice(2, 60)}")`);
  }
  assert.deepEqual(lost, [], `not found in web/, src/, bin/, install.sh or the block itself:\n${lost.join('\n')}`);
});

test('each name the test places by a list is still quoted in the block, so the lists stay true', () => {
  const all = new Set(entries.flatMap(quoted).map((q) => q.name));
  for (const name of [...Object.keys(EXAMPLE), ...Object.keys(NOT_A_LABEL), ...Object.keys(PAIRS)]) assert.ok(all.has(name), `"${name}" is no longer quoted: take it out of its list`);
});

test('the block says the new words where the code renames them', () => {
  assert.doesNotMatch(block, /Close them…|Close \d+ sessions/, 'Home\'s act is called End');
  assert.doesNotMatch(block.replace(/`[^`]*`|\(\/[^)]*\)/g, ''), /\bhub\b(?!")/, 'the computer the others report to is the main computer; a flag or an address keeps its name');
});
