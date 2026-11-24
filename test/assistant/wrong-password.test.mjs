// A wrong administrator password runs nothing and the card stays open for another try (a wrong password
// runs nothing and asks again). core.confirm keeps the card pending and answers with code 'wrong-password'; the right
// password on the same card then runs. The whole path goes through the real route (core.confirm → run → runAdmin).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { hoprigVersion } from '../../src/handsoff.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const ops = new FakeOps(baseState());
  ops.s.settings.server.herRights = { level: 'ask', version: hoprigVersion(), at: 1 };
  ops.adminPw = true; // this computer's sudo asks for a password, so the card has a password field
  ops.adminRightPassword = 'correct'; // anything else runs nothing (wrong)
  const now = Date.now;
  const core = createAssistantCore({
    ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }),
    jobs: new JobStore({ dir: null, now }), skills: new Skills({ dirs: [] }),
  });
  return { ops, core };
}

test('a wrong password keeps the card open and asks again; the right password then runs', async () => {
  const { ops, core } = setup();
  const staged = await core.call('run_command', { command: 'sudo apt-get update' }, { conversation: 'c1' });
  assert.equal(staged.isError, false, staged.text);
  const card = core.cards.pending()[0];
  assert.ok(card && card.form && card.form.fields.some((f) => f.type === 'password'), 'the card has a password field');

  const wrong = await core.confirm(card.id, { admin_password: 'nope' });
  assert.equal(wrong.ok, false, 'a wrong password runs nothing');
  assert.equal(wrong.code, 'wrong-password', 'the page is told to keep the card and ask again');
  assert.equal(core.cards.get(card.id).status, 'pending', 'the card stays open for another try');
  // The reset expiry goes back with the answer, so the page can match its countdown to the server's new window
  // instead of counting down from the old expiry and reading 'expired' while the retyped password still works.
  assert.ok(Number.isFinite(wrong.expiresAt), 'the wrong-password reply carries the reset expiry');
  assert.equal(wrong.expiresAt, core.cards.get(card.id).expiresAt, 'it is the card\'s reset expiry');
  assert.ok(wrong.expiresAt >= card.expiresAt, 'the window is reset forward, not shrunk');
  assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), 'never the plain shell');
  const ranWrong = ops.calls.filter((c) => c.op === 'runAdmin');
  assert.equal(ranWrong.length, 1, 'the admin run was attempted once, with the wrong password');

  const right = await core.confirm(card.id, { admin_password: 'correct' });
  assert.equal(right.ok, true, `the right password runs: ${JSON.stringify(right)}`);
  assert.equal(core.cards.get(card.id).status, 'done', 'the card is finished once it ran');
  assert.equal(ops.lastAdminPassword, 'correct', 'the correct password reached the runner');
});
