// What Tia reads of a session or a chat never holds a value of the files a project's credential links point at: a
// coding tool in a session can be asked to show such a file, and its screen goes to her provider. Marker values here
// are made up. The owner's own page (the dashboard's history route) is not touched by this.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const box = sandbox('safety-mask');
test.after(() => box.cleanup());

const ws = fs.realpathSync(box.workspace);
const MARK1 = ['MARKER-sk', 'live', '4f9a1c7e0b2d8a63'].join('-');
const MARK2 = 'MARKER-hunter2-passphrase-77';
const MARK3 = 'MARKER-pem-line-abcdefghijkl0123';
const creds = path.join(ws, 'credentials');
fs.mkdirSync(path.join(creds, 'shop'), { recursive: true });
fs.mkdirSync(path.join(creds, 'other'), { recursive: true });
fs.writeFileSync(path.join(creds, 'shop', 'shop.env.local'), `# keys\nexport SHOP_KEY=${MARK1}\nDB_PASSWORD="${MARK2}"\nPORT=3000\nDEBUG=true\n`, { mode: 0o600 });
fs.writeFileSync(path.join(creds, 'shop', 'deploy.key'), `-----BEGIN PRIVATE KEY-----\n${MARK3}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
fs.writeFileSync(path.join(creds, 'other', 'unlinked.env'), 'UNLINKED_KEY=MARKER-not-linked-by-any-project-1\n', { mode: 0o600 });
const proj = path.join(ws, 'projects', 'shop');
fs.mkdirSync(path.join(proj, 'code', 'shop'), { recursive: true });
fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ name: 'shop', repos: [{ dir: 'code/shop' }], credentials: { 'code/shop/.env.local': 'shop/shop.env.local', 'code/shop/deploy.key': 'shop/deploy.key' } }));

const { maskValues, valuesOfText, HIDDEN, forgetValues } = await import('../../src/assistant/maskvalues.mjs');
const BUILTIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'skills');

function setup(screens, extra = []) {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'work' };
  s.screens = { ...s.screens, ...screens };
  s.sessions.push(...extra);
  const ops = new FakeOps(s);
  const core = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }),
  });
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  return { call: async (tool, args) => (await call('list_sessions', {}), call(tool, args)) };
}

test('values of an env file, a key file and a JSON file are found; short words are not', () => {
  assert.deepEqual(valuesOfText(`A=${MARK1}\nB='${MARK2}'\nC=3000\nD=true\n# E=commented-out-secret-value\n`).sort(), [MARK1, MARK2].sort());
  assert.deepEqual(valuesOfText(`-----BEGIN X-----\n${MARK3}\n-----END X-----\n`).includes(MARK3), true);
  assert.deepEqual(valuesOfText(JSON.stringify({ key: MARK1, n: 5, nested: { p: MARK2 } })).sort(), [MARK1, MARK2].sort());
});

test('maskValues hides the values of the linked files only, also a value broken over two lines', async () => {
  forgetValues();
  const text = `$ cat .env.local\nSHOP_KEY=${MARK1}\nDB_PASSWORD="${MARK2}"\nPORT=3000\n${MARK3.slice(0, 20)}\n${MARK3.slice(20)}\nUNLINKED_KEY=MARKER-not-linked-by-any-project-1\n`;
  const out = await maskValues(text);
  for (const m of [MARK1, MARK2, MARK3]) assert.ok(!out.includes(m), `${m} is gone`);
  assert.ok(!out.includes(MARK3.slice(20)), 'the wrapped value is gone');
  assert.ok(out.includes(HIDDEN));
  assert.ok(out.includes('PORT=3000') && out.includes('SHOP_KEY='), 'the rest stays');
  assert.ok(out.includes('MARKER-not-linked-by-any-project-1'), 'a file no project links to is not this rule');
});

test('read_session of a terminal hides the values, and says nothing of where they came from', async () => {
  forgetValues();
  const { call } = setup({ 'this|api-fix': `> cat .env.local\nSHOP_KEY=${MARK1}\nDB_PASSWORD="${MARK2}"\n> ` });
  const r = await call('read_session', { session: 'api-fix' });
  assert.equal(r.isError, false, r.text);
  for (const m of [MARK1, MARK2]) assert.ok(!r.text.includes(m), `${m} is not in her answer`);
  assert.ok(r.text.includes('SHOP_KEY='), 'the line is there, its value is not');
});

test('read_session and list_sessions of a chat hide the values in its last reply', async () => {
  forgetValues();
  const ID = '44444444-4444-4444-8444-444444444444';
  const chat = { computer: 'this', name: `chat:${ID}`, kind: 'chat', chatId: ID, title: 'Look at the env', status: 'waiting', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/web', lastMessage: `The file says SHOP_KEY=${MARK1} and the password is ${MARK2}.`, note: '', limit: null, sessionId: ID, statusAt: Date.now() };
  const { call } = setup({}, [chat]);
  for (const [tool, args] of [['read_session', { session: `chat:${ID}` }], ['list_sessions', {}]]) {
    const r = await call(tool, args);
    assert.equal(r.isError, false, r.text);
    for (const m of [MARK1, MARK2]) assert.ok(!r.text.includes(m), `${tool}: ${m} is not in her answer`);
  }
});

test('a computer without the credentials folder or without links masks nothing and does not fail', async () => {
  forgetValues();
  assert.equal(await maskValues('plain text', { dir: path.join(box.root, 'nowhere'), projects: path.join(box.root, 'nowhere', 'projects') }), 'plain text');
});
