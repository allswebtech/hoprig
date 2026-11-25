// The page "Before you format this computer" (web/leave.js) in the page tests' stand-in DOM (test/chat/fakedom.mjs),
// with stand-in answers of the dashboard: it shows the report's groups, a command with a copy button, Keep and
// Ignore, "Check it again", the last line and the press. Made-up values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/', protocol: 'http:', hostname: 'localhost' };
globalThis.window.dispatchEvent ||= () => true;
let answers = {};
const asked = [];
globalThis.fetch = async (u, o = {}) => {
  asked.push({ u, body: o.body ? JSON.parse(o.body) : undefined });
  const key = Object.keys(answers).find((k) => u.startsWith(k));
  const data = typeof answers[key] === 'function' ? answers[key](u, o) : answers[key];
  return { status: 200, ok: true, json: async () => data };
};
const { TITLE } = await import('../../web/leave.js');
const { pageById } = await import('../../web/registry.js');
const all = (n, ok) => (n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
test('the page: groups, the command to copy, Keep and Ignore, Check it again, the last line, the press', async () => {
  const page = pageById('leave');
  assert.equal(page.title, TITLE);
  assert.equal(TITLE, 'Before you format this computer');
  assert.equal(page.navAs, 'computers');
  const report = {
    at: '2026-11-24T00:00:00Z', cheap: false, nothingOnlyHere: false, last: '3 things exist only on this computer (above).',
    items: [{ id: 'branch:~/Workspace/projects/shop/code/web:feature/x', kind: 'branch', where: '~/Workspace/projects/shop/code/web', what: '2 commits on feature/x are on no git server', size: null, todo: 'push it', command: 'git -C ~/Workspace/projects/shop/code/web push -u origin feature/x', pushable: true }],
    asks: [{ id: 'dotfolder:~/.toolx', kind: 'dotfolder', where: '~/.toolx', size: 40 * 1024 * 1024, question: '~/.toolx holds 40 MB of a program\'s own data: keep (you back it up) or ignore?' }],
    outside: [{ where: '~/old', why: 'not checked, by your word' }],
    notChecked: [{ where: '~/big', why: 'at least 2 GB, not measured further' }],
  };
  answers = {
    '/api/workspace/onlyhere/push': { repos: [{ label: 'projects/shop/code/web', pushed: ['feature/x'], todo: [] }] },
    '/api/workspace/leave/mark': { ok: true, marks: {} },
    '/api/workspace/leave?run=': { run: 'a'.repeat(24), running: false, report },
    '/api/workspace/leave': { run: 'a'.repeat(24), running: true },
  };
  let shown = null;
  page.render({ frame: (o) => (shown = o), sub: '' });
  await settle();
  assert.match(shown.intro, /only reads: it never uploads, moves or deletes anything/);
  const root = { children: shown.body, className: '' };
  shown.primary.onclick();
  await settle();
  const t = texts(root).join('\n');
  for (const want of ['Work on no git server', '2 commits on feature/x are on no git server', 'git -C ~/Workspace/projects/shop/code/web push -u origin feature/x',
    'Keep (I back it up)', 'Ignore', 'Not checked, by your word: ~/old', 'Check it again', '3 things exist only on this computer (above).', 'at least 2 GB',
    'Push my other branches', 'never pushes a default branch']) assert.ok(t.includes(want), want);
  for (const gone of ['Look every day', 'Once a week']) assert.ok(!t.includes(gone), `no switch for a look that is not built: ${gone}`);
  const buttons = all(root, (n) => n.tag === 'button');
  const press = (label) => buttons.find((b) => texts(b).join('').includes(label)).listeners.click();
  assert.ok(buttons.some((b) => /^Copy: git -C/.test(b.attrs['aria-label'] || '')), 'a copy button names its command');
  await press('Keep (I back it up)');
  await settle();
  assert.deepEqual(asked.find((a) => a.u.endsWith('/leave/mark')).body, { kind: 'keep', what: '~/.toolx' });
  await press('Push my other branches');
  await settle();
  assert.ok(asked.some((a) => a.u.endsWith('/onlyhere/push')));
  assert.match(texts(root).join('\n'), /Pushed: feature\/x/);
  assert.ok(!asked.some((a) => /git -C/.test(a.u + JSON.stringify(a.body || ''))), 'the page never sends a command to run');
});
