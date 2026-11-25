// Workspace → Projects found on this computer, through the real dashboard server: the three steps from the owner's own
// signed-in page; refused for Tia's door, another computer's token, a request from another site and without sign-in.
// Every folder from the browser is checked on the server: a whole disk, a relative path, a project not found.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { madeUpComputer, traps } from './fixture.mjs';

const box = sandbox('adopt-feature');
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
saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const app = createServer({
  backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} },
  watch: false,
  adopt: { home: box.home, projects: () => projects, workspace: () => box.workspace, claude: () => box.claude },
});
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body, headers = { Cookie: cookie, Origin: base }) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test('the owner\'s page: look in the folder he named, a plan, a dry run, then Arrange with its proof', async () => {
  const g = await call('/api/adopt');
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.projects, [], 'nothing is looked at before his yes');
  const s = await call('/api/adopt/scan', { places: [m.place] });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.deepEqual(s.json.projects.map((p) => p.name), ['blog', 'notes', 'shop', 'tools']);
  assert.ok(!JSON.stringify(s.json).includes('private.txt'));
  const p = await call('/api/adopt/plan', { dir: s.json.projects.find((x) => x.name === 'notes').dir });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.name, 'notes');
  const before = fs.readdirSync(projects);
  const d = await call('/api/adopt/apply', { name: 'notes', dryRun: true, identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.equal(d.status, 200);
  assert.deepEqual(fs.readdirSync(projects), before, 'a dry run makes nothing');
  const a = await call('/api/adopt/apply', { name: 'notes', identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.ok(a.json.ok);
  assert.ok(['HEAD', 'refs', 'status', 'stash', 'files', 'fsck'].every((w) => a.json.lines.some((l) => l.what === w && l.ok)));
  assert.ok(a.json.lines.some((l) => /old folders are untouched/.test(l.words)));
  assert.deepEqual(trap.trapped(), []);
  const g2 = await call('/api/adopt');
  const notes = g2.json.projects.find((x) => x.name === 'notes');
  assert.equal(notes.arranged, true, 'the list says it is arranged');
  assert.equal(notes.arrangedTo, path.join(g2.json.workspace, 'notes'), 'and where, as the page shows paths');
  assert.equal(g2.json.projects.find((x) => x.name === 'blog').arranged, false);
});

test('the plan step takes the project\'s name: a name the rule refuses is a 400 and writes no plan; the list follows the name', async () => {
  await call('/api/adopt/scan', { places: [m.place] });
  for (const name of ['My Shop', '', '.shop', 42]) {
    const r = await call('/api/adopt/plan', { dir: m.dirs.shop, name });
    assert.equal(r.status, 400, JSON.stringify(r.json));
  }
  const { planFile } = await import('../../src/adopt/plan.mjs');
  assert.ok(!fs.existsSync(planFile('My Shop')) && !fs.existsSync(planFile('.shop')), 'no plan is written for a refused name');
  assert.equal((await call('/api/adopt/plan', { dir: m.dirs.shop, copyInstalled: 'yes' })).status, 400);
  const p = await call('/api/adopt/plan', { dir: m.dirs.shop, name: 'storefront' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.name, 'storefront');
  assert.match(p.json.to, /storefront$/);
  assert.match(p.json.found, /already laid out as a Hoprig project/);
  const g = await call('/api/adopt');
  const shop = g.json.projects.find((x) => x.name === 'shop');
  assert.equal(shop.planned, true);
  assert.equal(shop.planName, 'storefront');
  const a = await call('/api/adopt/apply', { name: 'storefront', identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.ok(a.json.ok, JSON.stringify(a.json.lines.filter((l) => !l.ok)));
  const g2 = await call('/api/adopt');
  assert.equal(g2.json.projects.find((x) => x.name === 'shop').arranged, true, 'arranged under the name he gave');
  // Another folder may not take the name of a project arranged from this one: its plan is what verify and retire read.
  const taken = await call('/api/adopt/plan', { dir: m.dirs.tools, name: 'storefront' });
  assert.equal(taken.status, 400, JSON.stringify(taken.json));
  assert.match(taken.json.error, /storefront is the name of a project arranged from/);
  assert.equal((await call('/api/adopt/plan?name=storefront')).json.from.endsWith('shop'), true, 'its plan stays');
});

test('a folder that changed after its plan: the page gets the code ECHANGED and words without a terminal command', async () => {
  await call('/api/adopt/scan', { places: [m.place] });
  const p = await call('/api/adopt/plan', { dir: m.dirs.blog });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  fs.appendFileSync(path.join(m.dirs.blog, 'web', 'src', 'a.js'), 'later\n');
  const a = await call('/api/adopt/apply', { name: 'blog', identity: { name: 'Alex', email: 'alex@example.invalid' } });
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'ECHANGED', JSON.stringify(a.json));
  assert.ok(!/hoprig adopt/.test(a.json.error), a.json.error);
  const noId = await call('/api/adopt/apply', { name: 'nothing-planned' });
  assert.equal(noId.status, 404);
  assert.equal(noId.json.code, 'EPLAN');
});

test('without a name and e-mail and with no git identity, the page is told to type them above, not a terminal flag', async () => {
  await call('/api/adopt/scan', { places: [m.place] });
  assert.equal((await call('/api/adopt/plan', { dir: m.dirs.tools })).status, 200);
  const cfg = process.env.GIT_CONFIG_GLOBAL;
  const empty = path.join(box.root, 'empty-gitconfig');
  fs.writeFileSync(empty, '');
  process.env.GIT_CONFIG_GLOBAL = empty;
  try {
    const a = await call('/api/adopt/apply', { name: 'tools' });
    assert.equal(a.status, 409);
    assert.equal(a.json.code, 'ENOIDENTITY');
    assert.ok(!/--name|--email/.test(a.json.error), a.json.error);
    assert.match(a.json.error, /name and e-mail above/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = cfg;
  }
});

test('refused: Tia\'s door, another computer\'s token, another site, no sign-in', async () => {
  const { token } = createToken('office-pc');
  for (const [why, headers, wanted] of [
    ['a machine token', { Authorization: `Bearer ${token}` }, [401, 403]],
    ['Tia\'s token', { Authorization: 'Bearer tia_aaaaaaaaaaaaaaaaaaaaaaaa' }, [401, 403]],
    ['another site', { Cookie: cookie, Origin: 'https://elsewhere.example' }, [403]],
    ['no sign-in', { Origin: base }, [401]],
  ]) {
    for (const [p, body] of [['/api/adopt', undefined], ['/api/adopt/scan', { places: [m.place] }], ['/api/adopt/apply', { name: 'blog' }]]) {
      if (body === undefined && why === 'another site') continue; // a GET carries no Origin check; the cookie is the owner's
      const r = await call(p, body, headers);
      assert.ok(wanted.includes(r.status), `${why} ${p}: ${r.status}`);
    }
  }
  const f = adoptFeature({ caller: () => 'self', readJson: async () => ({ places: [m.place] }) });
  const scan = f.routes.find(([meth, re]) => meth === 'POST' && re.test('/api/adopt/scan'))[2];
  await assert.rejects(scan({ headers: {} }), { status: 403 }, 'Tia\'s door (an in-process request) is refused');
});

test('every folder from the browser is checked on the server', async () => {
  for (const places of [['/'], ['code'], [path.join(box.root, 'nothing-here')], [path.join(m.dirs.notes, 'app.py')], 'x', [], ['a\nb']]) {
    const r = await call('/api/adopt/scan', { places });
    assert.equal(r.status, 400, JSON.stringify(places));
  }
  assert.equal((await call('/api/adopt/plan', { dir: path.join(box.home, '.ssh') })).status, 400, 'only a project of the last look');
  assert.equal((await call('/api/adopt/apply', { name: '../x' })).status, 400);
  assert.equal((await call('/api/adopt/scan', { places: [m.place], extra: 1 })).status, 400);
});
