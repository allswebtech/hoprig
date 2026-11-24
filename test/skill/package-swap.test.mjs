// `npx hoprig-skill` swaps a new copy of the skill in with renames. A coding tool loads every folder of the skills
// folder that holds a SKILL.md, a hidden one too, so no step of a run (a run can be killed at any of them) may leave a
// second copy there; a failure puts the old copy back, and what the system says comes out in plain words.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { main } from '../../packages/hoprig-skill/bin/hoprig-skill.mjs';

let home;
let saved;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillswap-')));
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  for (const p of [home, path.join(home, '.claude'), path.join(home, '.claude', 'skills'), path.join(home, '.claude', 'skills', 'hoprig')]) {
    try {
      fs.chmodSync(p, 0o755);
    } catch { /* not there */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const skills = () => path.join(home, '.claude', 'skills');
const target = () => path.join(skills(), 'hoprig');

function run(...args) {
  const lines = [];
  const code = main(args, { out: (s) => lines.push(s), err: (s) => lines.push(s) });
  return { code, all: lines.join('\n') };
}

/** The folders of the skills folder that a coding tool would load as a skill, other than hoprig itself. */
function extraSkills() {
  if (!fs.existsSync(skills())) return [];
  return fs.readdirSync(skills()).filter((n) => n !== 'hoprig' && fs.existsSync(path.join(skills(), n, 'SKILL.md')));
}

/** Makes the copy in place look like an older one this tool wrote, so the next run replaces it. */
function makeOlder() {
  const rec = path.join(target(), '.hoprig-skill.json');
  const r = JSON.parse(fs.readFileSync(rec, 'utf8'));
  fs.writeFileSync(rec, JSON.stringify({ ...r, version: '0.0.1' }));
}

/** Calls `fn` with fs.renameSync, writeFileSync, mkdirSync and rmSync watched: `each(name, args)` runs before each call. */
function watched(each, fn) {
  const names = ['renameSync', 'writeFileSync', 'mkdirSync', 'rmSync'];
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) fs[n] = (...a) => (each(n, a), orig[n](...a));
  try {
    return fn();
  } finally {
    Object.assign(fs, orig);
  }
}

test('at no step of an install, an update or a removal is a second copy of the skill in the skills folder', () => {
  const states = [];
  const check = () => states.push(extraSkills());
  for (const step of [() => run('--claude'), () => (makeOlder(), run('--claude')), () => run('--claude', '--remove')]) {
    const r = watched(check, step);
    assert.equal(r.code, 0, r.all);
    check();
  }
  assert.ok(states.length > 10, 'every step was looked at');
  assert.deepEqual(states.filter((s) => s.length), []);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['skills'], 'no work folder is left beside it');
});

test('a run killed between the two renames leaves no copy in the skills folder; the next run cleans up after it', () => {
  assert.equal(run('--claude').code, 0);
  makeOlder();
  // What a kill right after the first rename leaves behind: the old copy moved into the run's work folder.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const work = path.join(home, '.claude', `.hoprig-skill-tmp-${dead}-0123456789ab`);
  fs.mkdirSync(path.join(work, 'new'), { recursive: true });
  fs.renameSync(target(), path.join(work, 'old'));
  fs.writeFileSync(path.join(work, 'new', 'SKILL.md'), 'half');
  assert.deepEqual(extraSkills(), []);
  // The work folder of a run that is still going is left alone.
  const live = path.join(home, '.claude', `.hoprig-skill-tmp-${process.ppid}-ba9876543210`);
  fs.mkdirSync(live);
  const r = run('--claude');
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.existsSync(path.join(target(), 'SKILL.md')));
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')).sort(), [path.basename(live), 'skills'].sort());
  // --remove cleans up the same way.
  fs.mkdirSync(path.join(work, 'old'), { recursive: true });
  assert.equal(run('--claude', '--remove').code, 0);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')).sort(), [path.basename(live), 'skills'].sort());
});

