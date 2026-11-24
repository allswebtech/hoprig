// The Sessions card: a row's second line is "<folder> · <the computer's label>", and it is left out where it would only
// say the first line again ("shop / shop").
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { cardOf } from '../../src/assistant/cardmake.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

async function rows(state) {
  const s = state(baseState());
  s.assistant = { ...s.assistant, enabled: true };
  const now = Date.now;
  const ops = new FakeOps(s);
  const jobs = new JobStore({ dir: null, now });
  const result = await byName.get('list_sessions').run(ops, {}, { now, jobs: { forSession: () => null, list: () => [] }, tia: async () => s.assistant });
  return cardOf('list_sessions', {}, result, { now, jobs }).fields.items;
}

test('a terminal named as its folder: no second line on one computer; the label of the computer where there are several', async () => {
  const one = await rows((s) => {
    s.sessions = [{ computer: 'this', name: 'shop', kind: 'claude', status: 'working', cwd: '/home/owner/projects/shop', title: '' }];
    return s;
  });
  assert.deepEqual(one.map((r) => [r.label, r.sub]), [['shop', undefined]]);
  const two = await rows((s) => {
    s.sessions = [
      { computer: 'this', name: 'shop', kind: 'claude', status: 'working', cwd: '/home/owner/projects/shop', title: '' },
      { computer: 'box2', name: 'blog', kind: 'claude', status: 'waiting', cwd: '/home/owner/projects/blog', title: 'Fix the menu' },
    ];
    return s;
  });
  assert.deepEqual(two.map((r) => [r.label, r.sub]), [['shop', 'Laptop'], ['Fix the menu', 'blog · Build box']]);
  assert.ok(two.every((r) => !/\bbox2\b|\bthis\b/.test(r.sub)), 'never the inner id');
});

test('a chat with a title: its folder under it, never its id', async () => {
  const id = '9fe5301d-51bb-496b-b227-938bcfa82c7c';
  const r = await rows((s) => {
    s.sessions = [{ computer: 'this', name: `chat:${id}`, kind: 'chat', chatId: id, status: 'waiting', cwd: '/home/owner/projects/shop', title: 'Fix the cart total' }];
    return s;
  });
  assert.deepEqual(r.map((x) => [x.label, x.sub]), [['Fix the cart total', 'shop']]);
});

test('through her core too: the card a list_sessions call makes', async () => {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true };
  const now = Date.now;
  const cards = new CardStore({ now });
  const core = createAssistantCore({ ops: new FakeOps(s), now, cards, audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
  const r = await core.call('list_sessions', {}, { conversation: 'c1' });
  const view = (r.views || []).find((v) => v.kind === 'list') || (r.view && r.view.kind === 'list' ? r.view : null);
  assert.ok(view, JSON.stringify(Object.keys(r)));
  const subs = view.items.map((x) => x.sub);
  assert.ok(subs.includes('api · Laptop'), subs.join(' | '));
  assert.ok(subs.some((x) => /Build box/.test(x || '')), subs.join(' | '));
});
