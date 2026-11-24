// Her own tool at Full (run_command through the real route: core.call → facts → policy → run): a delete as
// administrator is the owner's card at Full as at Ask, a word with `$` is refused because the tool runs the words as
// they are written, and an ordinary administrator command still runs with no card. No real sudo is reached: FakeOps
// stands in for the administrator run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { hoprigVersion } from '../../src/handsoff.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup(level = 'full') {
  const ops = new FakeOps(baseState());
  ops.s.settings.server.herRights = { level, version: hoprigVersion(), at: 1 };
  ops.adminPw = false; // sudo needs no password here, so Full runs an ordinary administrator command with no card
  const now = Date.now;
  const core = createAssistantCore({
    ops,
    now,
    cards: new CardStore({ now }),
    audit: new AuditLog({ file: null, now }),
    jobs: new JobStore({ dir: null, now }),
    skills: new Skills({ dirs: [{ dir: '/nonexistent-owner', source: 'owner' }] }),
  });
  return { ops, call: (command) => core.call('run_command', { command }, { conversation: 'c1' }) };
}
const adminRuns = (ops) => ops.calls.filter((c) => c.op === 'runAdmin');

test('at Full a delete as administrator is his card, and nothing runs before his tap', async () => {
  for (const command of ['sudo rm /var/tmp/old.log', 'sudo rm -rf /srv/cache', 'sudo find /srv/cache -name x -delete', 'sudo shred -u /srv/x', 'sudo truncate -s 0 /var/log/shop.log', 'sudo dd if=/dev/zero of=/dev/sdb']) {
    const { ops, call } = setup('full');
    const r = await call(command);
    assert.ok(!r.isError && r.card, `a card: ${command}`);
    assert.equal(adminRuns(ops).length, 0, `nothing ran: ${command}`);
    assert.match(r.text, /deletes as administrator/, `the card says why: ${command}`);
  }
});

test('at Full an ordinary administrator command still runs with no card', async () => {
  for (const command of ['sudo apt-get install ripgrep', 'sudo systemctl restart nginx', 'sudo chown -R www-data /var/www/site']) {
    const { ops, call } = setup('full');
    const r = await call(command);
    assert.ok(!r.isError && !r.card, command);
    assert.equal(adminRuns(ops).length, 1, command);
  }
});

test('a word with $ is refused at every level: the tool would run other words than the ones written', async () => {
  for (const level of ['ask', 'full']) {
    for (const command of ['sudo rm -rf $PREFIX/etc', 'sudo chown -R nobody ${TARGET}']) {
      const { ops, call } = setup(level);
      const r = await call(command);
      assert.ok(r.isError, `${level}: ${command}`);
      assert.ok(!r.card, 'no card');
      assert.equal(adminRuns(ops).length, 0);
      assert.match(r.text, /variable/, 'it says what to write instead');
    }
  }
});

test('a change of the root folder, which holds Hoprig\'s own folders, is refused at every level', async () => {
  for (const level of ['ask', 'full']) {
    const { ops, call } = setup(level);
    const r = await call('sudo chown -R nobody /');
    assert.ok(r.isError && !r.card, level);
    assert.equal(adminRuns(ops).length, 0);
  }
});
