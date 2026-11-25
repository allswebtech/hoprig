// "Find the projects on this computer" (POST /api/adopt/home) through the real dashboard server, in a made-up home:
// the owner's own page gets the projects of his home with the same facts as a look in a folder he names, and the plan
// and arrange of each stay his press. Refused before anything is read: Tia's door, a token, another site, no sign-in,
// any key in the body; a second press while a look runs is refused in plain words. The home is the same afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { writeTree } from '../workspace/helpers.mjs';
import { repo, snapshot, traps } from './fixture.mjs';

const box = sandbox('adopt-homeroute');
test.after(() => box.cleanup());
process.env.HOME = box.home;
const trap = traps(box.root);
const projects = path.join(box.workspace, 'projects');
writeTree(projects, { 'alpha/package.json': '{}\n' });
repo(path.join(box.home, 'code', 'blog', 'web'), path.join(box.root, 'server', 'blog-web.git'), { 'package.json': '{ "name": "blog-web" }\n' });
repo(path.join(box.home, 'code', 'blog', 'api'), null, { 'go.mod': 'module api\n' });
writeTree(box.home, {
  'shop/package.json': '{ "name": "shop" }\n',
  'shop/notes.md': '# shop\n',
  'music-notes.txt': 'not a project\n',
  'no-ai/secret-project/package.json': '{}\n',
  '.cache/thing/package.json': '{}\n',
});
fs.symlinkSync('..', path.join(box.home, 'up'));

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { adoptFeature } = await import('../../src/adopt/feature.mjs');
saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const adopt = { home: box.home, projects: () => projects, workspace: () => box.workspace, claude: () => box.claude };
const app = createServer({ backend: { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} }, watch: false, adopt });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body, headers = { Cookie: cookie, Origin: base }) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
const before = snapshot(box.home);

test('the refusals come before anything is read, and nothing is looked at', async () => {
  const { token } = createToken('office-pc');
  for (const [why, headers, wanted] of [
    ['a machine token', { Authorization: `Bearer ${token}`, Origin: base }, [401, 403]],
    ['Tia\'s token', { Authorization: 'Bearer tia_aaaaaaaaaaaaaaaaaaaaaaaa', Origin: base }, [401, 403]],
    ['a relayed request with her mark', { Authorization: `Bearer ${token}`, Origin: base, 'x-hoprig-self': '1', 'x-hoprig-owner-page': '1' }, [401, 403]],
    ['another site', { Cookie: cookie, Origin: 'https://elsewhere.example' }, [403]],
    ['no sign-in', { Origin: base }, [401]],
  ]) {
    const r = await call('/api/adopt/home', {}, headers);
    assert.ok(wanted.includes(r.status), `${why}: ${r.status}`);
  }
  assert.equal((await call('/api/adopt/home', { places: ['/'] })).status, 400, 'nothing but an empty body is taken');
  assert.equal((await call('/api/adopt/home', { deep: true })).status, 400);
  let read = 0;
  const f = adoptFeature({ caller: () => 'self', readJson: async () => ((read += 1), {}) }, { ...adopt, homeLook: { clock: () => assert.fail('the look ran') } });
  const route = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/adopt/home'))[2];
  await assert.rejects(route({ headers: {} }), { status: 403 }, 'Tia\'s door (an in-process request)');
  await assert.rejects(route({ headers: { authorization: 'Bearer x' } }), { status: 403 });
  assert.equal(read, 0, 'not even the body was read');
  assert.deepEqual((await call('/api/adopt')).json.projects, [], 'no look was made');
  assert.deepEqual(snapshot(box.home), before);
});

test('his press: the projects of his home, each with the facts of a look in a named folder, and nothing changed', async () => {
  const r = await call('/api/adopt/home', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.projects.map((p) => [p.name, p.dir]), [['blog', '~/code/blog'], ['shop', '~/shop']]);
  const blog = r.json.projects.find((p) => p.name === 'blog');
  assert.deepEqual(blog.repos.map((x) => [x.dir, x.branch, x.ok]), [['api', 'main', true], ['web', 'main', true]], 'the same facts as a look in ~/code');
  assert.equal(r.json.projects.find((p) => p.name === 'shop').planned, false, 'no plan is made before his press');
  assert.deepEqual(r.json.home.links, ['~/up'], 'the link is named, not followed');
  assert.equal(r.json.home.privates, 1);
  assert.equal(r.json.home.inWorkspace, 1);
  assert.equal(r.json.home.ended, null);
  assert.match(r.json.home.words, /whole home folder/);
  const text = JSON.stringify(r.json);
  for (const w of ['secret-project', 'no-ai', '.cache', 'music-notes']) assert.ok(!text.includes(w), w);
  assert.deepEqual(snapshot(box.home), before, 'the whole home is the same afterwards');
  assert.ok(!fs.existsSync(path.join(box.state, 'adopt')), 'no plan file');
  assert.deepEqual(trap.trapped().filter((l) => !/^TRAP gh auth status/.test(l)), [], 'nothing fetched or pushed');
  // The list is the last look: a plan is made for one of its projects only on his press, as after a named folder.
  const g = await call('/api/adopt');
  assert.deepEqual(g.json.projects.map((p) => p.name), ['blog', 'shop']);
  assert.deepEqual(g.json.home, r.json.home, 'the page shows what the look did after a reload too');
  const p = await call('/api/adopt/plan', { dir: '~/shop' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.from, '~/shop');
  assert.deepEqual(snapshot(box.home), before, 'a plan changes nothing of the home');
});

test('a second press while a look runs is refused in plain words', async () => {
  const f = adoptFeature({ caller: () => 'page', readJson: async () => ({}) }, adopt);
  const route = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/adopt/home'))[2];
  const first = route({ headers: {} });
  await assert.rejects(route({ headers: {} }), (e) => e.status === 409 && /already looking through your home folder/.test(e.message));
  assert.equal((await first).projects.length, 2);
  assert.equal((await route({ headers: {} })).projects.length, 2, 'after it ended, a new press looks again');
});
