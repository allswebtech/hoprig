// The credentials folder as a private repository from the Workspace page (credweb.mjs): the same plan, the same
// refusals and the same typed name as `hoprig workspace credentials`. The dry run answers the cost sentence, the
// steps, the name to type and a `seen` id, and changes nothing in the whole home; the real call is the owner's own
// page only, refused for a wrong name, a stale plan, an unknown key, another server not confirmed private, and runs
// as the page's background job. A marker value and a marker file name of the folder are searched for in every
// answer, every job line and every file of Hoprig's state and config folders.
// The server here runs in the dry world's own home: its use() sets HOPRIG_WORKSPACE_DIR to that world's workspace
// (test/pcsetup/dryrun-fixture.mjs), so the real workspace is never read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from '../pcsetup/dryrun-fixture.mjs';
import { SHELL_STANDINS } from '../seal.mjs';

// The stand-in gh (and ssh) of these tests are shell scripts: on Windows the runner starts them through sh.
const SH_GH = SHELL_STANDINS;

const ws = await import('../../src/workspace/cli.mjs');
const { readMap } = await import('../../src/workspace/map.mjs');
const { COST } = await import('../../src/workspace/credrepo.mjs');
const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
const VALUE = 'MARKVALUE-credweb-5a17';
const NAME = 'markname-credweb-c3d9';

/** A world with a version-2 map (or 1) and a credentials folder (700) holding a marked file. */
async function world(tc, name, { v2 = true } = {}) {
  const w = await dryWorld(tc, name);
  if (v2) assert.equal((await runCli((a, o) => ws.main(a, o), ['map', '--upgrade', '--yes'])).code, 0);
  const c = path.join(w.ws, 'credentials');
  fs.mkdirSync(path.join(c, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(c, 'shop', `${NAME}.env`), `API_KEY=${VALUE}\n`);
  fs.chmodSync(c, 0o700);
  fs.mkdirSync(path.join(w.server, 'other'), { recursive: true });
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, `[url "${String(path.join(w.server, 'other')).replaceAll('\\', '/')}/"]\n\tinsteadOf = https://git.example.test/\n`);
  w.bare = (rel) => execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(w.server, rel)]);
  w.creds = c;
  w.said = [];
  // The feature as the server calls it: `by` is who the server says asks ('page' = the owner's own page).
  w.feature = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: (req) => req.by || 'page' }, { dir: w.ws, projectsDir: () => w.projects });
  w.call = async (method, url, body, { by = 'page', headers = {} } = {}) => {
    const route = w.feature.routes.find(([m, re]) => m === method && re.test(url.split('?')[0]));
    if (!route) return { status: 404, message: 'no such route' };
    const fn = route[2];
    try {
      const r = await fn({ body, by, headers }, null, new URLSearchParams(url.split('?')[1] || ''));
      w.said.push(JSON.stringify(r));
      return { status: 200, json: r };
    } catch (e) {
      w.said.push(`${e.status} ${e.message}`);
      return { status: e.status || 500, message: e.message };
    }
  };
  w.post = (body, o) => w.call('POST', '/api/workspace/credentials', body, o);
  w.job = async () => {
    for (let i = 0; i < 600; i++) {
      const j = (await w.call('GET', '/api/workspace/job')).json;
      if (!j.running) return j;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the job did not end');
  };
  w.clean = () => {
    const all = w.said.join('\n') + allText(w.env.HOPRIG_STATE_DIR) + allText(w.env.HOPRIG_CONFIG_DIR);
    assert.equal(all.includes(VALUE), false, 'a value of the folder left');
    assert.equal(all.includes(NAME), false, 'a file name of the folder left');
  };
  await new Promise((r) => setTimeout(r, 20));
  return w;
}

function allText(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (e.isFile()) out += `\n${p}\n${fs.readFileSync(p, 'latin1')}`;
  }
  return out;
}

