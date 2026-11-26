// "Remove the old folders" from the page, after Arrange (POST /api/adopt/retire/check and /api/adopt/retire,
// src/adopt/retireweb.mjs): retire's own look and words, a one-use ticket for ten minutes, the project's name typed and
// compared on the server, retire itself doing the removal. In a made-up computer in a temporary home: the look changes
// nothing; a stale ticket, a ticket used twice, a wrong name, an original changed after the sheet, Tia's door, a
// relayed request with her mark, a paired script's token, another site and an unknown key remove nothing; the right
// press removes exactly what `hoprig adopt retire` removes on the same home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { allOf, madeUpComputer, traps } from './fixture.mjs';
import { loopWatch, oneCall } from '../onecall.mjs';

const box = sandbox('adopt-retireweb');
test.after(() => box.cleanup());
const t = { root: box.root, home: box.home, claude: box.claude };
process.env.HOME = box.home;
const m = madeUpComputer(t);
const trap = traps(box.root);
const projects = path.join(box.workspace, 'projects');
fs.mkdirSync(projects, { recursive: true });

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { adoptFeature } = await import('../../src/adopt/feature.mjs');
const { makePlan, writePlan } = await import('../../src/adopt/plan.mjs');
const { applyPlan } = await import('../../src/adopt/apply.mjs');
const { pageRetire, NO_UNDO } = await import('../../src/adopt/retireweb.mjs');
const { main } = await import('../../src/adopt/cli.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { SELF_HEADER } = await import('../../src/machines/relay.mjs');

for (const name of ['notes', 'blog']) {
  writePlan(await makePlan(m.dirs[name], { projects, home: box.home, claude: box.claude }));
  const r = await applyPlan(name, { projects, workspace: box.workspace, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.ok(r.ok, JSON.stringify(r.lines.filter((l) => !l.ok)));
}

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const app = createServer({
  backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} },
  watch: false,
  adopt: { home: box.home, projects: () => projects, workspace: () => box.workspace, claude: () => box.claude },
});
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
// Each call on a connection of its own (test/onecall.mjs): a press that removes a whole folder takes a while, and a
// request is never sent on a kept-alive connection the server may be closing meanwhile.
const login = await oneCall(base, 'POST', '/api/login', { headers: { Origin: base }, body: { password: 'right-password' } });
const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
async function call(p, body, headers = { Cookie: cookie, Origin: base }) {
  const r = await oneCall(base, 'POST', p, { headers, body });
  return { status: r.status, json: r.json };
}

// What retire may touch: the scanned place, the copies, their server and Hoprig's adopt records.
const adoptState = path.join(box.state, 'adopt');
const world = () => allOf(m.place, projects, m.server, adoptState);
// The same tree, leaving out when each entry was written (two runs of one removal write at other moments).
const shape = (snap) => Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.split(' ').filter((_, i) => i !== 3).join(' ')]));

