// The hub's move for a computer it reaches by SSH (src/machines/movehub.mjs): the move runs there over the SSH login,
// and the hub's entry is switched to <user>@<host> only after a real login as that user worked. When it did not, or the
// move failed, the entry stays as it was. The SSH runner is a stand-in that writes down each call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('machines-movehub');
test.after(() => box.cleanup());
const H = await import('../../src/machines/movehub.mjs');
const S = await import('../../src/machines/store.mjs');

const plan = { hoprig: 'move-plan', ok: true, stops: [], user: { name: 'hoprig', home: '/home/hoprig' } };
const entry = { name: 'box2', via: 'ssh', target: 'root@box2.example.com', remoteHost: '127.0.0.1', remotePort: 7433, token: 'made-up-token' };
function runner({ moveOk = true, loginOk = true } = {}) {
  const calls = [];
  const run = async (target, args, o = {}) => {
    calls.push(`${target} ${args.join(' ')}`);
    if (args[1] === '--dry-run') return { ok: true, result: { stdout: `Welcome\n${JSON.stringify(plan)}\n` } };
    if (args[0] === 'move-to-user' && args[1] === '--yes') {
      o.onLine?.('Copying 47 entries (27 KB) to /home/hoprig…');
      return moveOk ? { ok: true, result: { stdout: '' } } : { ok: false, message: 'Hoprig on box2 failed: STOPPED at "the trial"' };
    }
    if (args[0] === 'version') return loginOk ? { ok: true, result: { stdout: '0.3.3\n' } } : { ok: false, message: 'hoprig@box2.example.com: Permission denied (publickey).' };
    return { ok: false, message: 'not expected' };
  };
  return { run, calls };
}
const until = async (mv) => {
  for (let i = 0; i < 100 && mv.status('box2').running; i++) await new Promise((r) => setTimeout(r, 10));
  return mv.status('box2');
};

test('the move there, then a login as the user that works: only then is the entry switched', async () => {
  S.saveMachines([entry]);
  const r = runner();
  const mv = H.createHubMove({ run: r.run });
  assert.equal((await mv.look('box2')).plan.user.name, 'hoprig');
  assert.deepEqual(await mv.start('box2'), { started: true, user: 'hoprig' });
  const st = await until(mv);
  assert.deepEqual(st.result, { ok: true, switched: true, target: 'hoprig@box2.example.com' });
  assert.deepEqual(r.calls.slice(-2), ['root@box2.example.com move-to-user --yes --user hoprig', 'hoprig@box2.example.com version']);
  assert.equal(S.getMachine('box2').target, 'hoprig@box2.example.com');
  assert.match(st.lines.join('\n'), /Copying 47 entries[\s\S]*A login as hoprig@box2\.example\.com worked: this main computer now reaches box2 as hoprig@box2\.example\.com\./);
});

test('a login as the user that fails, or a move that fails: the entry stays as it was, and the line says why', async () => {
  for (const [over, re] of [[{ loginOk: false }, /did not work .*Permission denied.*so this main computer still reaches box2 as root@box2\.example\.com\. The move itself is done there: do not run it again\..*then remove box2 on this main computer and add it again as hoprig@box2\.example\.com\./], [{ moveOk: false }, /did not finish .*the trial.*Its entry on this main computer stays as it was\./]]) {
    S.saveMachines([entry]);
    const r = runner(over);
    const mv = H.createHubMove({ run: r.run });
    await mv.start('box2');
    const st = await until(mv);
    assert.equal(st.result.switched, false);
    assert.match(st.lines.join('\n'), re);
    assert.equal(S.getMachine('box2').target, 'root@box2.example.com');
  }
});

test('a look that stops starts nothing; a computer not added by SSH is refused', async () => {
  S.saveMachines([entry, { name: 'web1', via: 'url', url: 'https://web1.example.com', token: 'made-up' }]);
  const calls = [];
  const mv = H.createHubMove({ run: async (t, a) => (calls.push(a.join(' ')), { ok: true, result: { stdout: JSON.stringify({ ...plan, ok: false, stops: ['a session is working now'] }) } }) });
  await assert.rejects(mv.start('box2'), /a session is working now/);
  assert.deepEqual(calls, ['move-to-user --dry-run --json']);
  await assert.rejects(mv.look('web1'), /was not added by SSH/);
  assert.equal(H.withUser('ssh://root@box2:2222', 'hoprig'), 'ssh://hoprig@box2:2222');
  assert.equal(H.withUser('box2', 'hoprig'), 'hoprig@box2');
});

test('his choice of no administrator rights on the hub\'s sheet reaches the move there as --no-admin', async () => {
  S.saveMachines([entry]);
  const r = runner();
  const mv = H.createHubMove({ run: r.run });
  await mv.start('box2', { noAdmin: true });
  await until(mv);
  assert.ok(r.calls.includes('root@box2.example.com move-to-user --yes --user hoprig --no-admin'), r.calls.join('\n'));
});