test('the dry run answers the cost, the steps, the name to type and a seen id; a wrong name is refused; nothing changes', SH_GH, async (tc) => {
  const w = await world(tc, 'cw-dry');
  const d = await w.unchanged('the dry run', () => w.post({ github: true, dryRun: true }));
  assert.equal(d.status, 200, d.message);
  assert.equal(d.json.cost, COST, 'the cost exactly as the command says it');
  assert.equal(d.json.name, 'credentials');
  assert.equal(d.json.github, 'alex/credentials');
  assert.match(d.json.seen, /^[0-9a-f]{16}$/);
  assert.ok(d.json.steps.some((s) => /create the private repository alex\/credentials on GitHub/.test(s)), JSON.stringify(d.json.steps));
  const wrong = await w.unchanged('a wrong name', () => w.post({ github: true, seen: d.json.seen, typed: 'yes' }));
  assert.equal(wrong.status, 400);
  assert.match(wrong.message, /what was typed is not the repository's name/);
  for (const typed of [undefined, '', 'Credentials', 'credentials2']) {
    const r = await w.unchanged(`typed ${JSON.stringify(typed)}`, () => w.post({ github: true, seen: d.json.seen, ...(typed === undefined ? {} : { typed }) }));
    assert.equal(r.status, 400, `typed ${JSON.stringify(typed)}`);
  }
  w.clean();
});

test('his typed yes runs the command\'s step as the page\'s job: a private repository, the map, the folder 700', SH_GH, async (tc) => {
  const w = await world(tc, 'cw-real');
  const d = await w.post({ github: true, dryRun: true });
  const r = await w.post({ github: true, seen: d.json.seen, typed: ' credentials ' });
  assert.deepEqual(r.json, { started: true, kind: 'credentials' });
  const again = await w.post({ github: true, seen: d.json.seen, typed: 'credentials' });
  const j = await w.job();
  assert.equal(j.result.ok, true, j.lines.join('\n'));
  assert.ok(j.lines.some((l) => /created the private repository alex\/credentials on GitHub/.test(l)), j.lines.join('\n'));
  assert.ok(j.lines.some((l) => /restore clones it right after the brain/.test(l)));
  assert.ok([409, 400].includes(again.status), 'a second start while one runs, or a plan that changed, is refused');
  assert.equal(fs.readFileSync(path.join(w.server, 'created.log'), 'utf8'), 'alex/credentials --private\n');
  assert.equal(readMap(w.ws).map.credentials.url, 'https://github.com/alex/credentials.git');
  if (process.platform !== 'win32') assert.equal(fs.statSync(w.creds).mode & 0o777, 0o700);
  assert.equal(w.sh(path.join(w.server, 'alex', 'credentials.git'), 'log', '--format=%s', 'main'), 'Credentials');
  const st = (await w.call('GET', '/api/workspace/credentials')).json;
  assert.equal(st.folder, 'repository');
  assert.equal(st.map, 'https://github.com/alex/credentials.git');
  assert.equal(st.mapVersion, 2);
  w.clean();
});

test('refused with nothing changed: a stale plan, an unknown key, Tia, a relayed request with her mark, a public repository', SH_GH, async (tc) => {
  const w = await world(tc, 'cw-refuse');
  w.bare('alex/credentials.git');
  const d = await w.post({ repo: gh('credentials'), dryRun: true });
  assert.equal(d.status, 200, d.message);
  assert.equal(d.json.name, 'credentials');
  assert.match(d.json.visibility, /GitHub says it is private/);
  const yes = { repo: gh('credentials'), seen: d.json.seen, typed: 'credentials' };
  const cases = [
    ['an unknown key', { ...yes, force: true }, {}, 400, /is not something this takes/],
    ['dryRun not a boolean', { ...yes, dryRun: 'yes' }, {}, 400, /true or false/],
    ['both github and repo', { ...yes, github: true }, {}, 400, /say one/],
    ['no seen id', { repo: gh('credentials'), typed: 'credentials' }, {}, 400, /seen is the plan/],
    ['Tia\'s token', yes, { headers: { authorization: 'Bearer tia_0123456789abcdef' } }, 403, /owner's only/],
    ['Tia\'s own door', yes, { by: 'self' }, 403, /owner's own step/],
    ['a relayed request with her mark', yes, { by: 'computer', headers: { 'x-hoprig-self': '1' } }, 403, /owner's own step/],
    ['another computer\'s token', yes, { by: 'computer' }, 403, /only from your own page/],
  ];
  for (const [what, body, o, status, re] of cases) {
    const r = await w.unchanged(what, () => w.post(body, o));
    assert.equal(r.status, status, `${what}: ${r.message}`);
    assert.match(r.message, re, what);
  }
  // A file added after he looked: the plan is another one (two files to commit), refused in one sentence.
  fs.writeFileSync(path.join(w.creds, 'shop', 'more.env'), `B=${VALUE}\n`);
  await new Promise((r) => setTimeout(r, 20));
  const stale = await w.unchanged('a stale plan', () => w.post(yes));
  assert.equal(stale.status, 409);
  assert.equal(stale.message, 'This changed since you looked: look again.');
  // Public on GitHub: the dry run itself refuses, in the command's words.
  fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
  const pub = await w.unchanged('public', () => w.post({ repo: gh('credentials'), dryRun: true }));
  assert.equal(pub.status, 409);
  assert.match(pub.message, /is refused: it is public on GitHub\. Hoprig pushes credentials only to a private repository/);
  assert.equal(readMap(w.ws).map.credentials, undefined);
  assert.equal(fs.existsSync(path.join(w.creds, '.git')), false);
  w.clean();
});

test('another server: only with his word that it is private; then it is pushed', async (tc) => {
  const w = await world(tc, 'cw-other');
  w.bare('other/team/creds-box.git');
  const url = 'https://git.example.test/team/creds-box.git';
  const d = await w.post({ repo: url, dryRun: true });
  assert.equal(d.json.github, null);
  assert.equal(d.json.name, 'creds-box');
  assert.match(d.json.visibility, /cannot ask whether it is private: you confirm that it is/);
  const no = await w.unchanged('not confirmed', () => w.post({ repo: url, seen: d.json.seen, typed: 'creds-box' }));
  assert.equal(no.status, 400);
  assert.match(no.message, /you confirm that it is/);
  const r = await w.post({ repo: url, seen: d.json.seen, typed: 'creds-box', confirmNotGithub: true });
  assert.equal(r.status, 200, r.message);
  const j = await w.job();
  assert.equal(j.result.ok, true, j.lines.join('\n'));
  assert.equal(readMap(w.ws).map.credentials.url, url);
  w.clean();
});

test('made public between his yes and the push: the job asks again, pushes nothing and undoes what it did', SH_GH, async (tc) => {
  const w = await world(tc, 'cw-flip');
  w.bare('alex/credentials.git');
  const { capture } = await import('../../src/setup/system.mjs');
  // The moment the remote is set (after his yes, before the push), someone makes the repository public on GitHub.
  const run = (argv, o) => {
    if (argv[0] === 'git' && argv.includes('remote') && argv.includes('add')) fs.writeFileSync(path.join(w.server, 'alex', 'visibility.json'), JSON.stringify({ credentials: 'PUBLIC' }));
    return capture(argv, o);
  };
  w.feature = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: () => 'page' }, { dir: w.ws, projectsDir: () => w.projects, run });
  const d = await w.post({ repo: gh('credentials'), dryRun: true });
  assert.equal((await w.post({ repo: gh('credentials'), seen: d.json.seen, typed: 'credentials' })).status, 200);
  const j = await w.job();
  assert.equal(j.result.ok, false);
  assert.ok(j.lines.some((l) => /is refused: it is public on GitHub: what this run did in the folder was undone/.test(l)), j.lines.join('\n'));
  assert.equal(fs.existsSync(path.join(w.creds, '.git')), false);
  assert.equal(w.sh(path.join(w.server, 'alex', 'credentials.git'), 'for-each-ref'), '', 'nothing pushed');
  assert.equal(readMap(w.ws).map.credentials, undefined);
  w.clean();
});

test('a map of version 1: the state says so, and the step is refused with the upgrade named', async (tc) => {
  const w = await world(tc, 'cw-v1', { v2: false });
  const st = await w.unchanged('the state', () => w.call('GET', '/api/workspace/credentials'));
  assert.deepEqual(st.json, { folder: 'folder', ownerOnly: true, short: path.join('~', 'Workspace', 'credentials'), mapVersion: 1 });
  const r = await w.unchanged('version 1', () => w.post({ github: true, dryRun: true }));
  assert.equal(r.status, 409);
  assert.match(r.message, /the map is of version 1/);
  w.clean();
});

test('over HTTP: another site and a call without the sign-in are refused before anything is asked', async (tc) => {
  const w = await world(tc, 'cw-http');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [w.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `credweb-${process.pid}` });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = async (body, headers) => {
      const r = await fetch(`${origin}/api/workspace/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const text = await r.text();
      w.said.push(text);
      return r.status;
    };
    const look = await fetch(`${origin}/api/workspace/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify({ github: true, dryRun: true }) });
    const seen = (await look.json()).seen;
    const yes = { github: true, seen, typed: 'credentials' };
    assert.equal(await post(yes, { Cookie: cookie, Origin: 'http://evil.example' }), 403, 'another site');
    assert.ok([401, 403].includes(await post(yes, {})), 'no sign-in');
    assert.ok([401, 403].includes(await post(yes, { Authorization: 'Bearer tia_0123456789abcdef', Cookie: cookie, Origin: origin })), 'Tia\'s token with the cookie');
    const g = await fetch(`${origin}/api/workspace/credentials`, { headers: { Cookie: cookie } });
    const st = await g.json();
    w.said.push(JSON.stringify(st));
    assert.equal(st.folder, 'folder');
    assert.equal(fs.existsSync(path.join(w.server, 'created.log')), false, 'nothing created');
    assert.equal(fs.existsSync(path.join(w.creds, '.git')), false);
    assert.equal(readMap(w.ws).map.credentials, undefined);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
  w.clean();
});
