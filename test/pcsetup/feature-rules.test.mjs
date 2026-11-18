// The server routes (setup as a job in the page, the terminal only when asked for, strict input, nothing secret in
// any answer), the working rules (never rewriting the user's CLAUDE.md), and the setup flow with a fake runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsetup-feat-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
const R = await import('../../src/pcsetup/rules.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TOKEN = 'gho_' + 'Z'.repeat(36);

function harness(over = {}) {
  const created = [];
  const sctx = {
    readJson: async (req) => req.body || {},
    backend: { list: async () => [] },
    // deck.terminal: every terminal the dashboard starts goes through it (src/server/deck.mjs: a launch file).
    deck: { launcher: () => ['node', '/app/bin/hoprig.mjs'], terminal: async (o) => created.push(o) },
  };
  const checks = [
    { group: 'kit:extras', id: 'extras.tmux', label: 'tmux', status: 'fail', detail: 'missing', fix: 'sudo apt-get install -y tmux', fixKit: 'extras' },
    { group: 'system', id: 'clock', label: 'Clock', status: 'ok', detail: 'in sync', fix: '' },
  ];
  const sys = { platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, env: process.env, has: (b) => b === 'gh', exists: () => false, clt: true, run: async (argv) => (argv[0] === 'gh' && argv[1] === 'auth' ? { ok: true, stdout: `  ✓ Logged in to github.com account octo (keyring)\n  - Token: ${TOKEN}\n`, stderr: '' } : argv[0] === 'gh' ? { ok: true, stdout: JSON.stringify([{ nameWithOwner: 'octo/app', url: 'https://github.com/octo/app', isPrivate: true }, { nameWithOwner: 'x/evil', url: 'file:///etc', isPrivate: false }]) } : { ok: false, stdout: '', stderr: '' }) };
  const runs = [];
  const runPcSetup = async (o) => {
    runs.push({ kits: o.kits, recipe: o.recipe });
    o.onStep(0, { why: 'refresh the package lists', argv: ['sudo', 'apt-get', 'update'] }, 'ok');
    return { ok: true, missing: [], changed: true };
  };
  const f = pcsetupFeature(sctx, { sys, status: async () => checks, projectsDir: () => path.join(tmp, 'projects'), run: sys.run, rules: () => ({ ok: true, said: ['x'] }), runPcSetup, sudoNeedsPassword: async () => false, ...over });
  const call = async (method, p, body) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  return { call, created, runs };
}
const settle = async (call) => {
  for (let i = 0; i < 50; i++) {
    const j = await call('GET', '/api/pcsetup/job?from=0');
    if (!j.running) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the job did not end');
};

test('setup and fix run as a job in the page; the terminal only when asked for, with fixed arguments', async () => {
  const { call, created, runs } = harness();
  assert.deepEqual(await call('POST', '/api/pcsetup/setup', { kits: ['basics', 'extras'] }), { started: true });
  const j = await settle(call);
  assert.deepEqual([j.kind, j.result.ok, j.steps], ['setup', true, [{ label: 'refresh the package lists', command: 'sudo apt-get update', state: 'ok' }]]);
  assert.deepEqual(runs[0].kits, ['basics', 'extras']);
  assert.equal(created.length, 0, 'no terminal');
  await assert.rejects(call('POST', '/api/pcsetup/setup', { kits: ['basics', '; rm -rf ~'] }), /kits must be/);
  await assert.rejects(call('POST', '/api/pcsetup/setup', { kits: 'basics' }), /kits must be/);
  assert.deepEqual(await call('POST', '/api/pcsetup/fix', { id: 'extras.tmux' }), { started: true });
  await settle(call);
  assert.deepEqual(runs[1].kits, ['extras']);
  await assert.rejects(call('POST', '/api/pcsetup/fix', { id: 'clock' }), /no fix/);
  // The fallback: the same in a terminal session.
  assert.deepEqual(await call('POST', '/api/pcsetup/setup', { kits: ['basics', 'extras'], terminal: true }), { session: 'setup' });
  assert.deepEqual(created[0].argv, ['node', '/app/bin/hoprig.mjs', 'pc', 'setup', '--yes', '--hold', '--no-projects', '--kits', 'basics,extras']);
  await call('POST', '/api/pcsetup/fix', { id: 'extras.tmux', terminal: true });
  assert.deepEqual(created[1].argv.slice(2), ['pc', 'setup', '--yes', '--hold', '--no-projects', '--kits', 'extras']);
});

test('a step that needs a person at the computer (macOS\'s install window) sends the page to the terminal', async () => {
  const mac = { platform: 'darwin', pm: 'brew', root: false, user: 'dev', arch: 'arm64', tmp: '/tmp', home: process.env.HOME, env: process.env, has: (b) => b === 'brew', exists: () => false, clt: false, run: async () => ({ ok: false, stdout: '', stderr: '' }) };
  const { call, runs } = harness({ sys: mac });
  const r = await call('POST', '/api/pcsetup/setup', { kits: ['basics'] });
  assert.equal(r.needsTerminal, true);
  assert.match(r.why, /Apple opens a window/);
  assert.equal(runs.length, 0);
});

test('recipes from the page are validated before anything runs', async () => {
  const { call, created } = harness();
  await assert.rejects(call('POST', '/api/pcsetup/recipe', { text: '{"hoprigRecipe":1,"kits":["basics"],"run":"curl x|sh"}' }), /refused: unknown key "run"/);
  await assert.rejects(call('POST', '/api/pcsetup/recipe', { url: 'http://insecure.example/r.json' }), /https/);
  assert.equal(created.length, 0);
  const r = await call('POST', '/api/pcsetup/recipe', { recipe: { hoprigRecipe: 1, kits: ['node'], repos: ['octo/app'] }, terminal: true });
  assert.equal(r.session, 'recipe');
  const file = created[0].argv.at(-1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hoprigRecipe: 1, kits: ['node'], repos: ['https://github.com/octo/app.git'] });
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  const { call: call2, runs } = harness();
  const j = await call2('POST', '/api/pcsetup/recipe', { recipe: { hoprigRecipe: 1, kits: ['node'], repos: ['octo/app'] } });
  assert.equal(j.started, true);
  await settle(call2);
  assert.deepEqual([runs[0].kits, runs[0].recipe.repos], [['node'], ['https://github.com/octo/app.git']]);
});

test('GitHub list: the account name and safe addresses only; never the token', async () => {
  const { call } = harness();
  const r = await call('GET', '/api/pcsetup/github');
  assert.deepEqual(r, { signedIn: true, account: 'octo', repos: [{ name: 'octo/app', url: 'https://github.com/octo/app', private: true }] });
  const kits = await call('GET', '/api/pcsetup/kits');
  const status = await call('GET', '/api/pcsetup/status');
  for (const x of [r, kits, status]) assert.ok(!JSON.stringify(x).includes(TOKEN) && !JSON.stringify(x).includes('gho_'));
  assert.equal(kits.kits.find((k) => k.id === 'github').items.find((i) => i.id === 'signin').state, 'ok');
});

test('clone, install, project names: every input checked', async () => {
  const { call } = harness();
  await assert.rejects(call('POST', '/api/pcsetup/clone', { repos: ['--upload-pack=x'] }), /Git address/);
  await assert.rejects(call('POST', '/api/pcsetup/clone', { repos: [] }), /1 to 50/);
  await assert.rejects(call('POST', '/api/pcsetup/install', { dir: '../etc' }), /bad project folder/);
  await assert.rejects(call('POST', '/api/pcsetup/install', { dir: 'a/../../b' }), /bad project folder/);
  for (const dir of ['a/b/c', 'a/b', 'x/y/code/z']) await assert.rejects(call('POST', '/api/pcsetup/install', { dir }), (e) => e.status === 400 && /bad project folder/.test(e.message), dir);
  await assert.rejects(call('POST', '/api/pcsetup/project/new', { name: '../x' }), /project name/);
  await assert.rejects(call('POST', '/api/pcsetup/project/clone', { spec: 'file:///x' }), /name, owner\/name or a Git address/);
  await assert.rejects(call('POST', '/api/pcsetup/project/sync', { name: 'nope' }), /no such project/);
  await assert.rejects(call('POST', '/api/pcsetup/rules', { action: 'sudo' }), /add or remove/);
});

test('working rules: one file in <claude dir>/rules/, CLAUDE.md never touched, removed again cleanly', async () => {
  const base = path.join(tmp, 'rules1');
  fs.mkdirSync(base);
  const mine = '# My rules\n\nBe brief.\n';
  fs.writeFileSync(path.join(base, 'CLAUDE.md'), mine);
  const file = path.join(base, 'rules', R.RULES_FILE);
  assert.match(R.addRules({ base }).said.join(' '), /wrote .*hoprig-working-rules\.md/);
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(R.TEMPLATE, 'utf8'), 'the template, nothing more');
  assert.equal(R.rulesState({ base }).edited, false);
  assert.equal(fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf8'), mine, 'CLAUDE.md untouched');
  assert.equal(R.rulesState({ base }).installed, true);
  R.addRules({ base }); // again: nothing changes
  assert.deepEqual(fs.readdirSync(path.join(base, 'rules')), [R.RULES_FILE]);
  R.removeRules({ base });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf8'), mine);
  // a fresh computer: no CLAUDE.md is created
  const base3 = path.join(tmp, 'rules3');
  R.addRules({ base: base3 });
  assert.equal(fs.existsSync(path.join(base3, 'CLAUDE.md')), false);
  assert.ok(fs.existsSync(path.join(base3, 'rules', R.RULES_FILE)));
});

test('working rules: the earlier version\'s import block is taken out and its file moved; edits are kept; a linked CLAUDE.md is never touched', () => {
  // The earlier version: <base>/hoprig/working-rules.md (edited) and a block in CLAUDE.md.
  const base = path.join(tmp, 'rules2');
  fs.mkdirSync(path.join(base, 'hoprig'), { recursive: true });
  fs.writeFileSync(path.join(base, 'hoprig', 'working-rules.md'), 'my own version');
  const mine = '# Mine\n';
  fs.writeFileSync(path.join(base, 'CLAUDE.md'), `${mine}\n${R.OLD_BLOCK}`);
  assert.equal(R.rulesState({ base }).oldBlock, true);
  const r = R.addRules({ base });
  assert.match(r.said.join(' '), /moved your edited rules/);
  assert.match(r.said.join(' '), /took the old import line out/);
  assert.equal(fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf8'), mine);
  assert.equal(fs.readFileSync(path.join(base, 'rules', R.RULES_FILE), 'utf8'), 'my own version');
  assert.equal(fs.existsSync(path.join(base, 'hoprig')), false, 'the old folder is gone once empty');
  R.removeRules({ base });
  assert.equal(fs.readFileSync(path.join(base, 'rules', R.RULES_FILE), 'utf8'), 'my own version', 'an edited copy is never deleted');

  // A CLAUDE.md that is a link (it lives in a git repository) is never written; the user is told.
  const baseL = path.join(tmp, 'rules4');
  fs.mkdirSync(baseL);
  const real = path.join(tmp, 'repo-CLAUDE.md');
  fs.writeFileSync(real, `# from a repo\n${R.OLD_BLOCK}`);
  fs.symlinkSync(real, path.join(baseL, 'CLAUDE.md'));
  const l = R.addRules({ base: baseL });
  assert.equal(l.manual, true);
  assert.match(l.said.join(' '), /is a link: remove the Hoprig working-rules block .* yourself/);
  assert.equal(fs.readFileSync(real, 'utf8'), `# from a repo\n${R.OLD_BLOCK}`);
  assert.ok(fs.existsSync(path.join(baseL, 'rules', R.RULES_FILE)));
});

test('runPcSetup: shows what is there, ONE confirmation, runs the plan, says what is missing; second run: "Everything is here."', async () => {
  const installed = new Set(['curl', 'python3', 'sudo']);
  const out = [];
  const ran = [];
  const sys = await sysFacts({ platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, has: (b) => installed.has(b), exists: () => false,
    run: async (argv) => ({ ok: installed.has(argv[0]) && !(argv[0] === 'git' && argv[1] === 'config') && argv[0] !== 'gh', code: 0, stdout: `${argv[0]} 9.9.9`, stderr: '' }) });
  const runner = async (argv) => {
    ran.push(argv.join(' '));
    if (argv.includes('install')) for (const b of ['git', 'unzip', 'make', 'cc', 'c++', 'tmux', 'rg', 'jq']) installed.add(b);
    return { ok: true, code: 0, output: '' };
  };
  let asked = 0;
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s), askLine: async () => { asked++; return ''; } });
  const r = await runPcSetup({ ui, kits: ['basics', 'extras'], sys, runner });
  const text = out.join('');
  assert.match(text, /✗ Basics: missing git, unzip, C\/C\+\+ build tools/);
  assert.match(text, /Install these 3 steps now\? yes \(--yes\)/);
  assert.equal(asked, 0);
  assert.deepEqual(ran, [
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get update',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y git unzip build-essential python3',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux ripgrep jq',
  ]);
  assert.deepEqual(r, { ok: true, changed: true, missing: [], code: 0 });
  out.length = 0;
  const again = await runPcSetup({ ui, kits: ['basics', 'extras'], sys, runner });
  assert.deepEqual(again, { ok: true, changed: false, missing: [], code: 0 });
  assert.match(out.join(''), /Everything is here\. Nothing to do\./);
  assert.equal(ran.length, 3); // nothing ran again
});
