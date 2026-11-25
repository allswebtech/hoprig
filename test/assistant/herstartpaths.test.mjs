// Every path on which the dashboard starts a session of Tia's should do BOTH halves of her safety through the ONE
// function, startAsHers (src/assistant/hersignin.mjs): it MARKS the run hers (the mark src/hook.mjs reads to hold her
// administrator commands below Full as the owner's card) and SIGNS the session in with the token the owner
// chose in place of his own (herSignedEnv). A path that does only one half, or neither, is the mistake
// this test guards against. Held three ways:
//   1. every ROUTED start path (below) must call startAsHers;
//   2. markHers (hermark.mjs) and herSignedEnv have NO caller in src but startAsHers, so a path cannot do one half by
//      hand — it must go through the one function;
//   3. every known start site of a hers session is recorded below, so a new one cannot slip in unseen.
//
// The named start paths (git-checked 20 Nov 2026), each handled here so none is forgotten:
//   - chat/run.mjs open(): a chat started with byTia (Tia's own start_chat, or a chat opened for her). The session is
//     hooked, so the mark drives the hold. ROUTED: it calls startAsHers(hold.file, env, …).
//   - work/alone.mjs begun(): Work's own door, which starts a mission's run (by:'mission', mission/engine.mjs) and a
//     look (by:'look', operator/look.mjs) — hers(job), HERS = ['mission','look']. ROUTED: begun() runs a hers job's
//     session env through startAsHers (both halves) and calls endAsHers when it ends. The session is restricted and
//     hookless, so the mark cannot be reached from inside it; the sign-in reaches its env in place of his, and his
//     git tokens are taken out when the chosen file cannot be read (never a silent fall back to his full rights).
//   - launch.mjs: the terminal launcher. The SAME program runs his own `hoprig` and a terminal session she starts
//     through her door (start_session), so it is hers on the second path: runOnce calls startAsHers when the launch
//     file the dashboard wrote says the session is hers (launchfile.mjs takeHers). His own starts write no such file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// Every site at which the dashboard starts a session AS TIA'S, as data: each does both halves through startAsHers.
const HER_START_PATHS = [
  { file: 'chat/run.mjs', why: 'a chat Tia starts (byTia): her own start_chat, or a chat opened for her — chat/run.mjs open()' },
  { file: 'work/alone.mjs', why: "Work's own door for a mission's run (by:'mission') and a look (by:'look') — begun() routes hers(j) through startAsHers" },
  { file: 'launch.mjs', why: 'a terminal session she starts (start_session through her door): the launch file says hers, runOnce calls startAsHers' },
  { file: 'codetools/terminal.mjs', why: 'a Codex or OpenCode terminal she starts: the launch file says hers, toolEnv calls startAsHers' },
];

// Named start paths that inspection shows are NOT started as hers: each carries a `guard` that must NOT appear in the
// file today, so the day a hers-start (startAsHers) is wired there the test trips and the path is re-weighed, not
// silently left half-wired.
const NOT_HERS = [];

// Every .mjs file under src, by its path relative to src (POSIX separators).
function allSources(dir = SRC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allSources(full));
    else if (e.name.endsWith('.mjs')) out.push(path.relative(SRC, full).split(path.sep).join('/'));
  }
  return out;
}

test('every hers-start path goes through startAsHers', () => {
  assert.ok(HER_START_PATHS.length > 0, 'at least one hers-start path must be routed through startAsHers');
  for (const p of HER_START_PATHS) {
    assert.match(read(p.file), /\bstartAsHers\s*\(/, `${p.file} (${p.why}) must start the session through startAsHers`);
  }
});

test('markHers and herSignedEnv have no caller in src but startAsHers: a new path cannot do one half by hand', () => {
  const entry = 'assistant/hersignin.mjs'; // where startAsHers joins the two halves (and defines herSignedEnv)
  const def = 'hermark.mjs'; // where markHers is defined
  // The demo's made-up history writes records of sessions that never ran, one of them Tia's: it marks that record so
  // the history shows whose it was. It starts no process (its only program is git, for the made-up commits).
  const demo = 'demo/history.mjs';
  assert.ok(!/\bstartAsHers\b|\bspawn\w*\s*\(/.test(read(demo)), 'the demo history starts nothing');
  assert.deepEqual(read(demo).match(/\bexecFile\w*\(\s*'[^']*'/g), ["execFileSync('git'"], 'git is its only program');
  for (const rel of allSources()) {
    if (rel === entry || rel === def) continue;
    const src = read(rel);
    assert.ok(rel === demo || !/\bmarkHers\s*\(/.test(src), `${rel} calls markHers by hand: start the session through startAsHers instead`);
    assert.ok(!/\bherSignedEnv\s*\(/.test(src), `${rel} calls herSignedEnv by hand: start the session through startAsHers instead`);
  }
});

test('a named path that is not started as hers stays free of startAsHers, so wiring Tia there trips this test', () => {
  for (const p of NOT_HERS) {
    assert.doesNotMatch(
      read(p.file),
      p.guard,
      `${p.file} now calls startAsHers (${p.why}): if it really starts a session as hers, move it to HER_START_PATHS; if not, do not mark it hers`,
    );
  }
});
