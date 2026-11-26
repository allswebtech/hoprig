// The looks of the dashboard at a cut go-live and a cut check (src/ship/live.mjs finishCut, src/ship/check.mjs
// closeCut) with the identity reader in the background, as the dashboard has it (of() never waits; macOS and Windows):
// the look asks the system first and waits for it, so a command past its limit IS ended, and one whose pid another
// process has now (another start) is NOT, and the step or run is closed as its record says.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';
import { asSystem, playedReader, startAs } from '../procidplay.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golive-child.mjs');
const t = tempShip('ship-background');
test.after(() => t.cleanup());
const P = await import('../../src/procid.mjs');
const { putTogether } = await import('../../src/ship/together.mjs');
const { runCheck, readChecks, verdict } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { finishCut, readJournal, readLast } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');

const idle = () => ({ over: false, why: null });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const runs = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A process of the owner's that leads its own group: what the record of a command names. */
function victim() {
  const v = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  v.unref();
  return v;
}
const gone = async (pid) => {
  for (let i = 0; i < 100 && runs(pid); i++) await sleep(20);
  return !runs(pid);
};

/** A go-live killed while its first update command ran. → { real, gitDir }. */
async function cutStep(name) {
  const real = path.join(t.projects, name);
  t.repo(real, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { update: [['node', '-e', 'setTimeout(() => {}, 1500)'], ['node', '-e', '0']], verify: [['node', '-e', '0']], back: [['node', '-e', '0']] } }) });
  t.branch(real, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');
  const r = await putTogether(real, { name: 'one', branches: ['work/menu'] });
  allow(real, 'check', readCheck(r.dir).check);
  await runCheck(real, r.dir, { busy: idle });
  allow(real, 'live', readLive(r.dir).live);
  const gitDir = await gitFolder(real);
  const child = spawn(process.execPath, [CHILD, real, r.id], { stdio: 'ignore' });
  for (let i = 0; i < 300; i++) {
    const j = readJournal(gitDir);
    if (j && j.running) break;
    await sleep(25);
  }
  child.kill('SIGKILL');
  await new Promise((res) => child.on('exit', res));
  return { real, gitDir };
}

