// The lock of `hoprig get` lives in Hoprig's own state folder, never in the folder a project is cloned into: in a
// held folder of a group's repository a lock file there was an untracked change of that repository, and one left by a
// killed run stayed one. The temporary clone is the only thing of Hoprig's own in a place's folder, and the group's
// ignore lines cover it. A member that comes with its group's repository takes the lock as every other get does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeWorld, quietUi } from './dryrun-fixture.mjs';

const src = (rel) => fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));
const { getMain, getProject } = await import('../../src/pcsetup/getproject.mjs');
const { findLocks, lockPathFor } = await import('../../src/pcsetup/leftovers.mjs');
const { stream } = await import('../../src/setup/system.mjs');
const ws = await import('../../src/workspace/cli.mjs');

const statusJson = async () => {
  const out = [];
  await ws.main(['status', '--json'], { ui: await quietUi(), write: (s) => out.push(s) });
  return JSON.parse(out.join(''));
};

test('a get into a held folder of a group\'s repository: git status there shows nothing while it runs and after a killed run; the lock is in the state folder', async (tc) => {
  const w = await makeWorld('lockgroup', { groups: true });
  tc.after(() => w.cleanup());
  w.use();
  const { kits, builds } = w.groups;
  const state = process.env.HOPRIG_STATE_DIR;
  const gitStatus = () => w.sh(kits, 'status', '--porcelain', '--untracked-files=all');
  assert.equal(gitStatus(), '', 'before');
  const widget = { url: 'https://github.com/alex/widget-workspace.git' };
  const lock = lockPathFor(builds, widget);
  assert.ok(lock.startsWith(path.join(state, 'get-locks') + path.sep), lock);

  // While the clone runs: the lock is held, in the state folder; nothing in the group's repository shows.
  const seen = [];
  const runner = async (argv, o) => {
    if (argv.includes('clone')) seen.push({ status: gitStatus(), lock: fs.existsSync(lock), inBuilds: fs.readdirSync(builds) });
    return stream(argv, o);
  };
  const q = await quietUi();
  const code = await getMain(['kits/builds/widget'], { ui: q, write: () => {}, runner });
  assert.equal(code, 0, q.text());
  assert.equal(seen.length, 1, q.text());
  assert.equal(seen[0].status, '', `git status in the group while the get ran:\n${seen[0].status}`);
  assert.equal(seen[0].lock, true, 'the lock is held in the state folder');
  assert.ok(seen[0].inBuilds.every((n) => !n.endsWith('.lock')), `no lock file in the held folder: ${seen[0].inBuilds}`);
  assert.equal(gitStatus(), '', 'after');
  assert.ok(!fs.existsSync(lock), 'released');
  assert.ok(!fs.existsSync(path.dirname(lock)), 'the place\'s folder of locks went with its last lock');

  // A run killed while it clones: its lock stays in the state folder, its temporary clone in the held folder, which
  // the group ignores. workspace status lists the lock; the next get takes it over and finishes.
  fs.rmSync(path.join(builds, 'widget'), { recursive: true, force: true });
  const child = path.join(w.root, 'child.mjs');
  fs.writeFileSync(child, `
const { getMain } = await import(${JSON.stringify(src('pcsetup/getproject.mjs'))});
const { stream } = await import(${JSON.stringify(src('setup/system.mjs'))});
const { makeUi } = await import(${JSON.stringify(src('setup/ui.mjs'))});
const ui = makeUi({ interactive: false, write: () => {} });
await getMain(['kits/builds/widget'], { ui, write: () => {}, runner: async (argv, o) => {
  const r = await stream(argv, o);
  if (argv.includes('clone')) { process.stdout.write('cloned\\n'); await new Promise(() => {}); }
  return r;
} });
`);
  const p = spawn(process.execPath, [child], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    p.stdout.on('data', (d) => String(d).includes('cloned') && res());
    p.once('exit', (c) => rej(new Error(`the child ended before its clone: ${c}`)));
  });
  assert.ok(fs.existsSync(lock), 'the child holds the lock');
  p.kill('SIGKILL');
  await new Promise((res) => (p.exitCode !== null || p.signalCode ? res() : p.once('exit', res)));
  assert.equal(gitStatus(), '', 'after a killed run');
  assert.ok(fs.readdirSync(builds).some((n) => n.startsWith('.hoprig-clone-widget-workspace-')), 'its temporary clone is left in the held folder');
  assert.deepEqual(findLocks(builds).map((l) => [l.path, l.running]), [[lock, false]]);
  assert.deepEqual((await statusJson()).locks.filter((l) => l.path === lock).map((l) => l.running), [false]);
  const again = await quietUi();
  assert.equal(await getMain(['kits/builds/widget'], { ui: again, write: () => {} }), 0, again.text());
  assert.ok(fs.existsSync(path.join(builds, 'widget', '.git')));
  assert.ok(!fs.existsSync(lock));
  assert.equal(gitStatus(), '');
});

