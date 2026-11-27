// "Look on the git server" on the Workspace page, for a place with a naming rule: the routes call the command's own
// functions (findcmd.mjs addFound, getbyrule.mjs getByRule) in a world whose "GitHub" is a folder of bare
// repositories and whose gh is a stand-in (dryrun-fixture.mjs { find: true }: kits/builds has the rule). Each change is
// a dry run first that changes nothing at all (the whole world compared), with a `seen` id; the real call is the
// owner's own page only and is refused when the plan made now is not the one he saw.
// The server here runs in the dry world's own home: its use() sets HOPRIG_WORKSPACE_DIR to that world's workspace
// (test/pcsetup/dryrun-fixture.mjs), so the real workspace is never read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { changes, dryWorld, snapshot } from '../pcsetup/dryrun-fixture.mjs';
import { SHELL_STANDINS } from '../seal.mjs';

// The stand-in gh (and ssh) of these tests are shell scripts: on Windows the runner starts them through sh.
const SH_GH = SHELL_STANDINS;

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const PLACE = 'kits/builds';
const mapOf = (w) => JSON.parse(fs.readFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), 'utf8'));

/** A test dashboard on the world's home, signed in. → { post, get, close, origin, cookie } */
async function serve(w) {
  w.use();
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [w.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `findweb-${process.pid}` });
  // The HTTP server only: the features' start (a tunnel to a joined hub) is not wanted here.
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  // A whole-home snapshot between two requests takes seconds on Windows: longer than the server keeps an idle
  // connection (5 s), and fetch's next request on the connection it closed then ends in ECONNRESET there.
  app.server.keepAliveTimeout = 120_000;
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = { Cookie: cookie, Origin: origin };
  const post = async (p, body, headers = page) => {
    const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const get = async (p) => {
    const r = await fetch(origin + p, { headers: { Cookie: cookie } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { post, get, origin, cookie, page, close: () => new Promise((r) => app.server.close(r)) };
}

/** What changed in the world, leaving out the test dashboard's own sign-in record (it changes with every request). */
const SIGNIN = /web-sessions\.json|^changed home\/\.local\/state\/hoprig: /;
const diff = (a, b) => changes(a, b).split('\n').filter((l) => l && !SIGNIN.test(l)).join('\n');
/** For a real call that was refused: also the brain's lock (the check runs while it is held, so a plan cannot change
 * between the check and the write; its folder is in Hoprig's state folder) and the record of which token knocked. */
const OWN = /home\/\.local\/state\/hoprig\/(repo-locks|token-use\.json)/;
const refusedDiff = (a, b) => diff(a, b).split('\n').filter((l) => l && !OWN.test(l)).join('\n');

test('Add these to the map, the dry run: the entries that would go in, nothing cloned, nothing changed, and a seen id', SH_GH, async (tc) => {
  const w = await dryWorld(tc, 'findweb-dry', { find: true });
  const s = await serve(w);
  try {
    const before = snapshot(w);
    const dry = await s.post('/api/workspace/find/add', { in: PLACE, dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.json));
    assert.equal(dry.json.dryRun, true);
    assert.deepEqual(dry.json.added, ['kits/builds/alpha-shop', 'kits/builds/beta-blog']);
    assert.deepEqual(dry.json.entries.map((e) => [e.name, e.url, e.repos.map((r) => r.dir)]), [
      ['alpha-shop', 'https://github.com/alex/shop-alpha-project.git', ['code/shop-alpha-app', 'code/shop-alpha-web']],
      ['beta-blog', 'https://github.com/team/blog-beta-project.git', ['code/blog-beta-api', 'code/blog-beta-app', 'code/blog-beta-web']],
    ]);
    assert.match(dry.json.seen, /^[0-9a-f]{64}$/);
    assert.equal(diff(before, snapshot(w)), '', 'the dry run changed nothing');
    assert.ok(!fs.existsSync(path.join(w.groups.builds, 'alpha-shop')), 'nothing cloned');
  } finally {
    await s.close();
  }
});

test('Add these to the map, the yes: only the owner\'s own page, only the plan he saw; then exactly those entries, nothing cloned', SH_GH, async (tc) => {
  const w = await dryWorld(tc, 'findweb-add', { find: true });
  const s = await serve(w);
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');
  const script = createToken('a script');
  const hub = createToken('hub');
  fs.writeFileSync(path.join(w.env.HOPRIG_CONFIG_DIR, 'joined.json'), JSON.stringify({ hubs: [{ id: '0123456789ab', target: 'alex@box2', port: 1, tokenId: hub.id }] }));
  try {
    const seen = (await s.post('/api/workspace/find/add', { in: PLACE, dryRun: true })).json.seen;
    const before = snapshot(w);
    const yes = { in: PLACE, seen };
    const refused = [
      [yes, { Authorization: 'Bearer tia_0123456789abcdef' }, [401]],
      [yes, { Authorization: 'Bearer tia_0123456789abcdef', ...s.page }, [401, 403]],
      [yes, { Cookie: s.cookie, Origin: 'http://evil.example' }, [403]],
      [yes, {}, [401, 403]],
      [yes, { Authorization: `Bearer ${script.token}`, [OWNER_PAGE_HEADER]: '1' }, [403]],
      [yes, { Authorization: `Bearer ${hub.token}`, [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' }, [403]],
      [{ ...yes, force: true }, s.page, [400]],
      [{ in: PLACE, dryRun: 'yes' }, s.page, [400]],
      [{ in: PLACE }, s.page, [400]],
      [{ in: PLACE, seen: 'a'.repeat(64) }, s.page, [409]],
      [{ in: '../../etc', seen }, s.page, [404]],
      [{ in: 'clients', seen }, s.page, [400]],
    ];
    for (const [body, headers, codes] of refused) {
      const r = await s.post('/api/workspace/find/add', body, headers);
      assert.ok(codes.includes(r.status), `${JSON.stringify(body)} ${JSON.stringify(Object.keys(headers))}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.match((await s.post('/api/workspace/find/add', { in: PLACE, seen: 'a'.repeat(64) })).json.error, /^This changed since you looked: look again\.$/);
    assert.match((await s.post('/api/workspace/find/add', { in: 'clients', dryRun: true })).json.error, /clients has no naming rule/);
    assert.equal(refusedDiff(before, snapshot(w)), '', 'every refusal changed nothing');
    // His yes: the entries the dry run named, in the map; nothing cloned.
    const mapBefore = mapOf(w);
    const done = await s.post('/api/workspace/find/add', yes);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.dryRun, false);
    assert.deepEqual(done.json.added, ['kits/builds/alpha-shop', 'kits/builds/beta-blog']);
    const byRef = (list) => [...list].sort((a, b) => `${a.in || ''}/${a.name}`.localeCompare(`${b.in || ''}/${b.name}`));
    assert.deepEqual(byRef(mapOf(w).projects), byRef([...mapBefore.projects, ...done.json.entries]));
    const changed = refusedDiff(before, snapshot(w)).split('\n');
    assert.ok(changed.every((l) => /^changed home\/Workspace\/ai_brain(\/workspace\.json)?: /.test(l)), `only the map changed:\n${changed.join('\n')}`);
    assert.ok(!fs.existsSync(path.join(w.groups.builds, 'alpha-shop')), 'nothing cloned');
    // The same yes again: the plan is another now (both are in the map), so it is refused.
    assert.equal((await s.post('/api/workspace/find/add', yes)).status, 409);
  } finally {
    await s.close();
  }
});

test('a plan that changed after the look is refused and writes nothing', SH_GH, async (tc) => {
  const w = await dryWorld(tc, 'findweb-stale', { find: true });
  const s = await serve(w);
  try {
    const seen = (await s.post('/api/workspace/find/add', { in: PLACE, dryRun: true })).json.seen;
    // Another computer added one of them meanwhile (the map now has alpha-shop).
    const m = mapOf(w);
    m.projects.push({ name: 'alpha-shop', in: PLACE, url: 'https://github.com/alex/shop-alpha-project.git', repos: [] });
    fs.writeFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), `${JSON.stringify(m, null, 2)}\n`);
    const before = snapshot(w);
    const r = await s.post('/api/workspace/find/add', { in: PLACE, seen });
    assert.deepEqual([r.status, r.json.error], [409, 'This changed since you looked: look again.']);
    assert.equal(refusedDiff(before, snapshot(w)), '');
  } finally {
    await s.close();
  }
});

test('Take them out again: exactly the entries the add wrote, only those unchanged since; the map as it was before', SH_GH, async (tc) => {
  const w = await dryWorld(tc, 'findweb-undo', { find: true });
  const s = await serve(w);
  try {
    const mapBefore = mapOf(w);
    const seen = (await s.post('/api/workspace/find/add', { in: PLACE, dryRun: true })).json.seen;
    const done = (await s.post('/api/workspace/find/add', { in: PLACE, seen })).json;
    const before = snapshot(w);
    for (const [body, headers, code] of [
      [{ entries: done.entries }, { Authorization: 'Bearer tia_0123456789abcdef', ...s.page }, [401, 403]],
      [{ entries: done.entries }, { Cookie: s.cookie, Origin: 'http://evil.example' }, [403]],
      [{ entries: done.entries, all: true }, s.page, [400]],
      [{ entries: [{ name: '../x', in: PLACE, url: 'https://github.com/alex/x.git', repos: [] }] }, s.page, [400]],
      [{ entries: [] }, s.page, [400]],
    ]) assert.ok(code.includes((await s.post('/api/workspace/find/undo', body, headers)).status), JSON.stringify(body));
    assert.equal(refusedDiff(before, snapshot(w)), '', 'refused: nothing changed');
    // beta-blog changed since (another code repository): it stays.
    const m = mapOf(w);
    m.projects.find((p) => p.name === 'beta-blog').repos.push({ dir: 'code/blog-beta-docs', url: 'https://github.com/team/blog-beta-docs.git' });
    fs.writeFileSync(path.join(w.ws, 'ai_brain', 'workspace.json'), `${JSON.stringify(m, null, 2)}\n`);
    const r = await s.post('/api/workspace/find/undo', { entries: done.entries });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.removed, ['kits/builds/alpha-shop']);
    assert.deepEqual(r.json.kept.map((k) => k.ref), ['kits/builds/beta-blog']);
    const after = mapOf(w);
    assert.deepEqual(after.projects.map((p) => p.name).sort(), [...mapBefore.projects.map((p) => p.name), 'beta-blog'].sort());
    assert.deepEqual(after.skip, mapBefore.skip, 'no skip left behind: a later add brings it in again');
    // Found again by the next look, as before the add.
    const again = await s.post('/api/workspace/find/add', { in: PLACE, dryRun: true });
    assert.deepEqual(again.json.added, ['kits/builds/alpha-shop']);
  } finally {
    await s.close();
  }
});

test('Get: the dry run says where it lands and changes nothing; the yes is a background job that clones it; a second start is refused', SH_GH, async (tc) => {
  const w = await dryWorld(tc, 'findweb-get', { find: true });
  const s = await serve(w);
  try {
    const before = snapshot(w);
    const dry = await s.post('/api/workspace/find/get', { in: PLACE, repo: 'alex/shop-alpha-project', dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.json));
    assert.equal(dry.json.folder, 'alpha-shop');
    assert.deepEqual(dry.json.code, ['shop-alpha-app', 'shop-alpha-web']);
    assert.deepEqual(dry.json.skipped, ['shop-alpha-old-api']);
    // The place in this system's own form, the home written as ~ (~\Workspace\… on Windows).
    const into = ['~', 'Workspace', 'kits', 'builds', 'alpha-shop'].join(path.sep);
    assert.equal(dry.json.into, into);
    assert.match(dry.json.lines.join('\n'), new RegExp(`\\(dry run\\) would clone .*shop-alpha-project\\.git into ${into.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(dry.json.seen, /^[0-9a-f]{64}$/);
    assert.equal(diff(before, snapshot(w)), '', 'the dry run changed nothing');
    for (const [body, headers, code] of [
      [{ in: PLACE, repo: 'alex/shop-alpha-project', seen: dry.json.seen }, { Authorization: 'Bearer tia_0123456789abcdef', ...s.page }, [401, 403]],
      [{ in: PLACE, repo: 'alex/shop-alpha-project', seen: dry.json.seen }, { Cookie: s.cookie, Origin: 'http://evil.example' }, [403]],
      [{ in: PLACE, repo: 'alex/shop-alpha-project', seen: 'b'.repeat(64) }, s.page, [409]],
      [{ in: PLACE, repo: 'alex/shop-alpha-project' }, s.page, [400]],
      [{ in: PLACE, repo: '../shop', seen: dry.json.seen }, s.page, [400]],
      [{ in: PLACE, repo: 'alex/shop-alpha-project', seen: dry.json.seen, folder: 'x' }, s.page, [400]],
      [{ in: PLACE, repo: 'alex/notes', dryRun: true }, s.page, [404]],
    ]) {
      const r = await s.post('/api/workspace/find/get', body, headers);
      assert.ok(code.includes(r.status), `${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert.equal(refusedDiff(before, snapshot(w)), '', 'refused: nothing changed');
    const go = await s.post('/api/workspace/find/get', { in: PLACE, repo: 'alex/shop-alpha-project', seen: dry.json.seen });
    assert.deepEqual([go.status, go.json], [200, { started: true, kind: 'find-get' }]);
    const second = await s.post('/api/workspace/find/get', { in: PLACE, repo: 'team/blog-beta-project', seen: dry.json.seen });
    assert.equal(second.status, 409, 'one job at a time');
    assert.match(second.json.error, /find-get is still running; wait until it finishes/);
    let j;
    for (let i = 0; i < 600; i++) {
      j = (await s.get('/api/workspace/job')).json;
      if (!j.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(j.kind, 'find-get');
    assert.equal(j.result.ok, true, JSON.stringify(j));
    assert.deepEqual(j.result.data, { ok: true, result: 'cloned', ref: 'kits/builds/alpha-shop' });
    const root = path.join(w.groups.builds, 'alpha-shop');
    for (const d of ['.git', 'code/shop-alpha-app/.git', 'code/shop-alpha-web/.git', 'apps']) assert.ok(fs.existsSync(path.join(root, d)), d);
    assert.ok(!fs.existsSync(path.join(root, 'code', 'shop-alpha-old-api')), 'the word the rule leaves out');
    assert.ok(j.lines.some((l) => /alpha-shop/.test(l)), 'the job\'s lines say what it does');
    assert.ok(!j.lines.join('\n').includes(w.home), 'the lines write the home as ~');
    const entry = mapOf(w).projects.find((p) => p.in === PLACE && p.name === 'alpha-shop');
    assert.equal(entry.url, 'https://github.com/alex/shop-alpha-project.git');
  } finally {
    await s.close();
  }
});

test('without the GitHub sign-in: a plain refusal the page can name the sign-in for, never the dashboard\'s own 401', async (tc) => {
  const w = await dryWorld(tc, 'findweb-signin', { find: true });
  const s = await serve(w);
  const was = process.env.FAKE_GH_USER;
  process.env.FAKE_GH_USER = ''; // the stand-in then answers as gh does without a sign-in
  try {
    for (const [p, body] of [['/api/workspace/find/add', { in: PLACE, dryRun: true }], ['/api/workspace/find/get', { in: PLACE, repo: 'alex/shop-alpha-project', dryRun: true }]]) {
      const r = await s.post(p, body);
      assert.deepEqual([r.status, r.json.code], [409, 'gh-signin'], p);
      assert.match(r.json.error, /the look-up needs the GitHub sign-in/);
    }
    const look = await s.get(`/api/workspace/find?in=${encodeURIComponent(PLACE)}`);
    assert.deepEqual([look.status, look.json.code], [409, 'gh-signin']);
  } finally {
    process.env.FAKE_GH_USER = was;
    await s.close();
  }
});

test('the page: a button per place with a rule, every change asked first, the words for no sign-in, no rule, nothing fits', async () => {
  // Just enough of a browser for the page's modules to load (nothing is drawn here).
  globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
  globalThis.Node ??= class {};
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const F = await import('../../web/workspacefind.js');
  const rule = { parent: '{name}-project', folder: '{name}' };
  const map = { groups: [{ dir: 'kits', url: 'https://github.com/alex/kits.git', holds: [{ dir: 'builds', find: rule }, { dir: 'packs', parent: 'group', find: rule }, { dir: 'other' }] }, { dir: 'clients', find: rule }, { dir: 'shared', url: 'https://github.com/alex/shared.git', find: rule }] };
  assert.deepEqual(F.rulePlaces(map).map((x) => x.id), ['kits/builds', 'clients'], 'only the places the server gives a rule (ruleOf)');
  assert.equal(F.findPlaces({ map: { groups: [] } }, () => {}), null, 'no place with a rule: nothing on the page');
  assert.equal(F.refusalWords({ message: 'the look-up needs the GitHub sign-in (gh auth login)', data: { code: 'gh-signin' } }), F.SIGNIN_WORDS);
  assert.match(F.SIGNIN_WORDS, /the GitHub sign-in this dashboard already has/);
  assert.equal(F.refusalWords({ message: 'clients has no naming rule ("find" in the map): …', data: {} }), F.NO_RULE_WORDS);
  assert.equal(F.refusalWords({ message: 'This changed since you looked: look again.', data: {} }), 'This changed since you looked: look again.');
  const src = fs.readFileSync(new URL('../../web/workspacefind.js', import.meta.url), 'utf8');
  assert.match(src, /label: 'Look on the git server'/);
  assert.match(src, /api\('\/api\/workspace\/find\/add', \{ in: place, dryRun: true \}\)[\s\S]*api\('\/api\/workspace\/find\/add', \{ in: place, seen: dry\.seen \}\)/, 'the add is asked first, and the yes sends what he saw');
  assert.match(src, /api\('\/api\/workspace\/find\/get', \{ in: place, repo: p\.parent, dryRun: true \}\)[\s\S]*api\('\/api\/workspace\/find\/get', \{ in: place, repo: p\.parent, seen: dry\.seen \}\)/, 'the get is asked first');
  assert.match(src, /label: 'Take them out again'[\s\S]*api\('\/api\/workspace\/find\/undo', \{ entries: r\.entries \}\)/, 'the undo names exactly what the add wrote');
  assert.match(src, /import\('\.\/gitsetup\.js'\)[\s\S]*signinSheet\(\)/, 'the sign-in is the page\'s own GitHub sign-in sheet');
  for (const name of ['NONE_FITS', 'ALL_IN_MAP', 'ADD_NOTE', 'GET_NOTE', 'SIGNIN_WORDS']) assert.ok(src.split(name).length > 2, `${name} is said on the page, not only defined`);
  assert.match(F.GET_NOTE, /not undone from here.*Drop/);
  // Hooked into the map panel of Settings → Workspace with one import line and one call.
  const ws = fs.readFileSync(new URL('../../web/workspace.js', import.meta.url), 'utf8');
  assert.match(ws, /^import \{ findPlaces \} from '\.\/workspacefind\.js';$/m);
  assert.match(ws, /^ {4}m\.exists && !m\.errors \? findPlaces\(m, refresh\) : null,$/m);
});

test('the docs and the changelog say what the page does, in its own words', async () => {
  const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\n\s*/g, ' ');
  const doc = read('docs/WORKSPACE.md');
  assert.match(doc, /\*\*On the page: "Look on the git server"\.\*\* In \*\*Settings → Automations → Workspace\*\*/);
  assert.match(doc, /\*\*Add these to the map\*\* first shows which entries go in \("Nothing is cloned"\)/);
  assert.match(doc, /the yes is refused with "This changed since you looked: look again\."/);
  assert.match(doc, /\*\*Take them out again\*\* right after takes out exactly the entries that add wrote/);
  assert.match(doc, /A clone is not undone from there; Drop on the project's page puts it away again\./);
  const { CHANGED } = await import('../../src/workspace/findcmd.mjs');
  assert.equal(CHANGED, 'This changed since you looked: look again.');
  const log = read('site/content/changelog.md');
  assert.match(log, /- \*\*Look on the git server, from the page\.\*\* For a place with a naming rule, Settings → Workspace lists/);
});
