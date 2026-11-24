// An administrator command's card asks its own question and shows the command once. plainCard (web/tia.js) takes the
// question from the card's form title ("Run an administrator command on <computer>?") and drops the quote, because the
// form's "Runs as administrator" row already shows the argv. A plain command keeps its own question and its quote.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from '../assistant/fake-dashboard.mjs';
import { hoprigVersion } from '../../src/handsoff.mjs';

// Just enough of a browser for the page's module to load (as web-tia-hidden.test.mjs).
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) { super(); Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const { plainCard } = await import('../../web/tia.js');

function setup() {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true };
  const ops = new FakeOps(state);
  ops.s.settings.server.herRights = { level: 'ask', version: hoprigVersion(), at: 1 };
  ops.adminPw = false; // a password field is not needed to see the title/quote
  const core = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }),
  });
  return { ops, core, call: (tool, args) => core.call(tool, args, { conversation: 'a1' }) };
}

test('an administrator command card: the question names it (no raw computer id), and the command is not quoted twice', async () => {
  const s = setup();
  const r = await s.call('run_command', { command: 'sudo apt-get update' });
  assert.equal(r.isError, false, r.text);
  const card = s.core.cards.pending()[0];
  assert.ok(card && card.form && card.form.fields.some((f) => f.label === 'Runs as administrator'), 'the admin card carries the argv row');
  // This computer: no "on …", and never the raw id "this", as every other card suppresses the computer for local.
  const local = plainCard(card, { accounts: s.ops.s.profiles });
  assert.equal(local.question, 'Run an administrator command?', 'the local question drops the computer');
  assert.doesNotMatch(local.question, /\bthis\b/, 'never the raw computer id "this"');
  assert.match(local.question, /administrator command/, 'it says it is an administrator command');
  assert.equal(local.quote, null, 'the command is not quoted again (the form row shows the argv)');
  // Another computer: named by its label (as `on` is everywhere else), not the raw machine id.
  const remote = plainCard(card, { accounts: s.ops.s.profiles, computerLabel: 'Box two' });
  assert.equal(remote.question, 'Run an administrator command on Box two?', 'a remote card names the computer by its label');
});

test('a plain command card keeps its own question and quotes the command', async () => {
  const s = setup();
  const r = await s.call('run_command', { command: 'npm test' });
  assert.equal(r.isError, false, r.text);
  const card = s.core.cards.pending()[0];
  const p = plainCard(card, { accounts: s.ops.s.profiles });
  assert.match(p.question, /^Run this command/, 'the plain card asks its own question');
  assert.equal(p.quote, 'npm test', 'and quotes the command');
});