test('a failure of the second rename puts the old copy back and leaves nothing else', () => {
  assert.equal(run('--claude').code, 0);
  makeOlder();
  const before = fs.readFileSync(path.join(target(), '.hoprig-skill.json'), 'utf8');
  let renames = 0;
  const r = watched((n, a) => {
    if (n === 'renameSync' && ++renames === 2) throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY', path: a[0], dest: a[1] });
  }, () => run('--claude'));
  assert.equal(r.code, 1);
  assert.match(r.all, /Another hoprig-skill run is writing in .* right now: try again\. Nothing was changed\./);
  assert.equal(fs.readFileSync(path.join(target(), '.hoprig-skill.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['skills']);
  assert.deepEqual(fs.readdirSync(skills()), ['hoprig']);
});

test('when only removing the old copy fails, the update is done: a note, and exit 0', () => {
  assert.equal(run('--claude').code, 0);
  makeOlder();
  const r = watched((n, a) => {
    if (n === 'rmSync' && /\.hoprig-skill-tmp-/.test(String(a[0])) && fs.existsSync(path.join(String(a[0]), 'old'))) throw Object.assign(new Error('no'), { code: 'EACCES' });
  }, () => run('--claude'));
  assert.equal(r.code, 0, r.all);
  assert.match(r.all, /Updated the Hoprig skill/);
  assert.match(r.all, /could not be removed \(EACCES\)\. It is outside the skills folder/);
  assert.deepEqual(extraSkills(), []);
});

test('a link to nothing on the way is said in plain words, for an install, a dry run and a removal', () => {
  fs.symlinkSync(path.join(home, 'gone'), path.join(home, '.claude'), 'dir');
  for (const args of [['--claude'], ['--claude', '--dry-run'], ['--claude', '--remove']]) {
    const r = run(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.all, `${path.join(home, '.claude')} is a link to a folder that does not exist. Nothing was written.`);
  }
  fs.unlinkSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(path.join(home, 'gone'), skills(), 'dir');
  const r = run('--claude');
  assert.equal(r.all, `${skills()} is a link to a folder that does not exist. Nothing was written.`);
});

test('a folder it may not write in: the dry run says so, and the real run fails cleanly', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'permissions do not hold here' : false }, () => {
  assert.equal(run('--claude').code, 0);
  makeOlder();
  fs.chmodSync(target(), 0o555);
  for (const args of [['--claude', '--dry-run'], ['--claude'], ['--claude', '--remove']]) {
    const r = run(...args);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.all}`);
    assert.match(r.all, new RegExp(`Cannot write in ${target().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(no permission\\)\\. Nothing was (written|removed)\\.`));
  }
  fs.chmodSync(target(), 0o755);
  fs.chmodSync(skills(), 0o555);
  const fresh = run('--claude', '--force', '--dry-run');
  assert.equal(fresh.code, 1);
  assert.match(fresh.all, /Cannot write in .*skills \(no permission\)/);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['skills']);
});

// The folder above the skills folder may be read-only (kept so by its owner) while the skills folder is not; the work
// folder then goes inside the skills folder, where it holds no SKILL.md while files are written.
test('a read-only folder above a writable skills folder: install, update and removal work, and leave no second copy', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'permissions do not hold here' : false }, () => {
  fs.mkdirSync(skills(), { recursive: true });
  fs.chmodSync(path.join(home, '.claude'), 0o555);
  const staged = [];
  const check = (name) => {
    assert.deepEqual(extraSkills(), []);
    if (name !== 'writeFileSync') return;
    for (const n of fs.readdirSync(skills()).filter((x) => x.startsWith('.hoprig-skill-tmp-'))) {
      staged.push(...fs.readdirSync(path.join(skills(), n), { recursive: true }).filter((f) => path.basename(String(f)) === 'SKILL.md'));
    }
  };
  for (const [step, said] of [[() => run('--claude', '--dry-run'), /Would write/], [() => run('--claude'), /Added/], [() => (makeOlder(), run('--claude')), /Updated/], [() => run('--claude', '--remove'), /Removed/]]) {
    const r = watched(check, step);
    assert.equal(r.code, 0, r.all);
    assert.match(r.all, said);
  }
  assert.deepEqual(staged, [], 'no SKILL.md in a work folder while files are written');
  assert.deepEqual(fs.readdirSync(skills()), [], 'nothing left in the skills folder');
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['skills']);
});

// A failed swap tells the owner where the old copy is. The next run (the obvious retry) put a new copy in place and
// removed the work folder with the old copy in it, the owner's edits too, without a word.
test('the copy a failed swap left in its work folder is put back by the next run, never removed', () => {
  assert.equal(run('--claude').code, 0);
  fs.appendFileSync(path.join(target(), 'SKILL.md'), 'My own line.\n');
  let renames = 0;
  const failed = watched((n, a) => {
    if (n === 'renameSync' && [2, 3].includes(++renames)) throw Object.assign(new Error('io'), { code: 'EIO', path: a[0], dest: a[1] });
  }, () => run('--claude', '--force'));
  assert.equal(failed.code, 1);
  assert.match(failed.all, /nor the old one back: it is in .*old\. Move it back to .*, or run hoprig-skill again: it puts it back first\./);
  assert.ok(!fs.existsSync(target()));
  // That run has ended by the time the owner tries again: its work folder carries the id of a process that is gone.
  const kept = fs.readdirSync(path.join(home, '.claude')).find((n) => n.startsWith('.hoprig-skill-tmp-'));
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const work = path.join(home, '.claude', kept.replace(/-\d+-/, `-${dead}-`));
  fs.renameSync(path.join(home, '.claude', kept), work);
  const dry = run('--claude', '--dry-run');
  assert.match(dry.all, /left the copy that was in .* in .*old\. A run without --dry-run puts it back first\./);
  assert.ok(fs.existsSync(path.join(work, 'old', 'SKILL.md')), 'a dry run moves nothing');
  const again = run('--claude');
  assert.match(again.all, /Put back the copy that a run which stopped half-way had left in /);
  assert.equal(again.code, 1, 'the copy put back is an edited one: not replaced without --force');
  assert.match(again.all, /was edited here \(SKILL\.md\)/);
  assert.match(fs.readFileSync(path.join(target(), 'SKILL.md'), 'utf8'), /My own line\./);
  assert.ok(!fs.existsSync(work), 'the empty work folder is gone');
  assert.deepEqual(extraSkills(), []);
});

test('a file where a folder should be is said in plain words, for an install, a dry run and a removal', () => {
  fs.writeFileSync(path.join(home, '.claude'), 'not a folder');
  for (const args of [['--claude'], ['--claude', '--dry-run'], ['--claude', '--remove']]) {
    const r = run(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.all, `${path.join(home, '.claude')} is a file where a folder should be. Nothing was changed.`);
  }
  fs.mkdirSync(path.join(home, 'proj'));
  fs.writeFileSync(path.join(home, 'proj', '.claude'), '');
  const r = run('--project', path.join(home, 'proj'));
  assert.equal(r.all, `${path.join(home, 'proj', '.claude')} is a file where a folder should be. Nothing was changed.`);
});