test('a lock is keyed by the place\'s real path: the same folder through a link is one lock; a lock an older Hoprig left in the folder is removed once its run has ended', async (tc) => {
  const w = await makeWorld('lockreal');
  tc.after(() => w.cleanup());
  w.use();
  const r = { url: 'https://github.com/alex/blog-workspace.git' };
  const alias = path.join(w.root, 'alias');
  fs.symlinkSync(w.projects, alias);
  assert.equal(lockPathFor(alias, r), lockPathFor(w.projects, r));
  assert.notEqual(lockPathFor(w.projects, r), lockPathFor(w.projects, { url: 'https://github.com/alex/shop-workspace.git' }));
  // An older Hoprig's lock of a run that ended, in the projects folder itself.
  const { createHash } = await import('node:crypto');
  const { urlKey } = await import('../../src/workspace/map.mjs');
  const legacy = path.join(w.projects, `.hoprig-clone-${createHash('sha256').update(urlKey(r.url)).digest('hex').slice(0, 8)}.lock`);
  fs.writeFileSync(legacy, `${JSON.stringify({ pid: 2147483000, proc: 'gone' })}\n`);
  assert.ok(findLocks(w.projects).some((l) => l.path === legacy && !l.running), 'status lists it');
  const q = await quietUi();
  assert.equal(await getMain(['blog'], { ui: q, write: () => {} }), 0, q.text());
  assert.ok(!fs.existsSync(legacy), 'removed');
  assert.deepEqual(fs.readdirSync(w.projects).filter((n) => n.endsWith('.lock')), []);
});