test('the look answers retire\'s own lines, what stays and why, no undo, a ticket, and changes nothing', async () => {
  const before = world();
  const c = await call('/api/adopt/retire/check', { name: 'notes' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.match(c.json.ticket, /^[0-9a-f]{64}$/);
  assert.equal(c.json.undo, NO_UNDO);
  assert.match(NO_UNDO, /nothing can bring these folders back from Hoprig\. The copy in your workspace stays/);
  assert.equal(c.json.refusal, null);
  assert.equal(c.json.lines[0], 'These originals would be removed (their copies are in the project):');
  assert.ok(c.json.lines.some((l) => /compares each of them with its copy again/.test(l)), c.json.lines.join('\n'));
  assert.ok(c.json.stay.some((s) => s.path.endsWith('no-ai') && /a private folder/.test(s.why)), JSON.stringify(c.json.stay));
  assert.ok(c.json.go.length >= 1);
  assert.ok(!JSON.stringify(c.json).includes('private.txt'), 'nothing in the private folder is named');
  assert.deepEqual(world(), before, 'the look removed and wrote nothing');
  const none = await call('/api/adopt/retire/check', { name: 'shop' });
  assert.equal(none.status, 404, 'a project that was never arranged here');
});

test('a wrong name, a ticket used twice, no ticket and an unknown key remove nothing', async () => {
  const before = world();
  const c = (await call('/api/adopt/retire/check', { name: 'notes' })).json;
  for (const typed of ['Notes', 'note', ' notes', '']) {
    const fresh = (await call('/api/adopt/retire/check', { name: 'notes' })).json;
    const r = await call('/api/adopt/retire', { ticket: fresh.ticket, typed });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false, typed);
    assert.equal(r.json.result, 'typed', typed);
    assert.match(r.json.check.ticket, /^[0-9a-f]{64}$/, 'a new sheet to type again on');
  }
  const wrong = await call('/api/adopt/retire', { ticket: c.ticket, typed: 'blog' });
  assert.equal(wrong.json.result, 'typed');
  const twice = await call('/api/adopt/retire', { ticket: c.ticket, typed: 'notes' });
  assert.equal(twice.json.result, 'expired');
  assert.match(twice.json.error, /used already/);
  assert.equal((await call('/api/adopt/retire', { typed: 'notes' })).json.result, 'expired');
  assert.equal((await call('/api/adopt/retire', { ticket: 'x'.repeat(64), typed: 'notes' })).json.result, 'expired');
  const fresh = (await call('/api/adopt/retire/check', { name: 'notes' })).json;
  assert.equal((await call('/api/adopt/retire', { ticket: fresh.ticket, typed: 'notes', force: true })).status, 400, 'an unknown key');
  assert.equal((await call('/api/adopt/retire/check', { name: '../notes' })).status, 400);
  assert.equal((await call('/api/adopt/retire/check', { name: 'notes', extra: 1 })).status, 400);
  assert.deepEqual(world(), before);
});

test('a ticket older than ten minutes removes nothing', async () => {
  let clock = Date.now();
  const r = pageRetire({ projects: () => projects, now: () => clock });
  const before = world();
  const c = await r.check('notes');
  clock += 10 * 60_000 + 1;
  const out = await r.retire(c.ticket, 'notes');
  assert.equal(out.result, 'expired');
  assert.match(out.error, /older than ten minutes/);
  assert.deepEqual(world(), before);
});

test('retire itself asks nothing and removes nothing when what it finds is not what the sheet showed', async () => {
  const { retireProject } = await import('../../src/adopt/retire.mjs');
  const before = world();
  let asked = 0;
  const r = await retireProject('notes', { projects, ask: async () => (asked++, 'notes'), checked: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(asked, 0, 'the name was not even asked');
  assert.deepEqual(world(), before);
});

test('Tia\'s door, a relayed request with her mark, a paired script\'s token and another site are refused before anything is read', async () => {
  const before = world();
  const { token } = createToken('script-box');
  for (const [why, headers] of [
    ['a paired token', { Authorization: `Bearer ${token}`, Origin: base }],
    ['Tia\'s token', { Authorization: 'Bearer tia_aaaaaaaaaaaaaaaaaaaaaaaa', Cookie: cookie, Origin: base }],
    ['another site', { Cookie: cookie, Origin: 'https://elsewhere.example' }],
    ['no sign-in', { Origin: base }],
  ]) {
    for (const [p, body] of [['/api/adopt/retire/check', { name: 'notes' }], ['/api/adopt/retire', { ticket: 'a'.repeat(64), typed: 'notes' }]]) {
      const r = await call(p, body, headers);
      assert.ok([401, 403].includes(r.status), `${why} ${p}: ${r.status}`);
    }
  }
  let read = 0;
  const ctx = (caller) => ({ caller: () => caller, readJson: async (req) => (read++, req.body) });
  for (const [why, caller, headers] of [
    ['Tia\'s door', 'self', {}],
    ['a relayed request with her mark', 'computer', { [SELF_HEADER]: '1' }],
    ['a paired script\'s token', 'computer', {}],
  ]) {
    const f = adoptFeature(ctx(caller), { projects: () => projects, home: box.home });
    for (const re of ['/api/adopt/retire/check', '/api/adopt/retire']) {
      const fn = f.routes.find(([meth, x]) => meth === 'POST' && x.test(re))[2];
      await assert.rejects(fn({ headers, body: { name: 'notes', ticket: 'a'.repeat(64), typed: 'notes' } }), { status: 403 }, `${why} ${re}`);
    }
  }
  assert.equal(read, 0, 'no body was read');
  assert.deepEqual(world(), before);
});

test('the original changed between the sheet and the press: nothing is removed', async () => {
  const c = (await call('/api/adopt/retire/check', { name: 'blog' })).json;
  assert.ok(c.ticket);
  fs.writeFileSync(path.join(m.dirs.blog, 'plan.md'), '# changed after the sheet\n');
  const before = world();
  const r = await call('/api/adopt/retire', { ticket: c.ticket, typed: 'blog' });
  assert.equal(r.json.ok, false);
  assert.match(r.json.words || r.json.error, /changed since it was copied|changed since you looked/);
  assert.deepEqual(world(), before, 'nothing removed');
  const again = (await call('/api/adopt/retire/check', { name: 'blog' })).json;
  assert.match(again.refusal, /changed since it was copied/);
  assert.equal(again.ticket, undefined, 'no ticket while retire refuses');
});

test('the right press removes exactly what hoprig adopt retire removes on the same home', async () => {
  const keep = path.join(box.root, 'kept');
  const roots = [m.place, projects, m.server, adoptState];
  const save = () => roots.forEach((r, i) => fs.cpSync(r, path.join(keep, String(i)), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true }));
  const restore = () => roots.forEach((r, i) => {
    // With retries: on Windows a folder a git of the dashboard has just read may stay held a moment.
    fs.rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    fs.cpSync(path.join(keep, String(i)), r, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  });
  // The longest stand-still of this process's loop, and in which step (one WINDIAG line on Windows).
  const loop = loopWatch('retireweb:');
  try {
    loop.mark('the test copies the folders aside and reads them (its own synchronous work)');
    save();
    const start = shape(world());

    loop.mark('the look in the place (scan)');
    assert.equal((await call('/api/adopt/scan', { places: [m.place] })).status, 200);
    const listed = async () => (await oneCall(base, 'GET', '/api/adopt', { headers: { Cookie: cookie } })).json.projects.map((p) => p.name);
    assert.ok((await listed()).includes('notes'));
    loop.mark('the sheet (retire check)');
    const c = (await call('/api/adopt/retire/check', { name: 'notes' })).json;
    loop.mark('the press (retire: proof and removal)');
    const r = await call('/api/adopt/retire', { ticket: c.ticket, typed: 'notes' });
    loop.mark('after the press: the list and the test reading the folders');
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.ok(!(await listed()).includes('notes'), 'the last look no longer lists a project whose old folder went');
    assert.equal(r.json.result, 'removed');
    const byPage = shape(world());
    assert.ok(Object.keys(start).length > Object.keys(byPage).length, 'something went');
    assert.equal(fs.readFileSync(path.join(m.dirs.notes, 'no-ai', 'private.txt'), 'utf8'), 'made-up private words\n', 'the private folder stays');
    assert.ok(fs.existsSync(path.join(projects, 'notes', 'code', 'notes', '.git')), 'the copy stays');
    const again = await call('/api/adopt/retire', { ticket: c.ticket, typed: 'notes' });
    assert.equal(again.json.result, 'expired', 'used once');

    loop.mark('the test puts the folders back (its own synchronous work)');
    restore();
    assert.deepEqual(shape(world()), start, 'the same home again');
    loop.mark('the command line retire, in this process');
    const out = [];
    const ui = makeUi({ interactive: true, write: (s) => out.push(s), askLine: async () => 'notes' });
    assert.equal(await main(['retire', 'notes'], { ui, write: (s) => out.push(s) }), 0, out.join(''));
    assert.deepEqual(shape(world()), byPage, 'the page removed exactly what the command removed');
    assert.deepEqual(trap.trapped(), []);
  } finally {
    loop.end();
  }
});

test('the docs and the changelog say what the page does, in the sheet\'s words', async () => {
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const flat = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
  const doc = flat('docs/WORKSPACE.md');
  assert.ok(doc.includes(NO_UNDO), 'the no-undo sentence');
  assert.ok(doc.includes('`POST /api/adopt/retire/check { name }` and `POST /api/adopt/retire { ticket, typed }`'));
  assert.doesNotMatch(doc, /the dashboard does not offer it/);
  const page = fs.readFileSync(path.join(ROOT, 'web', 'adoptretire.js'), 'utf8');
  assert.match(page, /RETIRE_LABEL = 'Remove the old folders'/);
  assert.ok(doc.includes('**Remove the old folders**'));
  assert.ok(flat('site/content/changelog.md').includes('**Remove the old folders from the page, after Arrange.**'));
});
