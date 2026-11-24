// `npx hoprig-skill`: copies the generated skill into a coding tool's skills folder, in a temporary home only. It writes
// nothing on --dry-run, keeps a record of what it wrote, never overwrites or removes an edited copy without --force,
// never follows a link out of the folder it writes to, and leaves a copy that Hoprig manages to Hoprig.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealed } from '../seal.mjs';

const PKG = fileURLToPath(new URL('../../packages/hoprig-skill/', import.meta.url));
const BIN = path.join(PKG, 'bin/hoprig-skill.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const SKILL = fs.readFileSync(path.join(PKG, 'skill/SKILL.md'), 'utf8');
const REF = fs.readFileSync(path.join(PKG, 'skill/references/commands.md'), 'utf8');

let home;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillpkg-')));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(...args) {
  const env = sealed({ PATH: process.env.PATH, HOME: home, USERPROFILE: home });
  const r = spawnSync(process.execPath, [BIN, ...args], { env, cwd: home, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

/** Every path below `dir` with its kind and content hash (links by their target): a whole-folder snapshot. */
function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    out[rel] = st.isSymbolicLink() ? `link ${fs.readlinkSync(p)}` : st.isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

const claudeSkill = () => path.join(home, '.claude', 'skills', 'hoprig');

test('--dry-run says what it would write and writes nothing (whole home unchanged)', () => {
  fs.mkdirSync(path.join(home, 'proj'));
  const before = snapshot(home);
  for (const where of [['--claude'], ['--agents'], ['--project', 'proj']]) {
    const r = run(...where, '--dry-run');
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Would write the Hoprig skill .* in .*hoprig:/);
    assert.match(r.out, /SKILL\.md \(\d+ bytes\)/);
    assert.match(r.out, /references\/commands\.md/);
    assert.match(r.out, /Dry run: nothing was written/);
  }
  assert.deepEqual(snapshot(home), before);
});

test('--claude, --agents and --project write the generated files and a record of them', () => {
  fs.mkdirSync(path.join(home, 'proj'));
  const places = { '--claude': claudeSkill(), '--agents': path.join(home, '.agents', 'skills', 'hoprig'), '--project': path.join(home, 'proj', '.claude', 'skills', 'hoprig') };
  for (const [flag, dir] of Object.entries(places)) {
    const r = run(...(flag === '--project' ? [flag, 'proj'] : [flag]));
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), SKILL);
    assert.equal(fs.readFileSync(path.join(dir, 'references/commands.md'), 'utf8'), REF);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.hoprig-skill.json'), 'utf8'));
    assert.equal(rec.version, VERSION);
    assert.equal(rec.files['SKILL.md'], crypto.createHash('sha256').update(SKILL).digest('hex'));
    assert.deepEqual(Object.keys(rec.files).sort(), ['SKILL.md', 'references/commands.md']);
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['hoprig'], 'no staging folder left behind');
  }
  // Again: nothing to do, nothing changed.
  const before = snapshot(home);
  const again = run('--claude');
  assert.equal(again.code, 0);
  assert.match(again.out, /already in/);
  assert.deepEqual(snapshot(home), before);
});

test('CLAUDE_CONFIG_DIR moves the Claude Code skills folder', () => {
  const env = sealed({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'cc') });
  const r = spawnSync(process.execPath, [BIN, '--claude'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, 'cc', 'skills', 'hoprig', 'SKILL.md')));
});

test('an edited copy is never overwritten: it says so, shows the diff, and only --force replaces it', () => {
  assert.equal(run('--claude').code, 0);
  const file = path.join(claudeSkill(), 'SKILL.md');
  fs.appendFileSync(file, '\nMy own line.\n');
  const before = snapshot(home);
  const r = run('--claude');
  assert.equal(r.code, 1);
  assert.match(r.all, /was edited here \(SKILL\.md\)/);
  assert.match(r.all, /^- My own line\.$/m);
  assert.match(r.all, /Nothing was written.*--force/);
  assert.deepEqual(snapshot(home), before);
  // A dry run of --force writes nothing either.
  assert.equal(run('--claude', '--force', '--dry-run').code, 0);
  assert.deepEqual(snapshot(home), before);
  const f = run('--claude', '--force');
  assert.equal(f.code, 0, f.all);
  assert.equal(fs.readFileSync(file, 'utf8'), SKILL);
});

test('an older copy it wrote and nobody changed is updated, with the diff shown', () => {
  assert.equal(run('--claude').code, 0);
  const dir = claudeSkill();
  const old = SKILL.replace('## Never', '## Never ever');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), old);
  const recFile = path.join(dir, '.hoprig-skill.json');
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  fs.writeFileSync(recFile, JSON.stringify({ ...rec, version: '0.0.1', files: { ...rec.files, 'SKILL.md': crypto.createHash('sha256').update(old).digest('hex') } }));
  const r = run('--claude');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^- ## Never ever$/m);
  assert.match(r.out, /^\+ ## Never$/m);
  assert.match(r.out, /Updated the Hoprig skill/);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), SKILL);
  assert.equal(JSON.parse(fs.readFileSync(recFile, 'utf8')).version, VERSION);
});

