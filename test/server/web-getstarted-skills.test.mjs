// Get started's skills step in words a newcomer knows: "skill" said once in plain words, no "AI brain", no "link",
// and its button says what it does (Switch on).
import assert from 'node:assert/strict';
import test from 'node:test';
import '../chat/fakedom.mjs';

const { withBrainSkills, actionLabel } = await import('../../web/getstarted.js');

test('the skills step: what Claude Code knows, what is stored but not switched on, and a Switch on button', () => {
  const onb = { steps: [{ id: 'claude', done: true }, { id: 'skills', done: true, detail: '1 that Claude Code uses', action: null }], done: 2, total: 2 };
  const w = withBrainSkills(onb, 1);
  assert.equal(w.steps[1].detail, 'Claude Code knows 1 extra skill (a ready-made way of working). 1 more is stored but not switched on.');
  assert.equal(withBrainSkills(onb, 3).steps[1].detail, 'Claude Code knows 1 extra skill (a ready-made way of working). 3 more are stored but not switched on.');
  const two = withBrainSkills({ ...onb, steps: [onb.steps[0], { ...onb.steps[1], detail: '2 that Claude Code uses' }] }, 1);
  assert.match(two.steps[1].detail, /^Claude Code knows 2 extra skills \(/);
  const none = withBrainSkills({ steps: [{ id: 'skills', done: false, detail: 'none yet', action: { kind: 'page', target: 'settings/skills' } }], done: 0, total: 1 }, 2);
  assert.equal(none.steps[0].detail, '2 skills (a ready-made way of working) are stored but not switched on.');
  assert.equal(actionLabel(w.steps[1].action), 'Switch on');
  for (const s of [w, none]) assert.doesNotMatch(s.steps.at(-1).detail, /AI brain|link|used yet/i);
});
