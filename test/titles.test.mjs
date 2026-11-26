// A session's name as Claude Code names its conversation (src/titles.mjs): the title lines Claude Code appends after
// the start (ai-title, custom-title), wherever they are in the file and the newest of each; a name given in Hoprig
// that wins over a later generated title and survives a restart; the first words until a title exists.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './server/helpers.mjs';

const box = sandbox('titles');
test.after(() => box.cleanup());
const T = await import('../src/titles.mjs');
const S = await import('../src/sessions.mjs');

const ID = '3b0c2f4e-1111-4a2b-8c3d-000000000001';
const line = (o) => `${JSON.stringify(o)}\n`;
const user = (text) => line({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const big = (kb) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(kb * 1024) }] } });
const ai = (t) => line({ type: 'ai-title', aiTitle: t, sessionId: ID });
const custom = (t) => line({ type: 'custom-title', customTitle: t, sessionId: ID });
// Each change is written a moment later, so its mtime differs as it does on a real disk.
const later = (f) => {
  const t = new Date(fs.statSync(f).mtimeMs + 1000);
  fs.utimesSync(f, t, t);
};

function convo(name, ...parts) {
  const f = path.join(box.claude, 'projects', '-work-shop', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, parts.join(''));
  return f;
}
const add = (f, ...parts) => {
  fs.appendFileSync(f, parts.join(''));
  later(f);
};

test('a title line after 256 KB of the conversation is found, and the newest of a title that changes twice wins', () => {
  const f = convo(ID, user('Fix the cart total'), big(300), ai('Cart total fix'));
  assert.equal(T.conversationTitle(f).title, 'Cart total fix', 'after the first 256 KB, where the old reader stopped');
  assert.equal(S.sessionTitle(f), 'Cart total fix', 'the lists\' reader says the same');
  add(f, big(10), ai('Cart total and discount'));
  assert.equal(T.sessionName(f, ID), 'Cart total and discount', 'changed once');
  add(f, big(10), ai('Discount rules for the cart'));
  assert.equal(T.sessionName(f, ID), 'Discount rules for the cart', 'changed twice: the newest');
});

test('the newest title is read without reading the whole file again', () => {
  const f = convo('3b0c2f4e-1111-4a2b-8c3d-000000000002', user('hello'), big(2000));
  assert.equal(T.conversationTitle(f).title, 'hello', 'the first words until a title exists');
  // The file's head is overwritten in place with the same size' worth of garbage: a reader that started again from
  // the start would lose the first words; one that reads only what was added keeps them and finds the new title.
  const fd = fs.openSync(f, 'r+');
  fs.writeSync(fd, Buffer.alloc(100, 0x20), 0, 100, 0);
  fs.closeSync(fd);
  add(f, ai('Greeting'));
  assert.equal(T.conversationTitle(f).first, 'hello', 'only the added bytes were read');
  assert.equal(T.conversationTitle(f).title, 'Greeting');
});

test('a rename in Claude Code wins over its generated title, also one written after it', () => {
  const id = '3b0c2f4e-1111-4a2b-8c3d-000000000003';
  const f = convo(id, user('Fix the login'), ai('Login fix'), custom('auth-refactor'));
  assert.equal(T.sessionName(f, id), 'auth-refactor');
  add(f, ai('Login and session fix'));
  assert.equal(T.sessionName(f, id), 'auth-refactor', 'a name given is not replaced by a later generated title');
  add(f, custom('auth-v2'));
  assert.equal(T.sessionName(f, id), 'auth-v2', 'renamed again in Claude Code');
});

test('the person\'s newest rename wins, wherever it was typed (here, or /rename in the coding tool); a generated title never wins over a rename', () => {
  const id = '3b0c2f4e-1111-4a2b-8c3d-000000000004';
  const f = convo(id, user('Write the release notes'), ai('Release notes'));
  T.setOwnName(id, 'Notes for 1.4', f);
  add(f, ai('Release notes draft'));
  assert.equal(T.sessionName(f, id), 'Notes for 1.4', 'a later title of Claude Code\'s model does not replace it');
  const kept = JSON.parse(fs.readFileSync(path.join(box.state, 'session-names.json'), 'utf8'));
  assert.equal(kept[id].title, 'Notes for 1.4', 'kept in the state folder');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(box.state, 'session-names.json')).mode & 0o777, 0o600);
  // A restart: another process reads the same state folder.
  const after = execFileSync(process.execPath, ['--input-type=module', '-e', `import('${new URL('../src/titles.mjs', import.meta.url).href}').then((T) => process.stdout.write(T.sessionName(${JSON.stringify(f)}, ${JSON.stringify(id)})))`], { env: process.env }).toString();
  assert.equal(after, 'Notes for 1.4', 'after a restart');
  add(f, custom('notes-final'));
  assert.equal(T.sessionName(f, id), 'notes-final', 'the person renamed it in Claude Code afterwards: that is newer');
  add(f, ai('Release notes, final'));
  assert.equal(T.sessionName(f, id), 'notes-final', 'a generated title after it does not win over that rename either');
  T.setOwnName(id, 'Notes 1.4 shipped', f);
  assert.equal(T.sessionName(f, id), 'Notes 1.4 shipped', 'renamed here again: the newest rename, here');
  add(f, ai('Shipping notes'));
  assert.equal(T.sessionName(f, id), 'Notes 1.4 shipped', 'and no generated title wins over it');
});

test('a new session shows its first words, not a machine-made turn; names are one line of at most 200 characters', () => {
  const id = '3b0c2f4e-1111-4a2b-8c3d-000000000005';
  const f = convo(id, line({ type: 'user', isMeta: true, message: { content: 'Caveat: x' } }), user('<command-name>/model</command-name>'), user('Add a dark theme\nto the shop'));
  assert.equal(T.sessionName(f, id), 'Add a dark theme to the shop');
  add(f, custom(`a\u0007b${'n'.repeat(300)}`));
  const n = T.sessionName(f, id);
  assert.equal(n.length, 200);
  assert.ok(n.startsWith('a b'), 'a control character becomes a space');
  T.setOwnName('not-an-id', 'x');
  assert.equal(T.ownName('not-an-id'), '', 'only a conversation id is kept');
});
