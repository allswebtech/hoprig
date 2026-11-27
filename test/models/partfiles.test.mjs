// "Use other providers": nothing is left behind and nothing is lost in silence. A Lead chat's part token and its config
// file are removed when the chat ends (closed, deleted to the trash, replaced); files an earlier run of the dashboard
// left are removed at its start; a chat opened before the dashboard started says in one line that its earlier parts
// are no longer followed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('partfiles');
test.after(() => box.cleanup());
const { partDoor } = await import('../../src/models/partdoor.mjs');
const dir = path.join(box.state, 'part-servers');
const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const chatOf = (id, openedAt = Date.now() + 1000) => Object.assign(new EventEmitter(), { id, lead: true, others: ['alpha'], openedAt, pushed: [], push(ev) { this.pushed.push(ev); } });

test('a chat\'s token and config file go when the chat ends', () => {
  const door = partDoor({ chat: {}, config: () => ({}) });
  door.setAddress('http://127.0.0.1:9');
  const a = chatOf('11111111-1111-4111-8111-111111111111');
  const b = chatOf('22222222-2222-4222-8222-222222222222');
  assert.ok(door.configFor(a) && door.configFor(b));
  door.configFor(a); // a start again: still one pair of files, one follower
  assert.equal(files().length, 4);
  assert.equal(a.listenerCount('closed'), 1);
  a.emit('closed');
  assert.deepEqual(files(), [`${b.id}.json`, `${b.id}.token`], 'only the ended chat\'s files are gone');
  b.emit('closed');
  assert.deepEqual(files(), [], 'the folder is empty after');
});

test('at the start, files an earlier run left are removed; a chat from before says once that its parts are not followed', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '33333333-3333-4333-8333-333333333333.token'), 'hpt_old\n');
  fs.writeFileSync(path.join(dir, 'not-ours.txt'), 'x');
  const door = partDoor({ chat: {}, config: () => ({}) });
  door.start();
  assert.deepEqual(files(), ['not-ours.txt'], 'only its own kind of file');
  fs.rmSync(path.join(dir, 'not-ours.txt'));
  door.setAddress('http://127.0.0.1:9');
  const old = chatOf('44444444-4444-4444-8444-444444444444', Date.now() - 60_000);
  door.configFor(old);
  door.configFor(old);
  assert.equal(old.pushed.length, 1, 'said once');
  assert.match(old.pushed[0].text, /^Hoprig restarted\. Parts this chat handed to other models before that are no longer shown here/);
  assert.equal(old.pushed[0].topic, 'parts-restart', 'the page shows it only where a part was handed');
  const fresh = chatOf('55555555-5555-4555-8555-555555555555');
  door.configFor(fresh);
  assert.equal(fresh.pushed.length, 0, 'a chat opened since says nothing');
  old.emit('closed');
  fresh.emit('closed');
  assert.deepEqual(files(), []);
});