test('a look that said the move makes the user passes --new, so a user of that name that appeared there since is not moved into', async () => {
  for (const [make, argv] of [[true, 'move-to-user --yes --user hoprig --new'], [false, 'move-to-user --yes --user hoprig']]) {
    S.saveMachines([entry]);
    const calls = [];
    const run = async (target, args) => {
      calls.push(args.join(' '));
      if (args[1] === '--dry-run') return { ok: true, result: { stdout: `${JSON.stringify({ ...plan, make })}\n` } };
      if (args[0] === 'version') return { ok: true, result: { stdout: '0.3.3\n' } };
      return { ok: true, result: { stdout: '' } };
    };
    const mv = H.createHubMove({ run });
    await mv.start('box2');
    await until(mv);
    assert.equal(calls[1], argv, `make ${make}`);
  }
});

test('two presses at once start one move there: the second is refused while the first looks, and the first is reported as it went', async () => {
  S.saveMachines([entry]);
  let lockHeld = false;
  let moves = 0;
  let looks = 0;
  let lookFails = true;
  // The look takes a while (an SSH login); the remote lock refuses a second move at once, as movelock.mjs does there.
  const run = async (target, args, o = {}) => {
    if (args[1] === '--dry-run') {
      looks += 1;
      await new Promise((r) => setTimeout(r, 50));
      if (lookFails) return { ok: false, message: 'ssh: connect to host box2.example.com: Connection timed out' };
      return { ok: true, result: { stdout: `${JSON.stringify(plan)}\n` } };
    }
    if (args[0] === 'move-to-user' && args[1] === '--yes') {
      moves += 1;
      if (lockHeld) return { ok: false, message: 'Another move runs on this server now (process 4242)' };
      lockHeld = true;
      await new Promise((r) => setTimeout(r, 50));
      lockHeld = false;
      return { ok: true, result: { stdout: '' } };
    }
    if (args[0] === 'version') return { ok: true, result: { stdout: '0.3.3\n' } };
    return { ok: false, message: 'not expected' };
  };
  const mv = H.createHubMove({ run });
  // A look that fails lets the claim go: the next press looks again.
  await assert.rejects(mv.start('box2'), /Connection timed out/);
  lookFails = false;
  const both = await Promise.allSettled([mv.start('box2'), mv.start('box2')]);
  assert.deepEqual(both.map((x) => x.status), ['fulfilled', 'rejected']);
  assert.deepEqual(both[0].value, { started: true, user: 'hoprig' });
  assert.equal(both[1].reason.status, 409);
  assert.match(both[1].reason.message, /the move there is running already/);
  assert.equal(looks, 2, 'the second press of the pair did not look');
  const st = await until(mv);
  assert.equal(moves, 1, 'one move there');
  assert.deepEqual(st.result, { ok: true, switched: true, target: 'hoprig@box2.example.com' });
  assert.equal(S.getMachine('box2').target, 'hoprig@box2.example.com');
  // A press after the move ended is let in again (to its look).
  lookFails = true;
  await assert.rejects(mv.start('box2'), /Connection timed out/);
});

test('while a press still looks there, the job reads as running, so a page refused meanwhile follows it; a look that fails ends it', async () => {
  S.saveMachines([entry]);
  let lookFails = false;
  let release;
  const run = async (target, args, o = {}) => {
    if (args[1] === '--dry-run') {
      await new Promise((r) => (release = r)); // an SSH login that takes a while
      return lookFails ? { ok: false, message: 'ssh: connect to host box2.example.com: Connection timed out' } : { ok: true, result: { stdout: `${JSON.stringify(plan)}\n` } };
    }
    if (args[0] === 'move-to-user' && args[1] === '--yes') return { ok: true, result: { stdout: '' } };
    if (args[0] === 'version') return { ok: true, result: { stdout: '0.3.3\n' } };
    return { ok: false, message: 'not expected' };
  };
  const mv = H.createHubMove({ run });
  assert.deepEqual(mv.status('box2'), { running: false, lines: [], next: 0, result: null });
  const first = mv.start('box2');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(mv.status('box2'), { running: true, lines: [], next: 0, result: null }, 'the press that looks has claimed it');
  await assert.rejects(mv.start('box2'), /the move there is running already/);
  release();
  assert.deepEqual(await first, { started: true, user: 'hoprig' });
  const st = await until(mv);
  assert.deepEqual(st.result, { ok: true, switched: true, target: 'hoprig@box2.example.com' });
  // A look that fails: the claim goes, and the job reads as before (not running).
  S.saveMachines([entry]);
  lookFails = true;
  const mv2 = H.createHubMove({ run });
  const p = mv2.start('box2');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mv2.status('box2').running, true);
  release();
  await assert.rejects(p, /Connection timed out/);
  assert.deepEqual(mv2.status('box2'), { running: false, lines: [], next: 0, result: null });
});
