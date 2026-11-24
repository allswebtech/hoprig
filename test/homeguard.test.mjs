// The test runner's guard for the real home (tools/home-guard.mjs): on Windows every test process has a home of its
// own, and a test that still writes into the person's profile (Hoprig's or a coding tool's folders) fails the run by
// name. Here with a made-up "real" home handed to the runner; the person's own folders are never read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changes, guardOn, realPlaces, snapshot, writtenDuring } from '../tools/home-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homeguard-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('on for Windows, elsewhere only when asked', () => {
  assert.equal(guardOn({}, 'win32'), true);
  assert.equal(guardOn({}, 'linux'), false);
  assert.equal(guardOn({ HOPRIG_TEST_HOME_GUARD: '1' }, 'darwin'), true);
});

test('the places: the profile\'s Hoprig and coding-tool folders, from USERPROFILE, APPDATA and LOCALAPPDATA', () => {
  const p = realPlaces({ USERPROFILE: 'C:\\Users\\alex', HOME: '/ignored', APPDATA: 'C:\\Users\\alex\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' });
  assert.ok(p.includes(path.join('C:\\Users\\alex', '.claude')));
  assert.ok(p.includes(path.join('C:\\Users\\alex\\AppData\\Roaming', 'hoprig')));
  assert.ok(p.includes(path.join('C:\\Users\\alex\\AppData\\Local', 'hoprig')));
  assert.ok(!p.some((x) => x.includes('ignored')), 'USERPROFILE before HOME, as Windows takes it');
});

test('made, changed and removed paths are each named; reading changes nothing', () => {
  const home = path.join(tmp, 'h1');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'a.json'), '1');
  fs.writeFileSync(path.join(home, '.claude', 'gone.json'), '1');
  const places = realPlaces({ HOME: home });
  const before = snapshot(places);
  assert.deepEqual(changes(before, snapshot(places)), []);
  fs.writeFileSync(path.join(home, '.claude', 'a.json'), '22');
  fs.rmSync(path.join(home, '.claude', 'gone.json'));
  fs.mkdirSync(path.join(home, '.config', 'hoprig'), { recursive: true });
  const c = changes(before, snapshot(places));
  assert.deepEqual(c, [`changed: ${path.join(home, '.claude', 'a.json')}`, `made: ${path.join(home, '.config', 'hoprig')}`, `removed: ${path.join(home, '.claude', 'gone.json')}`]);
});

test('a .claude with more entries than the limit leaves Hoprig\'s folders and .gitconfig whole; the file that ran is named', () => {
  const home = path.join(tmp, 'big');
  const many = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(many, { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'hoprig'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'hoprig', 'config.json'), '{}');
  // More files than one place may read (a small limit here stands in for 50,000 conversations).
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(many, `c${String(i).padStart(3, '0')}.jsonl`), 'x');
  const places = realPlaces({ HOME: home });
  assert.ok(places.indexOf(path.join(home, '.config', 'hoprig')) < places.indexOf(path.join(home, '.claude')), 'Hoprig\'s folders first');
  const before = snapshot(places, { max: 50 });
  fs.writeFileSync(path.join(home, '.config', 'hoprig', 'config.json'), '{"changed":true}');
  fs.writeFileSync(path.join(home, '.config', 'hoprig', 'new.json'), '{}');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n');
  const c = changes(before, snapshot(places, { max: 50 }));
  assert.deepEqual(c, [`changed: ${path.join(home, '.config', 'hoprig', 'config.json')}`, `made: ${path.join(home, '.config', 'hoprig', 'new.json')}`, `made: ${path.join(home, '.gitconfig')}`]);
  const now = Date.now();
  const runs = { 'test/a.test.mjs': { from: now - 60_000, to: now - 30_000 }, 'test/b.test.mjs': { from: now - 5000, to: now + 1000 } };
  assert.deepEqual(writtenDuring(path.join(home, '.gitconfig'), runs), ['test/b.test.mjs']);
});

function runner(files, extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'tools', 'test.mjs'), ...files], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
}

test('the runner: a test that writes into the real home fails the run, naming the path; one that does not passes', { timeout: 120_000 }, async () => {
  const home = path.join(tmp, 'real');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const fake = { HOME: home, USERPROFILE: home, HOPRIG_TEST_HOME_GUARD: '1', GUARD_FIXTURE_HOME: home };
  const bad = await runner([path.join('test', 'fixtures', 'runner', 'writes-home.mjs')], fake);
  assert.equal(bad.code, 1, bad.out.slice(-1500));
  assert.match(bad.out, /REAL HOME CHANGED/);
  assert.ok(bad.out.includes(`made: ${path.join(home, '.claude', 'settings.json')}  (written while ${path.join('test', 'fixtures', 'runner', 'writes-home.mjs')} ran)`), bad.out.slice(-1500));
  fs.rmSync(path.join(home, '.claude', 'settings.json'));
  const good = await runner([path.join('test', 'fixtures', 'runner', 'writes-home.mjs')], { ...fake, GUARD_FIXTURE_HOME: '' });
  assert.equal(good.code, 0, good.out.slice(-1500));
  assert.doesNotMatch(good.out, /REAL HOME CHANGED/);
});
