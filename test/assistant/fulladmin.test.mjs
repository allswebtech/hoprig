// Full (docs/OPERATOR.md, Administrator rights): at the owner's Full level her administrator commands run with NO card,
// each in the audit log and her activity, but only where this computer's sudo needs no password, and at most an
// hour's limit (data) before a command falls back to the owner's Ask card. The whole path goes through the real route
// (core.call → facts → policy decideLevel → run). The administrator run itself (sudo -S -k -p '' / -n through the
// seal) is proven end to end in adminrouting.test.mjs; here the LEVEL is proven. The forms that could
// raise her rights are refused with no card at Full too. No real sudo is reached: FakeOps stands in for the administrator run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { FULL_ADMIN_PER_HOUR } from '../../src/assistant/herrights.mjs';
import { hoprigVersion } from '../../src/handsoff.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const CMD = 'sudo apt-get install ripgrep';

function setup({ adminPw = false } = {}) {
  const ops = new FakeOps(baseState());
  // Full is stamped with the running Hoprig version: under another version it reads as Ask, so the stamp
  // must match the running version for Full to be live. (The downgrade itself is proven in herrights.test.mjs.)
  ops.s.settings.server.herRights = { level: 'full', version: hoprigVersion(), at: 1 };
  ops.adminPw = adminPw; // false: sudo needs no password here, so Full runs cardless
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

test('Full where sudo needs no password: an administrator command runs with no card and is in the audit log', async () => {
  const { ops, core, call } = setup({ adminPw: false });
  const r = await call(CMD);
  assert.ok(!r.isError, 'it runs');
  assert.ok(!r.card, 'with no card');
  const adminRuns = ops.calls.filter((c) => c.op === 'runAdmin');
  assert.equal(adminRuns.length, 1, 'ran once as administrator');
  assert.deepEqual(adminRuns[0].args.argv, ['sudo', 'apt-get', 'install', 'ripgrep'], "the wall's reader built the argv");
  assert.equal(ops.lastAdminPassword, '', 'no password is given or kept (sudo -n)');
  assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), 'never the plain shell');
  // Each is in the audit log (her activity): a done L1 run_command of hers (actor assistant), the command itself kept.
  const done = core.audit.recent().filter((e) => e.tool === 'run_command' && e.outcome === 'done' && e.level === 'L1');
  assert.equal(done.length, 1, 'one done administrator run in the audit log');
  assert.equal(done[0].actor, 'assistant', 'it is in her activity');
  assert.equal(done[0].input.command, CMD, 'the command is in the audit line');
});

test('Full where sudo asks a password: it falls back to the Ask card (his tap), never cardless', async () => {
  const { ops, core, call } = setup({ adminPw: true });
  const r = await call(CMD);
  assert.ok(!r.isError && r.card, 'a card, not a cardless run');
  assert.ok(!ops.calls.some((c) => c.op === 'runAdmin'), 'nothing ran before the tap');
  assert.match(r.text, /needs no password/i, 'the card says why Full did not run it cardless');
  const pwField = r.card.form.fields.find((f) => f.type === 'password');
  assert.ok(pwField, 'the card asks for the password, as Ask does');
});

test('Full has an hour\'s limit: beyond it a command falls back to the Ask card (his tap)', async () => {
  const { ops, core, call } = setup({ adminPw: false });
  // Seed the audit with one short of the hour's limit of administrator runs: the next still runs cardless.
  const seed = (n) => { for (let i = 0; i < n; i++) core.audit.append({ actor: 'assistant', tool: 'run_command', level: 'L1', input: { command: CMD }, outcome: 'done' }); };
  seed(FULL_ADMIN_PER_HOUR - 1);
  const under = await call(CMD);
  assert.ok(!under.card, `under the limit (${FULL_ADMIN_PER_HOUR}) it still runs cardless`);
  assert.equal(ops.calls.filter((c) => c.op === 'runAdmin').length, 1, 'it ran');

  // Now at the limit (that run was the Nth): the next command falls back to the Ask card.
  const { ops: ops2, core: core2, call: call2 } = setup({ adminPw: false });
  const seed2 = (n) => { for (let i = 0; i < n; i++) core2.audit.append({ actor: 'assistant', tool: 'run_command', level: 'L1', input: { command: CMD }, outcome: 'done' }); };
  seed2(FULL_ADMIN_PER_HOUR);
  const over = await call2(CMD);
  assert.ok(over.card, 'at the hour\'s limit it needs the owner\'s card');
  assert.ok(!ops2.calls.some((c) => c.op === 'runAdmin'), 'nothing ran cardless beyond the limit');
  assert.match(over.text, new RegExp(`${FULL_ADMIN_PER_HOUR} administrator commands`), 'the card says the hour\'s limit was reached');
});

test('the hour\'s limit counts by time, not a fixed line window: a busy log cannot undercount and let more than the limit run', async () => {
  // The count once read only the last 300 audit lines. When more than that many entries are written in the hour (any
  // tool, L1/L2, staging and confirm), the hour's administrator runs fall outside the window and are not counted, so
  // more than FULL_ADMIN_PER_HOUR cardless commands could run. Here the limit's worth of administrator runs are the
  // OLDEST entries, with more than 300 other entries after them, all within the hour: counting by time still sees
  // them, so the next command falls back to the owner's card.
  const { ops, core, call } = setup({ adminPw: false });
  for (let i = 0; i < FULL_ADMIN_PER_HOUR; i++) core.audit.append({ actor: 'assistant', tool: 'run_command', level: 'L1', input: { command: CMD }, outcome: 'done' });
  for (let i = 0; i < 320; i++) core.audit.append({ actor: 'assistant', tool: 'run_command', level: 'L2', input: { command: 'ls' }, outcome: 'staged' });
  const over = await call(CMD);
  assert.ok(over.card, 'at the hour\'s limit it needs the owner\'s card, even with a busy log');
  assert.ok(!ops.calls.some((c) => c.op === 'runAdmin'), 'nothing ran cardless beyond the limit');
  assert.match(over.text, new RegExp(`${FULL_ADMIN_PER_HOUR} administrator commands`), 'the card says the hour\'s limit was reached');
});

test('decision 4 holds at Full: a form that could raise her rights is refused with no card', async () => {
  for (const command of ['sudo -i', 'sudo bash', 'su', 'sudo visudo', 'sudo passwd root', 'sudo -u bob id']) {
    const { ops, call } = setup({ adminPw: false });
    const r = await call(command);
    assert.ok(r.isError && !r.card, `${command} must be refused with no card`);
    assert.match(r.text, /at every level/, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runAdmin' || c.op === 'runCommand'), `${command} ran nothing`);
  }
});
