// Two items with one id (two computers that added the same title, merged by git): every action names an item by its
// place and its id together, so the right one changes; the save's plan lists every changed item; the page is offered
// "Give the doubles new ids" (a change like any other, shown in the plan); the command refuses an id two items share.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-doubles');
test.after(() => t.cleanup());
// tempWork() gave this server a workspace of its own (never the real one, which a dashboard maps when it starts).
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { main } = await import('../../src/work/cli.mjs');
const { savePlan } = await import('../../src/work/save.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');

const item = (title, extra = {}) => ({ id: 'book-the-hall', date: null, approx: false, title, kind: 'task', by: 'me', status: 'open', source: 'me', ...extra });
const listText = `${JSON.stringify({ items: [item('Book the hall'), { id: 'other', title: 'Something else', status: 'open' }, item('Book the hall', { note: 'from the second computer' })] }, null, 2)}\n`;
t.repo(t.brain, { 'README.md': '# brain\n', 'work/tasks.json': listText });
const file = path.join(t.brain, 'work', 'tasks.json');
const items = () => JSON.parse(fs.readFileSync(file, 'utf8')).items;

test('the page: Done on the second of two tasks with one id marks the second; the plan lists it; fix-ids', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => (await fetch(origin + p, { headers: { Cookie: cookie } })).json();
    const post = async (p, body) => {
      const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const w = await get('/api/work');
    assert.deepEqual(w.doubles, [{ id: 'book-the-hall', count: 2, titles: ['Book the hall', 'Book the hall'] }]);
    const second = w.items.find((x) => x.note === 'from the second computer');
    assert.equal(second.at, 2);
    const r = await post('/api/work/items/book-the-hall/status', { at: second.at, status: 'done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(items().map((x) => x.status), ['open', 'open', 'done'], 'the second one, not the first');
    // A place that no longer holds that id: refused, nothing changed.
    assert.equal((await post('/api/work/items/book-the-hall/status', { at: 1, status: 'done' })).status, 409);
    assert.equal((await post('/api/work/items/book-the-hall/remove', { at: 2 })).status, 200);
    assert.deepEqual(items().map((x) => x.title), ['Book the hall', 'Something else']);
    fs.writeFileSync(file, listText);

    // Both changed: the plan lists both.
    await post('/api/work/items/book-the-hall/status', { at: 0, status: 'done' });
    await post('/api/work/items/book-the-hall/status', { at: 2, status: 'dropped' });
    const plan = await savePlan(resolvePlace({}));
    assert.deepEqual(plan.changes.map((c) => [c.key, c.what]), [['book-the-hall#0', 'done'], ['book-the-hall#1', 'dropped']]);
    fs.writeFileSync(file, listText);

    // Give the doubles new ids: a change like any other, shown in the plan as a new id.
    const fixed = await post('/api/work/fix-ids', {});
    assert.deepEqual(fixed.body.fixed, [{ from: 'book-the-hall', to: 'book-the-hall-2', title: 'Book the hall' }]);
    assert.deepEqual(items().map((x) => x.id), ['book-the-hall', 'other', 'book-the-hall-2']);
    assert.equal((await get('/api/work')).doubles, undefined);
    const p2 = await savePlan(resolvePlace({}));
    assert.deepEqual(p2.changes.map((c) => [c.id, c.what, c.from]), [['book-the-hall-2', 'new id', 'book-the-hall']]);
    fs.writeFileSync(file, listText);
  } finally {
    await app.close();
  }
});

test('the command refuses an id that two tasks share, names both and says how to fix it', async () => {
  let out = '';
  let err = '';
  const run = async (...args) => {
    out = '';
    err = '';
    return main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) });
  };
  assert.equal(await run('done', 'book-the-hall'), 1);
  assert.match(err, /2 items share the id "book-the-hall" \("Book the hall" and "Book the hall"\).*hoprig tasks fix-ids/);
  assert.equal(fs.readFileSync(file, 'utf8'), listText, 'nothing changed');
  for (const cmd of [['remove', 'book-the-hall'], ['edit', 'book-the-hall', '--title', 'Another title']]) assert.equal(await run(...cmd), 1, cmd.join(' '));
  assert.equal(fs.readFileSync(file, 'utf8'), listText);
  assert.equal(await run('fix-ids'), 0);
  assert.match(out, /book-the-hall → book-the-hall-2 {2}Book the hall/);
  assert.equal(await run('done', 'book-the-hall-2'), 0, err);
  assert.deepEqual(items().map((x) => x.status), ['open', 'open', 'done']);
});
