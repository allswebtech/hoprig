// In the dashboard the identity reader never waits for the system (src/procid.mjs askInBackground), and a judge that
// asks for a fresh identity (freshAfter) still decides: a judge that cannot wait takes a kept answer from after its
// record's start while it asks, and its next look has the answer it asked for; a look that can wait asks first and
// hands on the moment it asked. Played with the answers of macOS and Windows: a kept answer "the same start", and a
// system that now gives another start (the writer ended and its pid was handed to another process).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { playedReader, settle, startAs, asSystem } from './procidplay.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'procid-background-'));
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P = await import('../src/procid.mjs');
const LIVE = process.ppid; // a pid that runs: the system gave the dead writer's number to it
const KINDS = ['darwin', 'win32'];

/** A reader that keeps "the same start" for LIVE, then a system that says another one. → { id, then (the record's identity) }. */
async function keptSame(kind) {
  const then = startAs(kind, Date.now() - 600_000);
  const { id, table, asked } = playedReader(kind, new Map([[LIVE, then]]));
  id.of([LIVE]);
  await settle();
  assert.equal(id.of([LIVE]).get(LIVE), `T:${then}`, 'kept: the same start');
  table.set(LIVE, startAs(kind, Date.now() - 60_000));
  return { id, then: `T:${then}`, asked };
}
/** One look, the answer it asked for, the next look: → what the next look said. */
async function twoLooks(judge) {
  judge();
  await settle();
  return judge();
}

for (const kind of KINDS) {
  test(`${kind}: the judges that cannot wait decide at the next look`, async () => {
    const S = await import('../src/ship/lock.mjs');
    let { id, then } = await keptSame(kind);
    const sd = fs.mkdtempSync(path.join(tmp, 'ship-'));
    fs.writeFileSync(path.join(sd, S.LOCK_NAME), JSON.stringify({ pid: LIVE, proc: then, what: 'go live', at: new Date().toISOString() }));
    assert.equal((await twoLooks(() => S.lockHolder(sd, { ident: id }))).gone, true, 'the go-live lock');

    const L = await import('../src/ship/live.mjs');
    ({ id, then } = await keptSame(kind));
    const gd = fs.mkdtempSync(path.join(tmp, 'git-'));
    fs.writeFileSync(path.join(gd, 'hoprig-ship-0123456789abcdef.claim'), JSON.stringify({ who: 'dashboard', pid: LIVE, proc: then, at: new Date().toISOString() }));
    assert.equal(await twoLooks(() => L.claimHeld(gd, '0123456789abcdef', { ident: id })), false, 'the claim of a step');

    const R = await import('../src/ship/runcmd.mjs');
    ({ id, then } = await keptSame(kind));
    assert.equal(await twoLooks(() => R.commandRuns({ pid: LIVE, proc: then, at: new Date().toISOString(), minutes: 1 }, id)), false, 'a command of a step');

    const I = await import('../src/assistant/improvefeature.mjs');
    ({ id, then } = await keptSame(kind));
    const lock = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: LIVE, proc: then, id: 'old' }));
    assert.equal(await twoLooks(() => I.takeLock(`r-${kind}`, { ident: id })), true, 'the improvement round: taken over');
    fs.rmSync(lock);

    const G = await import('../src/pcsetup/leftovers.mjs');
    ({ id, then } = await keptSame(kind));
    assert.equal((await twoLooks(() => G.lockOwner(JSON.stringify({ pid: LIVE, proc: then }), Date.now(), { ident: id }))).running, false, 'the get lock');

    ({ id, then } = await keptSame(kind));
    const D = await import('../src/server/dashboardfile.mjs');
    fs.mkdirSync(path.dirname(D.dashboardFile()), { recursive: true });
    fs.writeFileSync(D.dashboardFile(), JSON.stringify({ pid: LIVE, proc: then, host: '127.0.0.1', port: 7979, at: Date.now() }));
    assert.equal(await asSystem(P.system, id, () => twoLooks(() => D.runningDashboard())), null, 'the dashboard file');

    ({ id, then } = await keptSame(kind));
    const H = await import('../src/codetools/servers.mjs');
    fs.mkdirSync(H.serverDir(), { recursive: true });
    fs.writeFileSync(path.join(H.serverDir(), `opencode-held-${LIVE}`), JSON.stringify({ pid: LIVE, proc: then }));
    assert.deepEqual(await asSystem(P.system, id, () => twoLooks(() => H.serverUsers('opencode', { runs: [] }))), [], 'the holds of a coding tool server');
  });

  test(`${kind}: a look that can wait decides in one look; ending a command never goes on a kept answer`, async () => {
    const H = await import('../src/codetools/holds.mjs');
    const S = await import('../src/codetools/servers.mjs');
    let { id, then } = await keptSame(kind);
    fs.mkdirSync(S.serverDir(), { recursive: true });
    fs.writeFileSync(path.join(S.serverDir(), `codex-held-${LIVE}`), JSON.stringify({ pid: LIVE, proc: then }));
    assert.deepEqual(await asSystem(P.system, id, async () => H.serverUsers('codex', { runs: [], after: await H.askHolders('codex') })), [], 'the holds, after the stop asked');

    // The command's pid lives with its own start: kept, it would be "the same"; an end waits for an answer asked now.
    const R = await import('../src/ship/runcmd.mjs');
    const then2 = startAs(kind, Date.now() - 600_000);
    const { id: id2 } = playedReader(kind, new Map([[LIVE, then2]]));
    id2.of([LIVE]);
    await settle();
    let ended = 0;
    const end = () => (ended++, { ok: true });
    const rec = { pid: LIVE, proc: `T:${then2}`, at: new Date().toISOString(), minutes: 1 };
    assert.equal(R.commandRuns(rec, id2), true, 'a judge that cannot wait: the kept answer, held');
    assert.equal(R.endCommand(rec, id2, { end }), false, 'an end: not on a kept answer');
    const after = await P.askedAfter([LIVE], id2);
    assert.equal(R.endCommand(rec, id2, { end, after }), true, 'an end after an answer asked for it');
    assert.equal(ended, 1);
    void then;
  });

  test(`${kind}: a pid asked for while another question is on its way is asked right after it, never dropped`, async () => {
    const { id, asked } = playedReader(kind, new Map([[LIVE, startAs(kind, Date.now() - 600_000)], [process.pid + 1000000, 1]]));
    id.of([LIVE]);
    id.of([process.pid + 1000000]);
    assert.equal(asked.length, 1, 'one question at a time');
    await settle();
    await settle();
    assert.equal(asked.length, 2, 'the second pid was asked after the first question came back');
    assert.ok(String(asked[1]).includes(String(process.pid + 1000000)) || kind === 'win32', 'about that pid');
  });

  test(`${kind}: a command the dashboard starts gets its identity into its record a moment later`, async () => {
    const R = await import('../src/ship/runcmd.mjs');
    const start = startAs(kind, Date.now() - 1000);
    const { id } = playedReader(kind, new Map([[LIVE, start]]));
    // The self check is done already, as in a dashboard that has run a while.
    id.of([LIVE]);
    await settle();
    const fresh = process.pid + 2000000;
    const { id: id2, table } = playedReader(kind, new Map(), { lag: 0 });
    table.set(fresh, start);
    const child = { pid: fresh, exitCode: null, signalCode: null };
    let got = null;
    const rec = R.commandRecord(child, 1, id2, { later: (proc) => (got = proc) });
    assert.equal(rec.proc, null, 'not known at once in the background');
    await settle();
    await settle();
    assert.equal(got, `T:${start}`, 'handed on once the system answered');
    // A command that ended before the answer came: its pid may be another process's by then; nothing is handed on.
    const { id: id3, table: t3 } = playedReader(kind, new Map(), { lag: 0 });
    t3.set(fresh, start);
    const gone = { pid: fresh, exitCode: null, signalCode: null };
    let late = null;
    R.commandRecord(gone, 1, id3, { later: (proc) => (late = proc) });
    gone.exitCode = 0;
    await settle();
    await settle();
    assert.equal(late, null);
    void id;
  });
}

