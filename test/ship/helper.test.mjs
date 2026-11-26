// The helper of a go-live whose update restarts the dashboard (src/ship/helper.mjs): when the dashboard that ran the
// step is gone and nobody claims the step within the wait, it runs the confirmed "back" and writes the outcome. A step
// a dashboard has claimed is left alone (never both), and a journal whose block is not the confirmed one runs nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ship', 'helper.mjs');
const t = tempShip('ship-helper');
test.after(() => t.cleanup());
const { allow } = await import('../../src/ship/allow.mjs');
const { cleanLive } = await import('../../src/ship/project.mjs');
const { readLast, journalPath, claimStep, claimHeld } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');
const shop = path.join(t.projects, 'shop');
t.repo(shop);
const gitDir = await gitFolder(shop);
const head = t.git(shop, 'rev-parse', 'HEAD'); // the commits a journal names are in its repository
const marker = path.join(t.root, 'back-ran');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const live = cleanLive({
  update: [{ run: ['node', '-e', '0'], minutes: 1 }],
  verify: [{ url: 'http://127.0.0.1:9/', seconds: 1 }],
  back: [{ run: ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'back\\n')`], minutes: 1 }],
  restarts: 'hoprig',
  waitSeconds: 5,
}).live;
const hex = (c) => c.repeat(40);
const { system } = await import('../../src/procid.mjs');
// A process that is gone, with its identity read while it ran (pid plus start), as a dashboard's claim carries it: a
// pid alone says nothing once the system has given it to another process, which Windows does at once.
const [deadPid, deadProc] = await new Promise((res) => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  c.once('spawn', () => {
    const proc = system.of([c.pid]).get(c.pid);
    c.on('exit', () => res([c.pid, proc]));
    c.kill();
  });
});
assert.ok(deadProc, 'this system tells when a process of this test started');

/** A journal of a step cut in its update, its dashboard gone. */
function journal(id, block = live, extra = {}) {
  const j = { v: 1, id, real: shop, top: shop, name: 'self', owner: deadPid, restarts: true, live: block, part: 'update', updateAt: new Date().toISOString(), parts: [], pictures: {}, values: { commit: head, tree: hex('b'), before: head, branch: 'work/self-all' }, ...extra };
  fs.writeFileSync(journalPath(gitDir), JSON.stringify(j));
  return j;
}
const runHelper = () => new Promise((res) => spawn(process.execPath, [HELPER, gitDir], { stdio: 'ignore' }).on('exit', res));
/** What the helper said when it ended without taking a step back (the state folder's ship/helper.log). */
const helperSaid = () => {
  try {
    return fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'helper.log'), 'utf8').trim().split('\n').slice(-3).join(' | ');
  } catch {
    return 'nothing';
  }
};
const backs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('nobody claims the step within the wait: the helper takes it back', async () => {
  allow(shop, 'live', live);
  journal('1111111111111111');
  const t0 = Date.now();
  await runHelper();
  assert.ok(Date.now() - t0 >= 4500, 'it waited');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\n');
  const last = readLast(shop);
  assert.equal(last.outcome, 'taken-back');
  assert.match(last.why, /helper/);
  assert.equal(fs.existsSync(journalPath(gitDir)), false);
});

test('a step a dashboard claimed is left alone', async () => {
  journal('2222222222222222');
  claimStep(gitDir, '2222222222222222', 'dashboard');
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\n', 'back did not run again');
  fs.rmSync(journalPath(gitDir));
});

test('a journal with another back than the confirmed one runs nothing', async () => {
  const other = { ...live, back: [{ run: ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'other\\n')`], minutes: 1 }] };
  journal('3333333333333333', other);
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\n');
  fs.rmSync(journalPath(gitDir), { force: true });
  assert.deepEqual(t.trapped(), []);
});

