// The note about the AI brain's links says the word of the page it stands on: on Skills (the stored skills) its button
// and sheet say Switch on; on the AI brain page's Coding tools part of an older computer (no per-tool state), the note
// about rules and memory says Link and opens Link the AI brain, as that page's own button does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeElement, texts } from '../chat/fakedom.mjs';

FakeElement.prototype.showModal = function () {
  this.open = true;
};
FakeElement.prototype.close = function () {
  this.open = false;
  this.listeners.close?.();
};
globalThis.location ||= { hash: '#/brain', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {} });
// An older computer: the plan has no per-tool state (no `tools`).
const plan = { brain: '~/Workspace/ai_brain', todo: 2, entries: [
  { id: 'rules', action: 'link', tool: 'claude', tools: ['claude'], what: 'your rules' },
  { id: 'skills', action: 'link', tool: 'claude', tools: ['claude'], what: 'your skills' },
  { id: 'memory', action: 'link', tool: 'claude', tools: ['claude'], what: 'your memory' },
] };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plan });

const { linkBrainNote, toolsPart } = await import('../../web/brainlink.js');
const tick = () => new Promise((r) => setTimeout(r, 30));
const buttons = (n) => n.querySelectorAll('button').map((b) => texts(b).join('').trim());
const press = async (box, label) => {
  const b = box.querySelectorAll('button').find((x) => texts(x).join('').trim() === label);
  b.listeners.click({ currentTarget: b, preventDefault() {} });
  await tick();
  const d = document.body.querySelector('dialog');
  return texts(d.querySelector('h2')).join('');
};

test('the AI brain page of an older computer: the note says Link and opens Link the AI brain', async () => {
  const box = toolsPart();
  document.body.append(box);
  await tick();
  await tick();
  assert.deepEqual(buttons(box), ['Link']);
  assert.equal(await press(box, 'Link'), 'Link the AI brain');
  document.body.querySelector('dialog').close();
  box.remove();
});

test('Skills: the note about the stored skills says Switch on and opens Switch on your stored skills', async () => {
  const box = linkBrainNote({ only: ['skills'], switchOn: true });
  document.body.append(box);
  await tick();
  assert.deepEqual(buttons(box), ['Switch on']);
  assert.equal(await press(box, 'Switch on'), 'Switch on your stored skills');
  document.body.querySelector('dialog').close();
  box.remove();
});

test('Memory: the banner says in one plain line what switching on does', async () => {
  const box = linkBrainNote({ switchOn: true });
  document.body.append(box);
  await tick();
  const said = texts(box.querySelector('.bl-note-text')).join('');
  assert.equal(said, 'Switch on so your coding tools use these rules, skills and memory. Nothing is deleted.');
  assert.doesNotMatch(said, /AI brain|does not read/);
  box.remove();
});
