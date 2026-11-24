// Tia's run_command refuses a command the wall cannot read with certainty, and her refusal names every cause the wall
// holds such a line for: a program hidden in $(…), a backtick, an unclosed quote, or a variable standing as the
// program. A variable as the program (`$PROG`, `"$EDITOR" notes.txt`) is one of them: the refusal must say so, so
// the owner (and Tia) can tell why a line with no $(…), backtick or open quote was refused. Nothing runs: every
// proof asserts the dashboard's runCommand was never reached.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { wallKind } from '../../src/wall.mjs';
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

const CAUSES = /a program hidden in \$\(…\), a backtick, an unclosed quote, or a variable standing as the program/;

test('a variable standing as the program is refused, and the refusal names that cause', async () => {
  for (const command of ['$EDITOR notes.txt', '"$EDITOR" notes.txt', '"${EDITOR}" notes.txt', 'ls && "$EDITOR" notes.txt']) {
    assert.equal(wallKind(command), 'unreadable', `the wall holds ${command} as unreadable`);
    const { ops, call } = setup();
    const r = await call(command);
    assert.ok(r.isError, command);
    assert.ok(!r.card, `${command} must stage no card`);
    assert.match(r.text, /cannot be read with certainty/, command);
    assert.match(r.text, CAUSES, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), `${command} must not reach the plain shell`);
  }
});

test('the other causes keep the same refusal, with the full list of causes', async () => {
  for (const command of ['$(echo sudo) id', '`echo sudo` id', 'cat "never closes']) {
    const { ops, call } = setup();
    const r = await call(command);
    assert.ok(r.isError, command);
    assert.match(r.text, CAUSES, command);
    assert.ok(!ops.calls.some((c) => c.op === 'runCommand'), `${command} must not reach the plain shell`);
  }
});

test('an ordinary line with a variable as a word, not as the program, is not refused as unreadable', async () => {
  for (const command of ['node $FILE', 'echo "$HOME"']) {
    assert.equal(wallKind(command), null, command);
    const { call } = setup();
    const r = await call(command);
    assert.doesNotMatch(r.text || '', /cannot be read with certainty/, command);
  }
});
