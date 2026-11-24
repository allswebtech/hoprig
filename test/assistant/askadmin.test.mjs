// Ask each time (docs/OPERATOR.md, Administrator rights): an administrator command of hers is ONE confirmation card at
// the owner's Ask level, run through the administrator path at his tap, with his password to sudo's input and nowhere
// else. The whole path is exercised through the real route: core.call → facts → policy decideLevel → the staged card
// → core.confirm. The real sudo and its scrubbing are proven end to end in adminrouting.test.mjs; here the CHANNEL is
// proven — the password reaches run_command's run (ops.runAdmin) and NO audit line, NO card record and NO result holds
// it. The forms refused with no card at every level are still refused under Ask.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const PW = 'made up pw 9#Zx'; // a made-up string of the test; never a real password
const CMD = 'sudo apt-get install ripgrep';
const ARGV = 'sudo apt-get install ripgrep';

function setup({ level = 'ask', adminPw = true } = {}) {
  const ops = new FakeOps(baseState());
  ops.s.settings.server.herRights = { level, version: 'test', at: 1 };
  ops.adminPw = adminPw;
  ops.adminRightPassword = adminPw ? PW : undefined; // the one password that runs (anything else is "wrong")
  const now = Date.now;
  const core = createAssistantCore({
    ops,
    now,
    cards: new CardStore({ now }),
    audit: new AuditLog({ file: null, now }),
    jobs: new JobStore({ dir: null, now }),
    skills: new Skills({ dirs: [{ dir: '/nonexistent-owner', source: 'owner' }] }),
  });
  return { ops, core, call: (command) => core.call('run_command', { command }, { conversation: 'c1' }) };
}

test('Ask: one card with the exact argv, nothing runs before the tap, his right password runs it once, the password nowhere', async () => {
  const { ops, core, call } = setup();
  const r = await call(CMD);
  assert.ok(!r.isError, 'an administrator command at Ask is staged, not refused');
  assert.ok(r.card, 'it stages one card');
  assert.ok(!ops.calls.some((c) => c.op === 'runAdmin'), 'nothing ran before the tap');

  const form = r.card.form;
  assert.ok(form, 'the card carries a form');
  const cmdField = form.fields.find((f) => f.name === 'command');
  assert.equal(cmdField.value, ARGV, 'the exact sudo argv is shown');
  assert.match(cmdField.label, /administrator/i, 'shown as running as administrator');
  assert.ok(form.fields.some((f) => f.name === 'computer'), 'the computer is named');
  const pwField = form.fields.find((f) => f.type === 'password');
  assert.ok(pwField, "a password field, because this computer's sudo asks for one");

  const ok = await core.confirm(r.card.id, { admin_password: PW });
  assert.ok(ok.ok, 'his tap with the right password ran it');
  const adminRuns = ops.calls.filter((c) => c.op === 'runAdmin');
  assert.equal(adminRuns.length, 1, 'ran once as administrator');
  assert.deepEqual(adminRuns[0].args.argv, ['sudo', 'apt-get', 'install', 'ripgrep'], "the wall's reader built the argv");
  assert.equal(ops.lastAdminPassword, PW, "the one-shot password reached the administrator run (sudo's input)");
  assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), 'never the plain shell');

  // The password is in nothing that is kept: no card record, no audit line, no told result.
  const card = core.cards.get(r.card.id);
  const audit = core.audit.recent();
  const told = core.takeOutcomes('c1').map((o) => o.text).join('\n');
  const kept = JSON.stringify({ card, audit, told });
  assert.ok(!kept.includes(PW), 'the password is in no card record, audit line or result');
  assert.equal(card.input.admin_password, undefined, 'the card input never gained the password');
  assert.ok(!audit.some((e) => e.input && Object.prototype.hasOwnProperty.call(e.input, 'admin_password')), 'no audit input holds the password field');
  assert.ok(audit.some((e) => e.outcome === 'confirmed') && audit.some((e) => e.outcome === 'done'), 'the run is audited (with no password)');

  // A second tap on the used card runs nothing more.
  const again = await core.confirm(r.card.id, { admin_password: PW });
  assert.equal(again.ok, false, 'a used card does not run again');
  assert.equal(ops.calls.filter((c) => c.op === 'runAdmin').length, 1, 'still ran only once');
});

test('Ask: a wrong password runs nothing and the card stays open for another try; the right one on it runs it; the password nowhere', async () => {
  const { ops, core, call } = setup();
  const r = await call(CMD);
  const bad = await core.confirm(r.card.id, { admin_password: 'not the right password' });
  assert.equal(bad.ok, false, 'a wrong password does not succeed');
  assert.equal(bad.code, 'wrong-password', 'the page is told to keep the card and ask again');
  assert.equal(core.cards.get(r.card.id).status, 'pending', 'the same card stays open for another try, not a fresh one');
  assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), 'never the plain shell');
  const kept = JSON.stringify({ card: core.cards.get(r.card.id), audit: core.audit.recent() });
  assert.ok(!kept.includes('not the right password'), 'the wrong password is in nothing that is kept');

  const ok = await core.confirm(r.card.id, { admin_password: PW });
  assert.ok(ok.ok, 'the right password on the same card runs it');
  assert.equal(core.cards.get(r.card.id).status, 'done', 'the card is finished once it ran');
});

test('Ask on a computer whose sudo asks no password: the card says so and has no field; his tap runs it', async () => {
  const { ops, core, call } = setup({ adminPw: false });
  const r = await call(CMD);
  const form = r.card.form;
  assert.ok(!form.fields.some((f) => f.type === 'password'), 'no password field where sudo asks none');
  assert.ok(form.fields.some((f) => f.type === 'readonly' && /without a password/i.test(String(f.value))), 'the card says there is no password on this computer');
  const ok = await core.confirm(r.card.id);
  assert.ok(ok.ok, 'it runs with no password at his tap');
  assert.equal(ops.lastAdminPassword, '', 'no password was given to the run');
});

test('decision 4 holds under Ask: a form that could raise her rights is still refused with no card at every level', async () => {
  for (const command of ['sudo -i', 'sudo bash', 'su', 'sudo visudo', 'sudo passwd root', 'sudo -u bob id']) {
    const { ops, core, call } = setup({ level: 'ask' });
    const r = await call(command);
    assert.ok(r.isError && !r.card, `${command} must be refused with no card`);
    assert.match(r.text, /at every level/, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runAdmin'), `${command} ran nothing`);
  }
});
