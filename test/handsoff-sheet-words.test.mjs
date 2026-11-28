// The first-time sheet (web/handsoff.js consentSheetBody) and the page (docs/HANDS-OFF.md, "What Hands-off answers")
// say what Hands-off answers for a question with no mark and for a plan in the same words, and the code
// (src/handsoff.mjs decide, src/hook.mjs handsOffFor) does what those words say.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

const { consentSheetBody } = await import('../web/handsoff.js');
const { decide } = await import('../src/handsoff.mjs');
const { handsOffFor } = await import('../src/hook.mjs');

const flat = (s) => s.replace(/\s+/g, ' ');
const sheet = () => flat(consentSheetBody(() => {}).flatMap(texts).join(' '));
const page = () => flat(fs.readFileSync(new URL('../docs/HANDS-OFF.md', import.meta.url), 'utf8'));

// The sentences both say, word for word.
const SAME = [
  'If the tool has not marked a recommended answer, it gives your note for the project (Settings → Hands-off) as a written answer where the tool takes one; without a note that question still waits for you.',
  'A plan in the App is approved, and the session keeps the mode it had',
  'A plan in a terminal waits for you.',
];

test('the first-time sheet and the page say what is answered with no mark and for a plan in the same words', () => {
  const s = sheet();
  const p = page();
  for (const words of SAME) {
    assert.ok(s.includes(words), `the sheet says: ${words}`);
    assert.ok(p.includes(words), `the page says: ${words}`);
  }
  assert.doesNotMatch(s, /If the tool has not marked a recommended answer, that question still waits for you/, 'the old sentence, which left out the note, is gone');
});

const question = (o = {}) => ({ kind: 'question', questions: [{ question: 'Which runner?', options: [{ label: 'node:test' }, { label: 'vitest' }], recommended: null, freeText: true, ...o }] });

test('a question with no mark: the note as a written answer where the tool takes one, else it waits', () => {
  assert.deepEqual(decide(question(), { note: 'Choose the fewest new dependencies.' }), { answer: { answers: { 'Which runner?': 'Choose the fewest new dependencies.' } }, because: 'note' });
  assert.deepEqual(decide(question(), { note: '' }), { wait: 'no-mark' }, 'without a note it waits');
  assert.deepEqual(decide(question(), { note: '   ' }), { wait: 'no-mark' }, 'a note of spaces is no note');
  assert.deepEqual(decide(question({ freeText: false }), { note: 'Choose the fewest new dependencies.' }), { wait: 'no-free-text' }, 'a tool that takes no written answer waits');
  const marked = question({ recommended: 1, options: [{ label: 'node:test' }, { label: 'vitest (Recommended)' }] });
  assert.equal(decide(marked, { note: 'any' }).because, 'recommended', 'a marked option goes before the note');
});

test('a plan: approved in the App with the mode it had, never a wider one; it waits in a terminal', () => {
  const plan = { kind: 'plan', plan: 'Add a test for the cart total.' };
  assert.deepEqual(decide(plan, { mode: 'acceptEdits' }), { answer: { mode: 'acceptEdits' }, because: 'plan' });
  assert.deepEqual(decide(plan, { mode: 'default' }), { answer: { mode: 'manual' }, because: 'plan' }, 'no wider mode than it had');
  const version = '9.9.9';
  const cfg = { handsOff: { projects: { '/w/shop': { on: true, version, at: 1 } } } };
  const ev = { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'Add a test.' } };
  const run = { runId: 'r1', cwd: '/w/shop' };
  // Hands-off is not offered on Windows (handsOffOffered), so the hook gives no answer and no wait there.
  if (process.platform !== 'win32') assert.deepEqual(handsOffFor(ev, run, { cfg, version, runId: 'r1', project: '/w/shop' }), { wait: 'plan-terminal' }, 'a plan in a terminal waits for him');
});