test('a member that comes with its group\'s repository takes the lock: two gets of it at once, the second is busy', async (tc) => {
  const w = await makeWorld('lockmember', { groups: true });
  tc.after(() => w.cleanup());
  w.use();
  const { readMap } = await import('../../src/workspace/map.mjs');
  const map = readMap(w.ws).map;
  const one = async () => {
    const q = await quietUi();
    return getProject('kits/packs/tool', { ui: q, map, dir: w.projects });
  };
  const [a, b] = await Promise.all([one(), one()]);
  const results = [a.result, b.result].sort();
  assert.deepEqual(results, ['busy', 'here'], `${a.message || ''} | ${b.message || ''}`);
  const busy = a.result === 'busy' ? a : b;
  assert.match(busy.message, /^kits\/packs\/tool is being fetched by another run of Hoprig right now \(process \d+\)/);
  assert.ok(fs.existsSync(path.join(w.groups.tool, 'code', 'tool-core', '.git')));
  assert.ok(!fs.existsSync(lockPathFor(path.join(w.groups.kits, 'packs'), { member: 'kits/packs/tool' })), 'released');
  assert.equal(w.sh(w.groups.kits, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('the folder of a place\'s locks stays while another run holds a lock there, and goes with the last one', async (tc) => {
  const w = await makeWorld('lockdir');
  tc.after(() => w.cleanup());
  w.use();
  const { takeLock } = await import('../../src/pcsetup/leftovers.mjs');
  const a = { url: 'https://github.com/alex/one.git', repo: 'one' };
  const b = { url: 'https://github.com/alex/two.git', repo: 'two' };
  const place = path.join(w.ws, 'fresh'); // the world's projects folder has stale locks of its own
  const la = takeLock(place, a);
  const lb = takeLock(place, b);
  const folder = path.dirname(lockPathFor(place, a));
  la.release();
  assert.ok(fs.existsSync(lockPathFor(place, b)), 'the other run\'s lock stays');
  lb.release();
  assert.ok(!fs.existsSync(folder), 'empty: removed');
});

test('at an older lock\'s name: a file that is no lock is never removed; an older lock without a process identity is stale at once', async (tc) => {
  const w = await makeWorld('lockolder');
  tc.after(() => w.cleanup());
  w.use();
  const { takeLock } = await import('../../src/pcsetup/leftovers.mjs');
  const { createHash } = await import('node:crypto');
  const { urlKey } = await import('../../src/workspace/map.mjs');
  const place = path.join(w.ws, 'place');
  fs.mkdirSync(place);
  const r = { url: 'https://github.com/alex/one.git', repo: 'one' };
  const legacy = path.join(place, `.hoprig-clone-${createHash('sha256').update(urlKey(r.url)).digest('hex').slice(0, 8)}.lock`);
  // Someone's own file (a tracked file of a held folder, say): left where it is, named, and the get goes on.
  fs.writeFileSync(legacy, 'notes of mine\n');
  const q = await quietUi();
  const a = takeLock(place, r, { ui: q });
  assert.ok(a.release, 'not busy');
  a.release();
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'notes of mine\n');
  assert.match(q.text(), /has the name of an older Hoprig's lock but is no lock: left where it is/);
  assert.ok(!findLocks(place).some((l) => l.path === legacy), 'status does not call it a lock');
  // An older lock of process 1 (alive, never a hoprig get), without an identity, written just now: stale at once.
  fs.writeFileSync(legacy, '{"pid":1}\n');
  const b = takeLock(place, r);
  assert.ok(b.release, 'not busy for six hours');
  b.release();
  assert.ok(!fs.existsSync(legacy), 'an older lock whose run is not shown to go on is removed');
});

test('a place that leads out through a link: the lock and the leftover acts check it again, nothing outside is removed or moved', async (tc) => {
  const w = await makeWorld('lockout');
  tc.after(() => w.cleanup());
  w.use();
  const { takeLock, tempNameFor, useLeftover } = await import('../../src/pcsetup/leftovers.mjs');
  const r = { url: 'https://github.com/alex/blog-workspace.git', repo: 'blog-workspace' };
  // The place is a link to a folder outside the projects folder; there sit an older lock of a run that ended and a
  // file at the clone's temporary name.
  const out = path.join(w.root, 'OUT');
  fs.mkdirSync(out);
  const place = path.join(w.projects, 'kits');
  fs.symlinkSync(out, place);
  const { createHash } = await import('node:crypto');
  const { urlKey } = await import('../../src/workspace/map.mjs');
  const legacy = path.join(out, `.hoprig-clone-${createHash('sha256').update(urlKey(r.url)).digest('hex').slice(0, 8)}.lock`);
  fs.writeFileSync(legacy, `${JSON.stringify({ pid: 2147483000, proc: 'gone' })}\n`);
  fs.writeFileSync(path.join(out, tempNameFor(r)), 'mine\n');
  const at = { projects: w.projects };
  const lock = takeLock(place, r, { at });
  lock.release();
  assert.ok(fs.existsSync(legacy), 'the file outside is not removed');
  const q = await quietUi();
  await assert.rejects(useLeftover(place, r, tempNameFor(r), { ui: q, run: undefined, at }), /leaves its folder through a link/);
  assert.deepEqual(fs.readdirSync(out).sort(), [path.basename(legacy), tempNameFor(r)].sort(), 'nothing outside was moved');
});
