// list_sessions names each session as he knows it: a chat by its title ("a chat in <folder>" without one), a terminal
// by its own name; the id stays beside it. Her description tells her to name a session by that, never by its id.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const A = '9fe5301d-51bb-496b-b227-938bcfa82c7c';
const B = 'fb7c0b46-051e-45d5-b1f7-07644ac6781a';

test('a chat gets its title as name, an untitled chat "a chat in <folder>", a terminal its own name', async () => {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true };
  s.sessions.push(
    { computer: 'this', name: `chat:${A}`, kind: 'chat', chatId: A, status: 'waiting', cwd: '/home/owner/projects/shop', title: 'Fix the cart total' },
    { computer: 'this', name: `chat:${B}`, kind: 'chat', chatId: B, status: 'waiting', cwd: '/home/owner/projects/shop', title: '' },
  );
  const now = Date.now;
  const core = createAssistantCore({ ops: new FakeOps(s), now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
  const r = await core.call('list_sessions', {}, { conversation: 'c1' });
  assert.equal(r.isError, false, r.text);
  const json = /<untrusted_data tool="list_sessions">([\s\S]*?)<\/untrusted_data>/.exec(r.text);
  assert.ok(json, r.text);
  const list = JSON.parse(json[1]).sessions;
  const by = (id) => list.find((x) => x.session === id);
  assert.equal(by(`chat:${A}`).name, 'Fix the cart total');
  assert.equal(by(`chat:${B}`).name, 'a chat in shop');
  assert.equal(by('api-fix').name, 'api-fix');
  assert.ok(list.every((x) => typeof x.name === 'string' && x.name && x.session), 'every one has a name beside its id');
});

test('the description tells her to name a session by its name, never by its id', () => {
  assert.match(byName.get('list_sessions').description, /call it by its name \(a chat's title\), never by its id/);
});
