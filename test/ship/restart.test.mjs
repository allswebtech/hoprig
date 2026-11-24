// What a restart would cut (src/ship/restart.mjs, rule 6b): a turn that ends within the limit is waited for and nothing
// is cut; a turn that never ends stops a go-live by itself with its reason; on the owner's tap a built-in terminal
// session or a running turn is cut only when it was named before the tap ("restart anyway").
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { OWN_CODE, cutWords, restartsDashboard, waitForTurns, whatRestartCuts } from '../../src/ship/restart.mjs';

/** A clock and sleep of the test's own: `seconds` pass without waiting. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('Hoprig is known by its own folder; another project says so with restarts', () => {
  assert.equal(restartsDashboard(OWN_CODE, { restarts: false }), true);
  assert.equal(restartsDashboard(path.dirname(OWN_CODE), { restarts: false }), true, 'a parent folder of the code');
  assert.equal(restartsDashboard('/srv/example/shop', { restarts: false }), false);
  assert.equal(restartsDashboard('/srv/example/shop', { restarts: true }), true);
});

test('a turn that ends within the limit is waited for; nothing is cut', async () => {
  const c = clock();
  let busyUntil = 3000;
  const src = { kind: 'tmux', chats: async () => [{ chatId: 'c1', display: 'Fix the cart', status: c.now() < busyUntil ? 'working' : 'waiting' }], assistant: async () => [] };
  const cut = await waitForTurns(src, { seconds: 10, byItself: true, ...c });
  assert.deepEqual(cut, { turns: [], terminals: [] });
  assert.ok(c.now() >= 3000 && c.now() < 10_000, 'it waited for the turn and no longer');
  busyUntil = 0;
});

test('a turn that never ends stops a go-live by itself, with its reason', async () => {
  const c = clock();
  const src = { kind: 'tmux', chats: async () => [], assistant: async () => [{ id: 't1', title: 'Plan the week', busy: true }] };
  await assert.rejects(waitForTurns(src, { seconds: 5, byItself: true, ...c }), (e) => e.details.code === 'restart-cuts' && /the assistant "Plan the week"/.test(e.message) && /waited 5 s/.test(e.message) && !/\.\s*\(waited/.test(e.message));
  assert.ok(c.now() >= 5000);
});

test('a built-in terminal session is named before the tap; cut only with "restart anyway" for it', async () => {
  const src = { kind: 'pty', chats: async () => [], assistant: async () => [], terminals: async () => [{ session: 'build-shell' }, { session: 'old', dead: true }] };
  const cut = await whatRestartCuts(src);
  assert.deepEqual(cut.terminals, ['build-shell']);
  assert.equal(cutWords(cut), 'A restart would end the terminal build-shell (terminals of this dashboard always close on a restart).');
  assert.equal(cutWords({ turns: [], terminals: ['a', 'b'] }), 'A restart would end the terminals a, b (terminals of this dashboard always close on a restart).');
  await assert.rejects(waitForTurns(src, { seconds: 1, ...clock() }), /not named when you tapped/);
  await assert.rejects(waitForTurns(src, { seconds: 1, byItself: true, ...clock() }), /did not go live by itself/);
  const ok = await waitForTurns(src, { seconds: 1, named: { turns: [], terminals: ['build-shell'] }, ...clock() });
  assert.deepEqual(ok.terminals, ['build-shell']);
  // On tmux a terminal session lives on through a restart: nothing to name.
  assert.deepEqual((await whatRestartCuts({ ...src, kind: 'tmux' })).terminals, []);
  assert.equal(cutWords({ turns: [], terminals: [] }), null);
});

test('an App session that waits for an OK is a turn still running', async () => {
  const cut = await whatRestartCuts({ kind: 'tmux', chats: async () => [{ chatId: 'c2', display: 'Add tests', status: 'attention' }, { chatId: 'c3', status: 'waiting' }], assistant: async () => [] });
  assert.deepEqual(cut.turns, [{ kind: 'app', id: 'c2', name: 'Add tests' }]);
});
