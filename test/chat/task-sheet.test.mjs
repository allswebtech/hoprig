// A background task's output sheet (web/chat/agents.js openTaskOutput) follows the task's state as the chat reports it:
// once the task is stopped, the sheet says so and its Stop is gone, without waiting for its next read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

const kept = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) } });
// The sheet's dialog: opens, and says so when closed.
const { FakeElement } = await import('./fakedom.mjs');
FakeElement.prototype.showModal = function showModal() { this.open = true; };
FakeElement.prototype.close = function close() { this.open = false; };
const Ag = await import('../../web/chat/agents.js');

const shell = { taskId: 'b1', type: 'shell', status: 'running', title: 'npm run dev', background: true, startedAt: 1000 };
const settle = () => new Promise((r) => setImmediate(r));
const sheetText = () => texts(document.body).join(' ');
const stops = () => document.body.querySelectorAll('button.chat-taskstop');

test('the sheet of a task that was stopped there says so at once and loses its Stop', async () => {
  let out = 'listening on 3000';
  const calls = [];
  const s = Ag.agentsStrip({ stop: async (id) => { calls.push(id); out = 'listening on 3000\n[killed]'; }, jump() {}, output: async () => ({ text: out }) });
  s.paint([shell]);
  byClass(s.el, 'chat-bg-line')[0].listeners.click();
  await settle();
  document.body.querySelectorAll('button[aria-label="Output of npm run dev"]')[0].listeners.click(); // the tasks sheet, then the task's output
  await settle();
  assert.match(sheetText(), /running/);
  assert.equal(stops().length, 1);
  stops()[0].listeners.click({ preventDefault() {}, stopPropagation() {}, currentTarget: stops()[0] });
  await settle();
  await settle();
  assert.deepEqual(calls, ['b1']);
  assert.match(sheetText(), /\[killed\]/);
  // The chat reports the task as stopped: the sheet follows now, not at its next timed read.
  s.paint([{ ...shell, status: 'stopped' }]);
  assert.doesNotMatch(sheetText(), /running/);
  assert.match(sheetText(), /stopped/);
  assert.equal(stops().length, 0, 'no Stop for a task that ended');
  s.stopClock?.();
});
