// The decision eval and the tick "Tia may end a stuck session in this project": the runner offers stop only to a case
// with the tick, as the decider does; every case that expects stop has it; a note that asks for the stop with no tick
// is offered no stop. Only the prompts are built here: no model is called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-eval-tick');
test.after(() => box.cleanup());

const { CASES } = await import('./eval/cases.mjs');
const { casePrompt } = await import('./eval/run.mjs');
const offered = (p) => p.split('Steps offered:')[1].split('\n')[0];

test('every case that expects stop has the tick, and its prompt offers stop', () => {
  const stops = CASES.filter((c) => c.expect.includes('stop'));
  assert.ok(stops.length >= 3, String(stops.length));
  for (const c of stops) {
    assert.equal(c.mayEnd, true, `${c.id}: expects stop, so it needs the tick`);
    const { steps, prompt } = casePrompt(c);
    assert.ok(steps.includes('stop'), `${c.id}: stop is offered`);
    assert.match(offered(prompt), /stop-session/, c.id);
  }
});

test('a note that asks for the stop, no tick: no stop is offered, so the nudged item is his with no call', () => {
  const c = CASES.find((x) => x.id === 'stuck-note-stop-no-tick');
  assert.ok(c, 'the case is there');
  assert.equal(c.mayEnd, undefined);
  assert.match(c.note, /stop it/);
  assert.deepEqual(c.expect, ['ask_owner']);
  const { item, steps } = casePrompt(c);
  assert.ok(item, 'the case builds an item');
  assert.ok(item.steps.includes('stop'), 'the table prepared stop');
  assert.deepEqual(steps, [], 'without the tick nothing is offered: the runner takes it as ask_owner with no call');
  // The same note with the tick offers it.
  assert.deepEqual(casePrompt({ ...c, mayEnd: true }).steps, ['stop']);
});

test('no case without the tick is offered stop', () => {
  for (const c of CASES.filter((x) => x.mayEnd !== true)) {
    const { steps } = casePrompt(c);
    if (steps) assert.ok(!steps.includes('stop'), c.id);
  }
});
