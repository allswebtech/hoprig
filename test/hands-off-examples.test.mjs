// Every example docs/HANDS-OFF.md shows is asked of the wall itself, so the page cannot say a command is held (or goes
// through) when the wall does otherwise. The examples live in test/hands-off-examples.txt, one row each, with the
// answer the page gives; this file reads that file, asks wallHeld (the function the hook asks, src/hook.mjs) for each
// row, and reads the page to check that it and the data file hold the same examples.
//
// The rule for what counts as an example: EVERY code span (`…`) and every fenced code block of the page. A span that
// is a name, a setting, an option or a part of a line rather than a whole command line is a row too, marked `word`,
// and is not asked of the wall; so no span can be added to the page without a decision written down for it. A span
// that runs over a line break is read with the break as one space, as Markdown shows it.
//
// It spawns nothing: git is a stand-in function that answers the two questions the wall asks of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const page = fs.readFileSync(new URL('../docs/HANDS-OFF.md', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('./hands-off-examples.txt', import.meta.url), 'utf8');

const VERDICTS = new Set(['held', 'not held', 'word']);
const CONTEXTS = new Set(['plain', 'nodefault', '-']);
const rows = data.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l, n) => {
  const a = l.indexOf(' | ');
  const b = l.indexOf(' | ', a + 3);
  assert.ok(a > 0 && b > a, `row ${n + 1} has the form "verdict | context | text": ${l}`);
  const head = l.slice(0, a);
  const unsaid = head.endsWith(', unsaid');
  const row = { verdict: unsaid ? head.slice(0, -', unsaid'.length) : head, unsaid, context: l.slice(a + 3, b), text: l.slice(b + 3).replace(/\\n/g, '\n') };
  assert.ok(VERDICTS.has(row.verdict), `row ${n + 1}: verdict is held, not held or word: ${l}`);
  assert.ok(CONTEXTS.has(row.context), `row ${n + 1}: context is plain, nodefault or -: ${l}`);
  assert.equal(row.verdict === 'word', row.context === '-', `row ${n + 1}: a word, and only a word, has the context -`);
  return row;
});

// What the page shows as code: its fenced blocks whole (inner lines joined by line breaks), then the spans of the text
// outside them.
function examples(md) {
  const out = [];
  const text = md.replace(/^```[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm, (_, body) => {
    out.push(body);
    return '';
  });
  for (const m of text.matchAll(/`([^`]+)`/g)) out.push(m[1].replace(/\s*\n\s*/g, ' '));
  return out;
}

// The session's folder and Hoprig's own folders, made up: nothing here exists on disk.
// They are POSIX places, read as on Linux everywhere: on Windows `/w` is the drive-relative `W:`, which no home is.
const places = { platform: 'linux', cwd: '/w/shop', home: '/w', workspace: '/w', projects: ['/w'], hoprig: ['/w/.config/hoprig', '/w/.local/state/hoprig'], own: '/w/shop', relative: true };
// git as the wall asks it: the remote's default branch (main, or not known) and the branch the session stands on.
const gitFor = (context) => (cwd, args) => {
  const a = args.join(' ');
  if (/^symbolic-ref --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return context === 'nodefault' ? null : 'origin/main';
  if (a === 'symbolic-ref --short HEAD') return 'feature';
  return null; // no tag of that name, nothing else known
};

test('every row of the data file is answered by the wall as the page says', () => {
  const asked = rows.filter((r) => r.verdict !== 'word');
  assert.ok(asked.length >= 30, `only ${asked.length} command lines`); // a floor, so an emptied file cannot pass
  for (const r of asked) {
    const held = wallHeld({ tool: 'Bash', input: { command: r.text }, cwd: places.cwd, git: gitFor(r.context), places });
    assert.equal(held ? 'held' : 'not held', r.verdict, `${JSON.stringify(r.text)} (${r.context})${held ? `: held as ${held.kind}` : ''}`);
  }
});

// The page's own verdict for an example, read from its words: in the example's clause (the text between the "." or
// ";" before and after its first place on the page, code spans set aside), the first "held" or "go(es) through" after
// it, or, when none follows, the last one before it ("is not held" counts as "not held"; "stays held" as "held"). A
// code block's verdict is the last such word of the paragraph that leads into it. A row marked "unsaid" is a command
// the page only names (a way to make a repository, the command that tells the wall a default branch) with no verdict.
const VERDICT = /\b(?:(is|are) not held|held|go(?:es)? through)\b/g;
const verdictOf = (m) => (m[1] || !m[0].includes('held') ? 'not held' : 'held');
const BOUND = /[.;](?=\s|\*|$)/g;
function pageVerdict(md, text) {
  if (text.includes('\n')) {
    const at = md.indexOf(`\`\`\`sh\n${text}\n\`\`\``);
    if (at < 0) return null;
    const lead = md.slice(Math.max(0, md.lastIndexOf('\n\n', at - 3)), at);
    const all = [...lead.matchAll(VERDICT)];
    return all.length ? verdictOf(all[all.length - 1]) : null;
  }
  const spans = [];
  const plain = md.replace(/^```[^\n]*\n[\s\S]*?\n```[ \t]*$/gm, '').replace(/`([^`]+)`/g, (_, t) => {
    spans.push(t.replace(/\s*\n\s*/g, ' '));
    return `\u0001${spans.length - 1}\u0002`;
  }).replace(/\s*\n\s*/g, ' ');
  const i = spans.indexOf(text);
  if (i < 0) return null;
  const mark = `\u0001${i}\u0002`;
  const at = plain.indexOf(mark);
  const before = plain.slice(0, at);
  const ends = [...before.matchAll(BOUND)];
  const start = ends.length ? ends[ends.length - 1].index + 1 : 0;
  const after = plain.slice(at + mark.length);
  const stop = after.search(BOUND);
  const next = [...(stop < 0 ? after : after.slice(0, stop)).matchAll(VERDICT)][0];
  if (next) return verdictOf(next);
  const prev = [...before.slice(start).matchAll(VERDICT)];
  return prev.length ? verdictOf(prev[prev.length - 1]) : null;
}

test('the page gives each asked example the verdict the data file and the wall give it', () => {
  const wrong = [];
  for (const r of rows.filter((x) => x.verdict !== 'word' && !x.unsaid)) {
    const said = pageVerdict(page, r.text);
    if (said !== r.verdict) wrong.push(`${JSON.stringify(r.text)}: the page says ${said || 'nothing'}, the row ${r.verdict}`);
  }
  assert.deepEqual(wrong, []);
  // An "unsaid" row is only a name on the page: it gets no verdict word of its own.
  for (const r of rows.filter((x) => x.unsaid)) assert.ok(page.includes(`\`${r.text}\``), r.text);
});

test('every example the page shows is a row of the data file', () => {
  const known = new Set(rows.map((r) => r.text));
  const shown = examples(page);
  assert.ok(shown.length >= 50, `only ${shown.length} examples read from the page`);
  const missing = [...new Set(shown.filter((t) => !known.has(t)))];
  assert.deepEqual(missing, [], 'examples on the page with no row (add each to test/hands-off-examples.txt with its answer)');
});

test('every row of the data file is an example the page shows', () => {
  const shown = new Set(examples(page));
  const stale = rows.filter((r) => !shown.has(r.text)).map((r) => r.text);
  assert.deepEqual(stale, [], 'rows the page no longer shows');
  assert.equal(new Set(rows.map((r) => r.text)).size, rows.length, 'no row twice');
});