for (const kind of KINDS) {
  test(`${kind}: a command record never takes a kept answer of the process that had its pid before`, async () => {
    const R = await import('../src/ship/runcmd.mjs');
    const P2 = process.pid + 3000000;
    const { id, table } = playedReader(kind, new Map([[P2, startAs(kind, Date.now() - 600_000)]]), { lag: 0 });
    id.of([P2]);
    await settle(); // kept: the earlier command that had this pid
    const start = startAs(kind, Date.now() - 1000);
    table.set(P2, start);
    let got = null;
    const rec = R.commandRecord({ pid: P2, exitCode: null, signalCode: null }, 1, id, { later: (proc) => (got = proc) });
    assert.equal(rec.proc, null, 'not the kept identity of the earlier process');
    await settle();
    await settle();
    assert.equal(got, `T:${start}`, 'its own, once asked');
  });

  test(`${kind}: an answer to an older question never replaces a newer one`, async () => {
    const P2 = process.pid + 4000000;
    let let1;
    const gate = (n) => (n === 1 ? new Promise((r) => (let1 = r)) : Promise.resolve());
    const { id } = playedReader(kind, new Map([[P2, startAs(kind, Date.now() - 600_000)]]), { gate });
    id.of([P2]); // a background question, on its way
    await new Promise((r) => setTimeout(r, 5));
    const after = await id.refresh([P2]); // a newer one, answered first
    assert.ok(id.of([P2], { after }).get(P2), 'known since the newer question');
    let1();
    await settle();
    assert.ok(id.of([P2], { after }).get(P2), 'still known once the older answer came');
  });
}

test('linux: a reader in the background still knows every answer at once (closeCut stays synchronous there)', () => {
  const id = P.makeIdentity({ platform: 'linux', pid: 1, read: () => 'b\n' });
  id.askInBackground();
  assert.equal(id.inBackground(), false);
  const mac = P.makeIdentity({ platform: 'darwin', run: () => '' });
  mac.askInBackground();
  assert.equal(mac.inBackground(), true);
});

test('linux: never in the background path, every answer read at once', () => {
  let reads = 0;
  const id = P.makeIdentity({ platform: 'linux', pid: 1, read: (p) => (reads++, p.endsWith('boot_id') ? 'b\n' : '5 (x) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0') });
  id.askInBackground();
  assert.equal(id.of([5], { after: Date.now(), born: 1 }).get(5), 'L:b:777');
  assert.ok(reads >= 1);
});
