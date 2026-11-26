// The doctor's whole-product view: six groups, the computer's checks folded in, skills, a hub without coding parts.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, scratch, windowsFacts } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({});
// The doctor asks the dashboard's port whether a dashboard answers: a free port, never the default one, where the
// computer running the tests may have its own dashboard.
(await import('../../src/config.mjs')).saveConfig({ server: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } });
const K = await import('../../src/setup/checks.mjs');
const O = await import('../../src/setup/overview.mjs');
const D = await import('../../src/setup/doctor.mjs');
const { which } = await import('../../src/setup/system.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: true }), tmux: 'echo "tmux 3.4"' });
const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
const sys = K.sysInfo({ env, has: (c) => !!which(c, env, process.platform), pm: null, root: false, run: windowsFacts(env) }); // run: Windows' whoami answers as facts

const PC = [
  { id: 'updates', label: 'System updates', status: 'ok', detail: 'none waiting', fix: '', group: 'system' },
  { id: 'node.node', label: 'Node.js', status: 'fail', detail: 'missing', fix: 'nvm install --lts', group: 'kit:node' },
  { id: 'claude', label: 'Claude Code', status: 'ok', detail: 'dup', fix: '', group: 'claude' },
  { id: 'login', label: 'Claude login', status: 'ok', detail: 'dup', fix: '', group: 'claude' },
  { id: 'rules', label: 'Working rules', status: 'info', detail: 'not added', fix: 'hoprig pc setup --rules', group: 'claude' },
  { id: 'projects', label: 'Projects folder', status: 'ok', detail: '~/projects · 1 repository', fix: '', group: 'projects' },
];
const SKILLS = { user: { installed: [], suggested: [{ id: 'hoprig', name: 'hoprig', why: ['it comes with Hoprig and helps in every project'], command: 'hoprig skills add hoprig --user' }] }, project: null, updates: [{ scope: 'user', name: 'pdf', latest: 'abc', edited: false }], checked: true };
const parts = { pc: async () => PC, skills: async () => SKILLS };

test('six groups in order; the computer\'s Claude lines are not repeated; a missing coding tool is a suggestion', async () => {
  const list = await O.overview({ sys, offline: true, parts });
  const groups = O.grouped(list).map((g) => g.title);
  assert.deepEqual(groups, ['This computer', 'Claude Code and providers', 'Dashboard', 'Coding tools', 'Projects', 'Skills']);
  assert.equal(list.filter((c) => c.detail === 'dup').length, 0);
  assert.equal(list.find((c) => c.id === 'node.node').status, 'warn');
  assert.equal(list.find((c) => c.id === 'rules').group, 'Claude Code and providers');
  const sk = list.filter((c) => c.group === 'Skills');
  assert.deepEqual(sk.map((c) => [c.id, c.status, c.fix]), [
    ['skills', 'info', ''],
    ['skill:hoprig', 'warn', 'hoprig skills add hoprig --user'],
    ['skill-update:pdf', 'warn', 'hoprig skills update pdf'],
  ]);
});

test('a hub has no coding tools, projects or skills', async () => {
  const list = await O.overview({ sys, offline: true, hub: true, parts });
  assert.deepEqual(O.grouped(list).map((g) => g.title), ['This computer', 'Claude Code and providers', 'Dashboard']);
});

test('a source that cannot be read is one warning, not a crash', async () => {
  const list = await O.overview({ sys, offline: true, parts: { pc: async () => { throw new Error('boom'); }, skills: async () => { throw new Error('bad'); } } });
  assert.match(list.find((c) => c.id === 'pc').detail, /could not be checked: boom/);
  assert.match(list.find((c) => c.group === 'Skills').detail, /could not be checked: bad/);
});

test('doctor --json: { ok, groups: [{ title, checks }] }, the printed view grouped with fix lines', async () => {
  let out = '';
  await D.doctor(['--offline', '--json'], { write: (t) => (out += t), sys, parts });
  const j = JSON.parse(out);
  assert.equal(typeof j.ok, 'boolean');
  assert.deepEqual(j.groups.map((g) => g.title).slice(-3), ['Coding tools', 'Projects', 'Skills']);
  assert.equal(j.groups.flatMap((g) => g.checks).some((c) => 'group' in c), false);
  let text = '';
  await D.doctor(['--offline'], { write: (t) => (text += t), sys, parts });
  assert.match(text, /\nCoding tools\n.*Node\.js.*missing\n.*fix: nvm install --lts/);
  assert.match(text, /\nSkills\n/);
});

test('doctor: the Claude sign-in names the dashboard\'s own way beside the terminal line', async () => {
  const K = await import('../../src/setup/checks.mjs');
  const notIn = K.loginCheck({ loggedIn: false }, [{ name: 'login', kind: 'login' }]);
  const text = D.formatResults([notIn]);
  assert.match(text, /fix:.*claude auth login/, 'the terminal line stays');
  assert.match(text, /or:.*Home → Get started → Sign in to Claude/, 'and the page way is named');
  assert.doesNotMatch(D.formatResults([K.loginCheck({ loggedIn: true }, [])]), /Get started/, 'nothing when signed in');
});
