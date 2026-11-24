// "Use other providers": a part handed to another provider runs on its kind's model and effort from THAT provider's own
// list (the lead cannot choose them), as a helper of the lead does. Through the door's own route, with a stand-in chat.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('partkind');
test.after(() => box.cleanup());
const { writeProfile } = await import('../../src/profiles.mjs');
const { modelsFor, forgetModels } = await import('../../src/models/catalog.mjs');
const { partDoor } = await import('../../src/models/partdoor.mjs');
writeProfile('alpha', { label: 'Alpha', api: ['messages'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
const LIST = ['relay-haiku-1', 'relay-sonnet-2', 'relay-opus-3'];

function post(door, token, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); // Buffers, as a socket gives them
  Object.assign(req, { method: 'POST', url: '/api/parts', headers: { authorization: `Bearer ${token}` } });
  return new Promise((resolve) => {
    const res = { writeHead() {}, end: (t) => resolve(JSON.parse(t)) };
    door.handle(req, res);
  });
}

test('a part runs on its kind\'s model of the ticked provider\'s own list, not on what the lead or Settings say', async () => {
  forgetModels();
  await modelsFor('alpha', { fetchImpl: async () => new Response(JSON.stringify({ data: LIST.map((id) => ({ id })) }), { status: 200 }) });
  const opened = [];
  const rec = { id: 'L1', cwd: box.root, profile: 'team', permissionMode: 'manual', lead: true, others: ['alpha'], byTia: false };
  const chat = { open: async (b) => (opened.push(b), { sent: true, id: `c${opened.length}` }), peek: () => ({ busy: false }), notice() {}, event() {}, recordOf: () => rec };
  const door = partDoor({ chat, config: () => ({ automation: { schedules: { atOnce: 4 } } }), models: async () => null });
  door.setAddress('http://127.0.0.1:9');
  door.configFor({ id: 'L1', lead: true, others: ['alpha'] });
  const fs = await import('node:fs');
  const path = await import('node:path');
  const token = fs.readFileSync(path.join(box.state, 'part-servers', 'L1.token'), 'utf8').trim();
  const first = await post(door, token, { action: 'start', provider: 'alpha', kind: 'coder', brief: 'add it', model: 'relay-opus-3' });
  assert.match(first.text || '', /^Started part/, JSON.stringify(first));
  assert.ok(!(await post(door, token, { action: 'start', provider: 'alpha', kind: 'runner', brief: 'find the TODOs' })).isError);
  assert.ok(!(await post(door, token, { action: 'start', provider: 'alpha', brief: 'no kind' })).isError);
  assert.deepEqual(opened.map((b) => [b.profile, b.model, b.effort]), [['alpha', 'relay-sonnet-2', 'medium'], ['alpha', 'relay-haiku-1', 'low'], ['alpha', 'relay-sonnet-2', 'medium']]);
});
