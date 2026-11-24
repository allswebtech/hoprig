// The one line about root in the doctor's view, and so on Health (which reads the same checks).
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({});
// A free port of its own: the doctor asks whether a dashboard answers there, never on the default port.
(await import('../../src/config.mjs')).saveConfig({ server: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } });
const K = await import('../../src/setup/checks.mjs');
const O = await import('../../src/setup/overview.mjs');
const H = await import('../../src/machines/health.mjs');
const { which } = await import('../../src/setup/system.mjs');
const { CLAUDE_ROOT_REFUSAL } = await import('../../src/setup/rootfacts.mjs');

const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: fakeClaude({ loggedIn: true }), tmux: 'echo "tmux 3.4"' });
const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
delete env.container;
const parts = { pc: async () => [], skills: async () => ({ user: { installed: [], suggested: [] }, updates: [], checked: true }), workspace: async () => [] };
const sysOf = (over) => K.sysInfo({ env, has: (c) => !!which(c, env, process.platform), pm: null, platform: 'linux', exists: () => false, probe: async () => 0, running: async () => null, ...over });
const rootLines = (list) => list.filter((c) => c.id === 'root');

test('as an ordinary user nothing is said about root', async () => {
  assert.deepEqual(rootLines(await O.overview({ sys: sysOf({ root: false }), offline: true, parts })), []);
});

test('as root: one line in This computer, with the coding tool\'s refusal and the move as its one step', async () => {
  const lines = rootLines(await O.overview({ sys: sysOf({ root: true }), offline: true, parts }));
  assert.equal(lines.length, 1);
  const [r] = lines;
  assert.equal(r.group, 'This computer');
  assert.equal(r.status, 'warn');
  assert.ok(r.detail.includes(CLAUDE_ROOT_REFUSAL));
  assert.match(r.fix, /^hoprig move-to-user\b/);
  // Health shows the doctor's checks: the same line goes there whole.
  const [h] = H.healthChecks(lines);
  assert.deepEqual([h.id, h.label, h.status, h.detail, h.fix, h.admin], ['root', r.label, 'warn', r.detail, r.fix, false]);
  // A suggestion, not a problem: the doctor's exit code stays what the rest says.
  assert.equal(K.exitCodeFor(lines), 0);
});

test('as root inside a container: information, naming the fact, and no step', async () => {
  const [r] = rootLines(await O.overview({ sys: sysOf({ root: true, exists: (f) => f === '/run/.containerenv' }), offline: true, parts }));
  assert.equal(r.status, 'info');
  assert.match(r.detail, /inside a container \(\/run\/\.containerenv\)/);
  assert.equal(r.fix, '');
});

test('root is never said on Windows', async () => {
  assert.deepEqual(rootLines(await O.overview({ sys: sysOf({ root: true, platform: 'win32' }), offline: true, parts })), []);
});