test('a claim left by a dashboard that is gone holds nothing: the helper still takes it back', async () => {
  journal('4444444444444444');
  // The dashboard that ran the step claimed it after its update, then the restart ended it.
  fs.writeFileSync(path.join(gitDir, 'hoprig-ship-4444444444444444.claim'), JSON.stringify({ who: 'dashboard', pid: deadPid, proc: deadProc, at: new Date().toISOString() }));
  assert.equal(claimHeld(gitDir, '4444444444444444'), false);
  // Windows gives a pid to another process at once: the claim's identity tells that process from its writer. The living
  // process is one of this test's own (whose identity it may read), never the runner that started it.
  const living = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await new Promise((res) => living.once('spawn', res));
    assert.ok(system.of([living.pid]).get(living.pid), 'this system tells when a process of this test started');
    const reused = path.join(gitDir, 'hoprig-ship-4545454545454545.claim');
    fs.writeFileSync(reused, JSON.stringify({ who: 'dashboard', pid: living.pid, proc: deadProc, at: new Date().toISOString() }));
    assert.equal(claimHeld(gitDir, '4545454545454545'), false, 'a living process that has its pid now holds nothing of it');
    fs.writeFileSync(reused, JSON.stringify({ who: 'dashboard', pid: living.pid, at: new Date().toISOString() }));
    assert.equal(claimHeld(gitDir, '4545454545454545'), true, 'a claim without its identity cannot be told from that process: it holds');
    fs.rmSync(reused);
  } finally {
    living.kill();
  }
  // Gone before the helper starts: Windows may have given it the pid of the gone dashboard, and a process that is just
  // ending is seen alive while its identity can no longer be read ("not known" holds the claim).
  await new Promise((res) => (living.exitCode !== null || living.signalCode !== null ? res() : living.once('exit', res)));
  const h0 = Date.now();
  await runHelper();
  const ran = fs.readFileSync(marker, 'utf8');
  if (ran !== 'back\nback\n') {
    // What the helper met: it waits 5 s (the wait) before it claims; one that ended sooner found the claim held.
    // Asked fresh (not a kept answer from when the test read it while it ran): what the system says of that pid now.
    const now = system.of([deadPid], { after: Date.now() }).get(deadPid);
    assert.fail(`back did not run: the helper ended after ${Date.now() - h0} ms; the claim ${fs.existsSync(path.join(gitDir, 'hoprig-ship-4444444444444444.claim')) ? fs.readFileSync(path.join(gitDir, 'hoprig-ship-4444444444444444.claim'), 'utf8').trim() : 'is gone'}; held now ${claimHeld(gitDir, '4444444444444444')}; the gone dashboard pid ${deadPid} alive ${alive(deadPid)}, identity now ${now} (it had ${deadProc}); the living stand-in had pid ${living.pid}; break file ${fs.existsSync(path.join(gitDir, 'hoprig-ship-4444444444444444.claim.break'))}; the helper said: ${helperSaid()}`);
  }
  assert.equal(readLast(shop).outcome, 'taken-back');
});

test('a claim that cannot be told does not end the helper: it is looked at again, taken once its process is gone, and said when it is not', async () => {
  // A living process whose identity cannot be compared with the claim's (another kind here): "not known", as on Windows
  // a pid handed to a process that is ending just then, whose start can no longer be read.
  const other = process.platform === 'linux' ? 'T:1' : 'L:x:1';
  for (const ends of [true, false]) {
    const id = ends ? '4646464646464646' : '4747474747474747';
    journal(id);
    const living = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((res) => living.once('spawn', res));
      fs.writeFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), JSON.stringify({ who: 'dashboard', pid: living.pid, proc: other, at: new Date().toISOString() }));
      assert.equal(claimHeld(gitDir, id), true, 'not known holds the claim');
      const before = backs();
      const h0 = Date.now();
      const helper = runHelper();
      if (ends) {
        await sleep(1500);
        living.kill();
      }
      await helper;
      if (ends) assert.equal(backs(), before + 1, `taken back once the claim's process was gone (the helper said: ${helperSaid()})`);
      else {
        assert.equal(backs(), before, 'never taken while the claim cannot be told');
        assert.ok(Date.now() - h0 >= 4500, 'the helper waited its time: not known did not end it');
        assert.match(helperSaid(), new RegExp(`${id}: it was not taken: the claim unknown \\(pid ${living.pid}, alive true, its identity ${other}`));
        fs.rmSync(path.join(gitDir, `hoprig-ship-${id}.claim`), { force: true });
        fs.rmSync(journalPath(gitDir), { force: true });
      }
    } finally {
      living.kill();
    }
  }
});

test('two takers of a claim of a process that is gone: exactly one gets it', () => {
  const id = '5555555555555555';
  fs.writeFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), JSON.stringify({ who: 'dashboard', pid: deadPid, proc: deadProc }));
  assert.equal(claimStep(gitDir, id, 'dashboard'), true);
  // Another living process holds it now (a stand-in identity that is never "gone"): a second taker is refused.
  const other = { self: () => 'L:x:1', of: (pids) => new Map(pids.map((p) => [p, 'L:x:2'])), bootAt: () => 0 };
  const c = JSON.parse(fs.readFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), 'utf8'));
  fs.writeFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), JSON.stringify({ ...c, pid: process.ppid, proc: null }));
  assert.equal(claimStep(gitDir, id, 'helper', { ident: other }), false);
  fs.rmSync(path.join(gitDir, `hoprig-ship-${id}.claim`));
});

