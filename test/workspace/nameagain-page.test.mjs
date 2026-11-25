// This computer's name again after a format, from the dashboard (web/wscomputer.js labelForm, web/workspace.js
// nameLine): Settings → Workspace, while this computer has no name, takes one; a name another computer's file holds
// asks "Is this computer <name>, set up again?" and only the press of that yes sends again: true to
// POST /api/workspace/label (the step of `hoprig workspace label <name> --again`). After "Bring my workspace from git",
// a computer with no name gets one line that leads there; one with a name gets none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement, byClass, texts } from '../chat/fakedom.mjs';

let label = null;
const posts = [];
globalThis.fetch = async (u, o = {}) => {
  const p = String(u);
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  if (p === '/api/workspace/computers') return reply(200, { label, suggestion: 'box2', computers: [] });
  if (p === '/api/workspace/label' && o.method === 'POST') {
    const b = JSON.parse(o.body);
    posts.push(b);
    if (!b.again) return reply(409, { error: 'the label alpha is taken: another computer\'s file (ai_brain/computers/alpha.json) holds another id', code: 'ETAKEN' });
    label = b.label;
    return reply(200, { label: b.label, state: 'back' });
  }
  return reply(404, { error: 'no such route' });
};
const settle = () => new Promise((r) => setTimeout(r, 30));
const find = (n, pred) => (n instanceof FakeElement ? (pred(n) ? n : n.children.map((c) => find(c, pred)).find(Boolean)) : null);
const press = async (b) => {
  await b.listeners.click({ currentTarget: b });
  await settle();
};
const { computerPanel } = await import('../../web/wscomputer.js');
const { nameLine } = await import('../../web/workspace.js');

test('a name another computer holds: the question, and only its yes sends again: true', async () => {
  const el = computerPanel();
  await settle();
  const input = find(el, (n) => n.tag === 'input');
  assert.ok(input, 'the name field is shown while this computer has no name');
  input.value = 'alpha';
  await press(find(el, (n) => n.tag === 'button' && texts(n).join('') === 'Save'));
  assert.deepEqual(posts.at(-1), { label: 'alpha' }, 'the first press never says again');
  const words = texts(el).join(' ');
  assert.match(words, /alpha is the name of another computer of yours\. Is this computer alpha, set up again \(after a format, for example\)\? Its list of what is here then starts empty\./);
  const yes = byClass(el, 'btn').find((b) => texts(b).join('') === 'Yes, this is alpha');
  assert.ok(yes, 'the yes is its own press');
  assert.equal(posts.length, 1, 'nothing more sent before it');
  await press(yes);
  assert.deepEqual(posts.at(-1), { label: 'alpha', again: true });
  assert.match(texts(el).join(' '), /This computer is\s+alpha\s+in your workspace/);
});

test('after a restore: one line to Settings → Workspace while this computer has no name, none once it has one', async () => {
  label = null;
  let box = nameLine();
  await settle();
  const t = texts(box).join('');
  assert.match(t, /This computer has no name in your workspace yet\. Give it one, or the name it had before a format, in Settings → Workspace\./);
  assert.ok(find(box, (n) => n.tag === 'a' && /#\/settings\/workspace$/.test(n.attrs.href || '')), 'a link to it');
  label = 'alpha';
  box = nameLine();
  await settle();
  assert.equal(box.children.length, 0);
  const src = fs.readFileSync(new URL('../../web/workspace.js', import.meta.url), 'utf8');
  assert.match(src, /r\.data\.projectsDir \? h\('p\.hint', `Projects are in \$\{tildePath\(r\.data\.projectsDir\)\}\.`\) : null,\n\s+nameLine\(close\),/, 'the restore sheet\'s result holds it');
});