test('a folder it did not write is left alone without --force', () => {
  const dir = claudeSkill();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: hoprig\ndescription: mine\n---\nmine\n');
  const before = snapshot(home);
  const r = run('--claude');
  assert.equal(r.code, 1);
  assert.match(r.all, /did not write/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(run('--claude', '--remove').code, 1);
  assert.deepEqual(snapshot(home), before);
});

test('a link is never followed out of the folder it writes to', () => {
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  // The skill folder itself a link.
  fs.symlinkSync(outside, path.join(skills, 'hoprig'), 'dir');
  let before = snapshot(home);
  let r = run('--claude');
  assert.equal(r.code, 1);
  assert.match(r.all, /is a link: it is not followed/);
  assert.equal(run('--claude', '--remove', '--force').code, 1);
  assert.equal(run('--claude', '--force').code, 1);
  assert.deepEqual(snapshot(home), before);
  // A folder inside it a link (written by this tool, then changed).
  fs.unlinkSync(path.join(skills, 'hoprig'));
  assert.equal(run('--claude').code, 0);
  fs.rmSync(path.join(skills, 'hoprig', 'references'), { recursive: true });
  fs.symlinkSync(outside, path.join(skills, 'hoprig', 'references'), 'dir');
  before = snapshot(home);
  r = run('--claude', '--force');
  assert.equal(r.code, 1);
  assert.match(r.all, /references is a link/);
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  // A project whose .claude leads out of it.
  fs.mkdirSync(path.join(home, 'proj'));
  fs.symlinkSync(outside, path.join(home, 'proj', '.claude'), 'dir');
  before = snapshot(home);
  r = run('--project', 'proj');
  assert.equal(r.code, 1);
  assert.match(r.all, /not followed out of the project/);
  assert.deepEqual(snapshot(home), before);
});

test('--remove takes away only a copy it wrote and nobody edited; --force for the rest', () => {
  assert.equal(run('--claude').code, 0);
  const dry = run('--claude', '--remove', '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Would remove/);
  assert.ok(fs.existsSync(claudeSkill()));
  fs.writeFileSync(path.join(claudeSkill(), 'notes.md'), 'mine');
  const r = run('--claude', '--remove');
  assert.equal(r.code, 1);
  assert.match(r.all, /edited here \(notes\.md\)/);
  assert.ok(fs.existsSync(path.join(claudeSkill(), 'notes.md')));
  fs.rmSync(path.join(claudeSkill(), 'notes.md'));
  const ok = run('--claude', '--remove');
  assert.equal(ok.code, 0, ok.all);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'skills')), []);
  assert.match(run('--claude', '--remove').out, /Nothing to remove/);
});

test('a copy Hoprig manages is left to "hoprig skills update"', () => {
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'hoprig'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'hoprig', 'SKILL.md'), 'older');
  fs.writeFileSync(path.join(skills, '.hoprig-skills.json'), JSON.stringify({ version: 1, skills: { hoprig: { source: { type: 'bundled' }, files: {} } } }));
  const before = snapshot(home);
  const r = run('--claude');
  assert.equal(r.code, 1);
  assert.match(r.all, /hoprig skills update hoprig/);
  assert.deepEqual(snapshot(home), before);
});

test('a copy Hoprig manages by its record in Hoprig\'s state folder is left to "hoprig skills update" too', () => {
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'hoprig'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'hoprig', 'SKILL.md'), 'older');
  const state = path.join(home, '.local', 'state', 'hoprig');
  fs.mkdirSync(path.join(state, 'skillhub'), { recursive: true });
  fs.writeFileSync(path.join(state, 'skillhub', 'user-skills.json'), JSON.stringify({ version: 1, skills: { hoprig: { source: { type: 'bundled' }, files: {} } } }));
  const before = snapshot(home);
  const env = sealed({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, HOPRIG_STATE_DIR: state });
  const r = spawnSync(process.execPath, [BIN, '--claude'], { env, cwd: home, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /hoprig skills update hoprig/);
  assert.deepEqual(snapshot(home), before);
});

test('--print prints the skill; bad arguments print the usage', () => {
  const r = run('--print');
  assert.equal(r.code, 0);
  assert.equal(r.out, SKILL.trimEnd() + '\n');
  for (const bad of [[], ['--claude', '--agents'], ['--project'], ['--nope']]) {
    const b = run(...bad);
    assert.equal(b.code, 2, bad.join(' '));
    assert.match(b.err, /usage: npx hoprig-skill/);
  }
});