test('on Windows a gone claim a reader holds open is removed, never moved, and then taken', () => {
  const id = '5656565656565656';
  const file = path.join(gitDir, `hoprig-ship-${id}.claim`);
  fs.writeFileSync(file, JSON.stringify({ who: 'dashboard', pid: deadPid, proc: deadProc }));
  // Windows' answers, as measured on a real runner: a file another handle reads can never be moved (EPERM every time),
  // and its removal answers EPERM now and then while another program touches it (here three times).
  const rename = (a) => {
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${a}'`), { code: 'EPERM' });
  };
  let touched = 0;
  const remove = (f) => {
    if (f === file && touched < 3) {
      touched += 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${f}'`), { code: 'EPERM' });
    }
    fs.unlinkSync(f);
  };
  assert.equal(claimStep(gitDir, id, 'dashboard', { platform: 'win32', rename, remove }), true, 'taken: removed once it was let go, never moved');
  assert.equal(touched, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'the claim is this one now');
  assert.equal(fs.existsSync(`${file}.break`), false, 'its break file is gone');
  fs.rmSync(file);
});

test('a break file another taker holds: the claim is not removed under it; a stale break is cleared and the claim taken', () => {
  const id = '5757575757575757';
  const file = path.join(gitDir, `hoprig-ship-${id}.claim`);
  fs.writeFileSync(file, JSON.stringify({ who: 'dashboard', pid: deadPid, proc: deadProc }));
  fs.writeFileSync(`${file}.break`, '1\n'); // another taker is in the middle of its own round
  let clock = Date.now();
  assert.equal(claimStep(gitDir, id, 'helper', { platform: 'linux', now: () => (clock += 100) }), false, 'not taken while another taker breaks it');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, deadPid, 'the claim it judged gone was not removed under another break');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.break`, old, old); // that taker ended in the middle, long ago
  assert.equal(claimStep(gitDir, id, 'helper', { platform: 'linux' }), true);
  assert.equal(fs.existsSync(`${file}.break`), false);
  fs.rmSync(file);
});

test('a kept identity from before its pid was handed on never makes another process the claimant, nor the command', async () => {
  const { commandRuns } = await import('../../src/ship/runcmd.mjs');
  // The system kept the claimant's start from while it ran; asked now, the process with that pid began a minute later.
  const asked = [];
  const ident = { self: () => 'T:9', bootAt: () => 0, of: (pids, o = {}) => (asked.push(o.after), new Map(pids.map((p) => [p, o.after ? 'T:1700000060000' : 'T:1700000000000']))) };
  const id = '5858585858585858';
  const file = path.join(gitDir, `hoprig-ship-${id}.claim`);
  fs.writeFileSync(file, JSON.stringify({ who: 'dashboard', pid: process.pid, proc: 'T:1700000000000' })); // a pid that lives
  assert.equal(claimHeld(gitDir, id, { ident }), false, 'the process with that pid now is not the claimant');
  assert.ok(asked.length && asked.every((a) => a), 'only fresh answers were asked for');
  fs.rmSync(file);
  assert.equal(commandRuns({ pid: process.pid, proc: 'T:1700000000000', at: new Date().toISOString(), minutes: 1 }, ident), false, 'nor the command a look would end');
});

test('a journal that names another project, or a commit not in the repository, runs nothing', async () => {
  // Another project with a confirmed live block of its own: a journal put into shop's git folder must not run its back.
  const cafe = path.join(t.projects, 'cafe');
  t.repo(cafe);
  const cafeMark = path.join(t.root, 'cafe-back-ran');
  const cafeLive = { ...live, back: [{ run: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(cafeMark)}, '1')`], minutes: 1 }] };
  allow(cafe, 'live', cafeLive);
  const cafeHead = t.git(cafe, 'rev-parse', 'HEAD');
  journal('6666666666666666', cafeLive, { real: cafe, top: cafe, values: { commit: cafeHead, tree: hex('b'), before: cafeHead, branch: 'work/self-all' } });
  await runHelper();
  assert.equal(fs.existsSync(cafeMark), false, "cafe's back did not run");
  fs.rmSync(journalPath(gitDir), { force: true });
  // Shop's own confirmed back, with a commit id that is not in shop's repository.
  const before = fs.readFileSync(marker, 'utf8');
  journal('7777777777777777', live, { values: { commit: head, tree: hex('b'), before: hex('c'), branch: 'work/self-all' } });
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'back did not run');
  fs.rmSync(journalPath(gitDir), { force: true });
  assert.deepEqual(t.trapped(), []);
});