// On a real Windows the end of a left command compares the start in its record with the system's own table
// (src/cmdtree.mjs), so a made-up start ends nothing there: the record gets the real start of the process it names,
// and macOS' whole seconds, which no real Windows process has, are not played.
const REAL_WIN = process.platform === 'win32';
const startFor = (kind, pid) => {
  if (!REAL_WIN) return startAs(kind, Date.now() - 1000);
  const real = P.startOf(P.system.of([pid]).get(pid));
  assert.ok(real > 0, 'the real start of the process the record names was read');
  return real;
};
for (const kind of REAL_WIN ? ['win32'] : ['darwin', 'win32']) {
  test(`${kind}: finishCut in the dashboard ends a cut command past its limit, and not a later holder of its pid`, async () => {
    for (const later of [false, true]) {
      const { real, gitDir } = await cutStep(`cafe-${kind}-${later ? 'later' : 'same'}`);
      const v = victim();
      try {
        const start = startFor(kind, v.pid);
        const j = readJournal(gitDir);
        j.running = { part: 'update', index: 0, pid: v.pid, proc: `T:${start}`, at: '2020-01-01T00:00:00.000Z', minutes: 1 };
        fs.writeFileSync(path.join(gitDir, 'hoprig-ship.json'), JSON.stringify(j));
        // The system says its start, or (later) another one: Windows gave the command's pid to another process.
        const { id } = playedReader(kind, new Map([[v.pid, later ? start + 120_000 : start]]));
        const done = await asSystem(P.system, id, () => finishCut(real));
        assert.equal(done.outcome, 'update-cut', done.why);
        if (later) {
          await sleep(200);
          assert.equal(runs(v.pid), true, 'a later holder of the pid is not ended');
        } else assert.equal(await gone(v.pid), true, 'the command past its limit is ended');
      } finally {
        try {
          process.kill(v.pid, 'SIGKILL');
        } catch {
          /* ended */
        }
      }
    }
    assert.deepEqual(t.trapped(), []);
  });

  test(`${kind}: a check run whose Hoprig ended is closed in the dashboard after a look that waited, its command ended`, async () => {
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((res) => dead.on('exit', res));
    for (const later of [false, true]) {
      const tree = (later ? 'b' : 'a').repeat(39) + (kind === 'win32' ? '1' : '2');
      const v = victim();
      try {
        const start = startFor(kind, v.pid);
        const at = new Date().toISOString();
        const file = path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'checks', `${tree}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ v: 1, tree, runs: [{ at, commit: tree, by: 'owner', ok: null, commands: [], ended: null, runner: { pid: dead.pid, proc: 'T:1' }, running: { pid: v.pid, proc: `T:${start}`, at, minutes: 1 } }] }));
        const { id } = playedReader(kind, new Map([[v.pid, later ? start + 120_000 : start]]));
        await asSystem(P.system, id, async () => {
          readChecks(tree);
          let rec = null;
          for (let i = 0; i < 100; i++) {
            rec = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (rec.runs[0].notCounted) break;
            await sleep(20);
          }
          assert.match(rec.runs[0].notCounted || '', /cut off/, 'closed as cut off');
          assert.equal(verdict(readChecks(tree)).state, 'none');
        });
        if (later) assert.equal(runs(v.pid), true, 'a later holder of the pid is not ended');
        else assert.equal(await gone(v.pid), true, 'the command it left is ended');
      } finally {
        try {
          process.kill(v.pid, 'SIGKILL');
        } catch {
          /* ended */
        }
      }
    }
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const writeJ = (gitDir, j) => fs.writeFileSync(path.join(gitDir, 'hoprig-ship.json'), JSON.stringify(j));

test('win32: two looks at one cut step that overlap: the one whose answer came later finds it finished and does nothing', async () => {
  const { real, gitDir } = await cutStep('overlap');
  // Cut while a command ran that has ended since: nothing to wait for, and a pid each look asks the system about.
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((res) => dead.on('exit', res));
  const j = readJournal(gitDir);
  writeJ(gitDir, { ...j, running: { part: 'update', index: 0, pid: dead.pid, proc: 'T:1', at: new Date().toISOString(), minutes: 1 } });
  // The second question waits until the test lets it through: the first look finishes the step meanwhile.
  const held = [];
  const gate = (n) => (n === 2 ? new Promise((r) => held.push(r)) : Promise.resolve());
  const { id, asked } = playedReader('win32', new Map(), { gate });
  await asSystem(P.system, id, async () => {
    const looks = [finishCut(real), finishCut(real)];
    for (let i = 0; i < 400 && !held.length; i++) await sleep(5);
    assert.equal(held.length, 1, `both looks asked (${asked.length} questions; the lock ${fs.existsSync(path.join(gitDir, 'hoprig-ship.lock'))}; ${JSON.stringify(await Promise.race([...looks, sleep(1).then(() => 'none ended')]))})`);
    const first = await Promise.race(looks);
    assert.equal(first.outcome, 'update-cut', first.why);
    const endedAt = readLast(real).endedAt;
    held[0]();
    await Promise.all(looks);
    assert.equal(readLast(real).endedAt, endedAt, 'the step was finished once');
    assert.equal(readJournal(gitDir), null, 'and stays finished');
  });
  assert.deepEqual(t.trapped(), []);
});

test('win32: a check run whose runner lives under a pid a kept answer gave to another process is not closed, nor its command ended', async () => {
  const runner = victim();
  const v = victim();
  try {
    const { id, table } = playedReader('win32', new Map([[runner.pid, Date.now() - 600_000]]), { lag: 0 });
    id.of([runner.pid]);
    await settle(); // kept: the process that had the runner's pid before
    await sleep(20);
    const rStart = Date.now();
    const cStart = rStart + 100;
    table.set(runner.pid, rStart);
    table.set(v.pid, cStart);
    const tree = 'c'.repeat(40);
    const at = new Date().toISOString();
    const file = path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'checks', `${tree}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, tree, runs: [{ at, commit: tree, by: 'owner', ok: null, commands: [], ended: null, runner: { pid: runner.pid, proc: `T:${rStart}` }, running: { pid: v.pid, proc: `T:${cStart}`, at, minutes: 1 } }] }));
    await asSystem(P.system, id, async () => {
      for (let i = 0; i < 3; i++) {
        readChecks(tree);
        await sleep(150);
      }
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runs[0].notCounted, undefined, 'the living check is not closed');
    assert.equal(runs(v.pid), true, 'its command is not ended');
  } finally {
    for (const p of [runner.pid, v.pid]) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* ended */
      }
    }
  }
});
