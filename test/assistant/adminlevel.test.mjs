// Tia's administrator-rights level, wired into run_command through the real route (core.mjs call → facts → policy
// decideLevel), level by level (docs/OPERATOR.md, Administrator rights). Proven here: the administrator commands that
// could raise her rights are refused with NO card at EVERY level, each with its own reason; which commands are
// administrator commands stays the wall's one reader (wallKind) and the refused forms adminRefusal's. Every proof
// goes through call('run_command', …), and asserts the dashboard's runCommand never ran — no stand-in sudo is
// reached, because a refused command never runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const ops = new FakeOps(baseState());
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

// The forms that could raise her rights: one command per refused form, each refused with no card at every level, with its own reason.
const REFUSED = [
  ['su', /administrator by a way other than sudo/],
  ['doas id', /administrator by a way other than sudo/],
  ['pkexec id', /administrator by a way other than sudo/],
  ['sudo -i', /a login or a shell as administrator/],
  ['sudo -s', /a login or a shell as administrator/],
  ['sudo -e /etc/hosts', /edits a file as administrator/],
  ['sudo -u bob id', /which program would run is unknown/],
  ['sudo', /names no program to run as administrator/],
  ['sudo bash', /runs a shell as administrator/],
  ['sudo sh -c "echo hi"', /runs a shell as administrator/],
  ['sudo vi /etc/hosts', /runs an editor as administrator/],
  ['sudo visudo', /runs an editor as administrator/],
  ['sudo passwd root', /who may be administrator or a password/],
  ['sudo usermod -aG sudo bob', /who may be administrator or a password/],
  ['sudo chmod u+s /usr/bin/x', /set-user-id bit/],
  ['sudo chmod 4755 /usr/bin/x', /set-user-id bit/],
  ['sudo cat /etc/sudoers', /a file that decides who may be administrator/],
  ['sudo tee /etc/pam.d/common-auth', /a file that decides who may be administrator/],
];

test('decision 4: a command that could raise her rights is refused with no card at every level, with its own reason', async () => {
  for (const [command, reason] of REFUSED) {
    const { ops, call } = setup();
    const r = await call(command);
    assert.ok(r.isError, `${command} should be refused`);
    assert.ok(!r.card, `${command} must stage no card`);
    assert.match(r.text, reason, command);
    assert.match(r.text, /at every level/, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), `${command} must not run`);
  }
});

test('decision 2 (Off, the default): a plain administrator command is refused with no card, and she says where the owner turns it on', async () => {
  for (const command of ['sudo apt-get install ripgrep', 'sudo systemctl restart nginx', 'FOO=1 /usr/bin/sudo ls', 'sudo tee /tmp/x']) {
    const { ops, call } = setup();
    const r = await call(command);
    assert.ok(r.isError, command);
    assert.ok(!r.card, command);
    assert.match(r.text, /administrator rights, which is the owner's own step/, command);
    // She points at the setting on his own page (per computer), and runs nothing.
    assert.match(r.text, /Settings → Tia administrator rights on his own page/, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), `${command} must not run`);
  }
});

test('a command the wall cannot read is refused rather than run on the plain shell (an obfuscated sudo cannot dodge the admin policy)', async () => {
  // run_command routed a command to the plain shell whenever the wall did not read it as "admin". A sudo hidden in a
  // command substitution reads as "unreadable", not "admin", so it slipped past the Off refusal, the clear sudo-argv
  // card and the decision-4 refusals and reached the shell, which expanded it and ran sudo. An unreadable command is
  // now refused rather than run (fail closed), so nothing reaches ops.runCommand.
  for (const command of ['$(echo sudo) chmod 4755 /bin/foo', '$(printf sudo) tee /etc/sudoers.d/x', '`echo sudo` rm -rf /etc']) {
    const { ops, call } = setup();
    const r = await call(command);
    assert.ok(r.isError, command);
    assert.ok(!r.card, `${command} must stage no card`);
    assert.match(r.text, /cannot be read with certainty/, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), `${command} must not reach the plain shell`);
  }
});

test('a command that is his alone in every mode but is not an administrator command is still refused by run_command.check (no regression)', async () => {
  for (const [command, why] of [
    ['systemctl --user restart hoprig', /the system's services/],
    ['cd /p && git push origin main', /a push or a merge/],
    ['brew install gh', /installing or removing system packages/],
    ['scp notes.txt box2:', /sending data to another computer/],
  ]) {
    const { ops, call } = setup();
    const r = await call(command);
    assert.ok(r.isError, command);
    assert.match(r.text, why, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), `${command} must not run`);
  }
});
