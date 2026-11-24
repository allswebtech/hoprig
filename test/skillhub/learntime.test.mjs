// Every pattern that reads text a session or a model wrote for a learned skill (learnscan.mjs, learnlook.mjs, and the
// cleaning of a run's text: cleanText, redact) on long hostile lines: each must answer in a few milliseconds, since
// the scan runs synchronously in the dashboard. A pattern that backtracks shows here as seconds or minutes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scan = await import('../../src/skillhub/learnscan.mjs');
const look = await import('../../src/skillhub/learnlook.mjs');
const { scanText } = await import('../../src/skillhub/scan.mjs');
const { cleanText } = await import('../../src/work/runs.mjs');
const { redact } = await import('../../src/assistant/secrets.mjs');

const LIMIT_MS = 50;
const N = 10_000;
const fill = (u, n = N) => u.repeat(Math.ceil(n / u.length)).slice(0, n);
/**
 * The fastest of three runs of `f`, in the process's own CPU time, not on the clock: a busy computer (a whole suite on
 * a few CPUs) stretches every run on the clock several times over, while a pattern that backtracks costs CPU every time.
 */
const ms = (f) => {
  let best = Infinity;
  for (let i = 0; i < 3 && best > LIMIT_MS / 5; i++) {
    const before = process.cpuUsage();
    f();
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
};
const PLAIN = ['-a ', ' ', 'x', 'a-', 'a.', 'a@', '@', '/', '1.', 'Ab ', 'git -a ', 'git -a git ', 'ssh -v ', 'ssh -o x ', 'rm a ', 'push ', 'never ', 'р', 'aр ', '️', '1️'];
/** A pattern's own repeating units: each word and option its source names, alone and with what may follow it. */
const unitsOf = (src) => {
  const words = [...new Set((src.match(/-{0,2}[A-Za-z][A-Za-z'-]*/g) || []).filter((w) => w.length > 1))].slice(0, 60);
  return [...new Set([...PLAIN, ...words.flatMap((w) => [w, `${w} `, `${w}-`, `${w}.`, `git ${w} `, `-${w} `])])];
};
const slowOnes = (label, f, units) => units.map((u) => [ms(() => f(fill(u))), `${label} on ${N} × ${JSON.stringify(u)}`]).filter(([t]) => t > LIMIT_MS);
const none = (slow) => assert.deepEqual(slow.map(([t, what]) => `${Math.round(t)} ms: ${what}`), []);

test('a step with 40 options after git is read at once, and git with its options still counts', () => {
  const line = `1. Run git ${'-a '.repeat(40)}x.`;
  none(scan.PATTERNS.map(([rule, re]) => [ms(() => re.test(line)), rule]).filter(([t]) => t > LIMIT_MS));
  const push = scan.PATTERNS.find(([r]) => r === 'learn-push')[1];
  for (const s of ['git -C repo push', 'git -c x=1 push', 'git -c a=b -C repo push origin', 'git --no-pager push', 'git -C my-git push']) assert.ok(push.test(s), s);
  assert.ok(scan.PATTERNS.find(([r]) => r === 'learn-delete')[1].test('git -C repo clean -fdx'));
  assert.ok(scan.PATTERNS.find(([r]) => r === 'learn-throw-away')[1].test('git -C repo reset --hard'));
});

test('every pattern of the learned-skill scan takes less than 50 ms on 10,000 characters of a hostile line', () => {
  none(scan.PATTERNS.flatMap(([rule, re]) => slowOnes(rule, (l) => re.test(l), unitsOf(re.source))));
  none(slowOnes('foldLooks', scan.foldLooks, ['р', 'ú', 'Ａ', 'x', 'ս']));
});

test('every pattern of the parse, and the person check, take less than 50 ms on 10,000 characters of a hostile line', () => {
  none(Object.entries(look.PATTERNS).flatMap(([k, re]) => slowOnes(k, (l) => re.test(l), unitsOf(re.source))));
  const units = unitsOf('Priya Sharma priya_sharma PRIYA ssh user');
  none(slowOnes('peopleIn', (l) => look.peopleIn([l]), [...units, 'Ab Cd ']));
  // Thousands of capitalised pairs in a run's text, then a draft of the longest kind.
  const L = 'abcdefghijklmnopqrstuvwxyz';
  const run = Array.from({ length: 2800 }, (_, i) => `A${L[i % 26]}${L[Math.floor(i / 26) % 26]}${L[Math.floor(i / 676) % 26]}`).join(' ');
  const people = look.peopleIn([run]);
  const steps = Array.from({ length: 2 }, () => `1. ${'word '.repeat(390)}`).join('\n'); // 3,907 characters, two lines
  const t = ms(() => look.parseLook(JSON.stringify({ kind: 'new', name: 'tidy-build', description: 'Tidy the build.', steps, why: 'w', tests: ['Make a release', 'Tidy the build'] }), { people }));
  assert.ok(t < LIMIT_MS * 4, `${people.length} pairs: ${Math.round(t)} ms`);
});

test('cleaning a session\'s text (paths, the computer\'s name, secrets) takes less than 50 ms on 10,000 hostile characters', () => {
  const units = [...unitsOf('token api_key secret password credential Bearer sk-ant sk- ghp_ AKIA eyJ'), 'a-', 'a_', 'key=', '/home/alex/'];
  none(slowOnes('redact', redact, units));
  none(slowOnes('cleanText', (l) => cleanText(l, 4000, [['/home/alex', '~']]), units));
});

test('the scan reads no line longer than LINE_MAX: such a draft is refused, and every rule at that length is quick', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'learntime-'));
  try {
    const front = '---\nname: tidy-build\ndescription: Tidy the build.\n---\n\n# Tidy build\n\n';
    const longMd = `${front}1. ${'git -a '.repeat(400)}\n`;
    fs.writeFileSync(path.join(folder, 'SKILL.md'), longMd);
    const long = scan.scanDraft(folder, longMd);
    assert.equal(long.risky, true);
    assert.deepEqual(long.riskyWhy, [`a line is longer than ${scan.LINE_MAX} characters, too long to check`]);
    assert.equal(long.findings[0].line, 8);
    assert.throws(() => look.parseLook(JSON.stringify({ kind: 'new', name: 'tidy-build', description: 'Tidy the build.', steps: `1. ${'x'.repeat(scan.LINE_MAX)}`, why: 'w', tests: ['Make a release', 'Tidy the build'] })), (e) => e.rule === 'long-line');
    // At the ceiling, the whole scan (the scan of every skill too) on one line of each hostile unit.
    const units = [...PLAIN, 'curl ', 'wget.', 'iwr ', 'rm -', 'sudo ', 'base64 ', 'http://', '.env ', 'ignore ', 'send '];
    none(slowOnes('scanText', (l) => scanText('SKILL.md', l.slice(0, scan.LINE_MAX)), units));
    fs.writeFileSync(path.join(folder, 'SKILL.md'), `${front}1. ${fill('git -a ', scan.LINE_MAX - 3)}\n`);
    const t = ms(() => scan.scanDraft(folder, fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8')));
    assert.ok(t < LIMIT_MS * 4, `scanDraft at the ceiling: ${Math.round(t)} ms`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
