// A judge of one record (a lock, a claim, a hold: "does the process that wrote it still run?") takes an identity the
// system gave at most FRESH_MS ago (src/procid.mjs freshAfter), never a kept one: a kept answer may be from before that
// process ended and Windows handed its pid to another process, and would read the record as held. Windows' answers are
// played: a reader that keeps "the same start" from before, and gives "another start" when asked afresh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'procid-fresh-'));
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P = await import('../src/procid.mjs');
const LIVE = process.ppid; // a pid that runs: Windows gave the dead writer's number to it
const THEN = 'T:1795000000000'; // the writer's identity, kept by the reader
const NOW = 'T:1795000900000'; // the identity of the process that has the pid now
/** A reader that keeps THEN for every pid unless asked for an answer since a moment (`after`): then NOW. */
const kept = { self: () => 'T:1', of: (pids, o = {}) => new Map(pids.map((p) => [p, o.after ? NOW : THEN])), refresh: async () => 0, bootAt: () => 0 };
/** The same, put in place of the system's reader for the judges that use it. */
async function withKept(fn) {
  const was = { of: P.system.of, refresh: P.system.refresh };
  Object.assign(P.system, { of: kept.of, refresh: kept.refresh });
  try {
    return await fn();
  } finally {
    Object.assign(P.system, was);
  }
}

test('the shared rule: a kept "same" says held; an answer since a moment says the writer is gone', () => {
  const file = path.join(tmp, 'rec.json');
  fs.writeFileSync(file, '{}');
  assert.equal(P.filedProcess(file, { pid: LIVE, proc: THEN }, { ident: kept }), true, 'a kept answer: held (the fault)');
  assert.equal(P.filedProcess(file, { pid: LIVE, proc: THEN }, { ident: kept, after: P.freshAfter() }), false, 'asked afresh: gone');
  assert.ok(Date.now() - P.freshAfter() <= P.FRESH_MS + 50);
});

test('each judge asks afresh: the get lock, the improvement round, the move lock, the ship lock, the dashboard file, the holds', async () => {
  const L = await import('../src/pcsetup/leftovers.mjs');
  assert.equal(L.lockOwner(JSON.stringify({ pid: LIVE, proc: THEN }), Date.now(), { ident: kept }).running, false, 'get lock');

  const I = await import('../src/assistant/improvefeature.mjs');
  const lock = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'improve.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: LIVE, proc: THEN, id: 'old' }));
  assert.equal(I.takeLock('r1', { ident: kept }), true, 'improvement round: taken over');
  fs.rmSync(lock);

  const M = await import('../src/setup/movelock.mjs');
  const md = path.join(tmp, 'move');
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, M.LOCK_FILE), `${LIVE} ${THEN}\n`);
  assert.equal(M.lockHolder(md, { ident: kept }), null, 'move lock');

  const S = await import('../src/ship/lock.mjs');
  const sd = path.join(tmp, 'ship');
  fs.mkdirSync(sd, { recursive: true });
  const release = S.takeLock(sd, 'go live', { ident: kept });
  const sf = fs.readdirSync(sd).map((n) => path.join(sd, n))[0];
  const text = JSON.parse(fs.readFileSync(sf, 'utf8'));
  fs.writeFileSync(sf, JSON.stringify({ ...text, pid: LIVE, proc: THEN }));
  assert.equal(S.lockHolder(sd, { ident: kept }).gone, true, 'ship lock');
  void release;

  await withKept(async () => {
    const D = await import('../src/server/dashboardfile.mjs');
    fs.mkdirSync(path.dirname(D.dashboardFile()), { recursive: true });
    fs.writeFileSync(D.dashboardFile(), JSON.stringify({ pid: LIVE, proc: THEN, host: '127.0.0.1', port: 7979, at: Date.now() }));
    assert.equal(D.runningDashboard(), null, 'dashboard file');
    const H = await import('../src/codetools/servers.mjs');
    const { serverDir } = H;
    fs.mkdirSync(serverDir(), { recursive: true });
    fs.writeFileSync(path.join(serverDir(), `opencode-held-${LIVE}`), JSON.stringify({ pid: LIVE, proc: THEN }));
    assert.deepEqual(H.serverUsers('opencode', { runs: [] }), [], 'holds of a coding tool server');
  });
});

test('the judges that go through filedProcess pass a fresh moment, and so do the gateway check and ship', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const [file, line] of [
    ['src/setup/gatewaycheck.mjs', /filedProcess\(file, rec, \{ after: freshAfter\(\) \}\)/],
    ['src/codetools/holds.mjs', /function holders\(tool, after = freshAfter\(\)\)[^]*filedProcess\(file, \{ pid, proc: holdIdentity\(file\) \}, \{ after \}\)/],
    ['src/server/dashboardfile.mjs', /filedProcess\(dashboardFile\(\), d, \{ after: freshAfter\(\) \}\)/],
    ['src/ship/lock.mjs', /lockHolder\(folder, \{ ident = system, name = LOCK_NAME, after = freshAfter\(\) \} = \{\}\)[^]*filedProcess\(file, r, \{ ident, after \}\)/],
    ['src/ship/live.mjs', /function claimGone\(file, c, ident, after = freshAfter\(\)\)[^]*filedProcess\(file, c, \{ ident, after \}\)/],
    ['src/ship/runcmd.mjs', /commandRuns\(rec, ident = system, \{ after = freshAfter\(\), strict = false \} = \{\}\)[^]*ident\.of\(\[rec\.pid\], \{ after, born: strict \? 0 : startOf\(rec\.proc\) \}\)/],
  ]) assert.match(read(file), line, file);
});
