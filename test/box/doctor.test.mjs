// The box (docs/BOX.md), the doctor's part: ONE line, an information line (never a cross, never a warning) that says this
// computer has a box, or has none and what would give it one. The self-test runs only inside `hoprig doctor` as a
// person runs it: the checks the dashboard or the upkeep ask for have no box line and start no self-test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeBin, pathWith, scratch } from '../setup/helpers.mjs';
import { CLOSED_PORT, closedGateways, sealed } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'hoprig.mjs');
const { boxLine } = await import('../../src/box/doctorline.mjs');
const { doctor } = await import('../../src/setup/doctor.mjs');
const { boxCheck } = await import('../../src/box/box.mjs');
const { sysInfo } = await import('../../src/setup/checks.mjs');
// A computer with no programs at all for the doctor run in this process: it reaches no systemctl, tmux or claude.
// Its dashboard's port is one of its own (PORT): the doctor probes the port a dashboard would listen on, never 7433.
const bare = path.join(s.tmp, 'bare');
const SYS = sysInfo({ env: sealed({ HOME: s.env.HOME, PATH: pathWith(bare, fakeBin(path.join(bare, 'bin'), {})), PORT: String(CLOSED_PORT), NO_COLOR: '1' }), has: () => false, pm: null, root: false, ownGateways: false });
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

const NO = async () => ({ ok: false, kind: null, why: 'bubblewrap is not installed', step: 'install bubblewrap (for example: sudo apt install bubblewrap)' });
const YES = async () => ({ ok: true, kind: 'bwrap', why: '', step: '' });
const PARTS = {
  pc: async () => [],
  skills: async () => ({ user: { installed: [], suggested: [] }, updates: [], checked: true }),
  workspace: async () => ({ id: 'workspace', label: 'Workspace', status: 'ok', detail: 'here', fix: '' }),
};

test('the line: information either way, with the why and the step when there is none', async () => {
  const yes = await boxLine(YES);
  assert.equal(yes.status, 'info');
  assert.match(yes.detail, /^this computer has one \(bwrap\)/);
  const no = await boxLine(NO);
  assert.equal(no.status, 'info');
  assert.equal(no.fix, '', 'no fix line: a missing box is not a problem to fix');
  assert.equal(no.detail, 'this computer has none: bubblewrap is not installed; what would give it one: install bubblewrap (for example: sudo apt install bubblewrap)');
  const threw = await boxLine(async () => { throw new Error('boom'); });
  assert.equal(threw.status, 'info');
  assert.match(threw.detail, /boom/);
});

test('in the doctor: one line under This computer, and a missing box never changes the exit code', async () => {
  let out = '';
  const write = (t) => (out += t);
  const without = await doctor(['--offline', '--json'], { write: () => {}, parts: PARTS, sys: SYS });
  const code = await doctor(['--offline', '--json'], { write, parts: PARTS, sys: SYS, box: () => boxLine(NO) });
  assert.equal(code, without, 'the same exit code with a box line saying no');
  const groups = JSON.parse(out).groups;
  const lines = groups.flatMap((g) => g.checks.filter((c) => c.id === 'box').map((c) => ({ ...c, group: g.title })));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].group, 'This computer');
  assert.equal(lines[0].status, 'info');
  let text = '';
  await doctor(['--offline'], { write: (t) => (text += t), parts: PARTS, sys: SYS, box: () => boxLine(NO) });
  assert.match(text, /· A box for commands\s+this computer has none: bubblewrap is not installed/);
  assert.doesNotMatch(text, /[✗!] A box for commands/);
});

test('the checks others ask for have no box line, and only hoprig doctor itself starts the self-test', async () => {
  let asked = 0;
  await doctor(['--offline', '--json'], { write: () => {}, parts: PARTS, sys: SYS });
  const { overview } = await import('../../src/setup/overview.mjs');
  const list = await overview({ sys: SYS, offline: true, parts: PARTS });
  assert.equal(list.some((c) => c.id === 'box'), false, 'the overview (the page, the upkeep) has no box line');
  await doctor(['--offline', '--json'], { write: () => {}, parts: PARTS, sys: SYS, box: () => (asked++, boxLine(NO)) });
  assert.equal(asked, 1);
  // Who imports the doctor's line: the command's own dispatch only.
  const users = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })) {
    if (!String(f).endsWith('.mjs') || String(f).startsWith('box')) continue;
    if (/(from\s*|import\(\s*)['"][^'"]*box\/doctorline\.mjs['"]/.test(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'))) users.push(String(f));
  }
  assert.deepEqual(users, [path.join('setup', 'cli.mjs')]);
});

test('in the real box: hoprig doctor, run as a person runs it in a temporary home, says this computer has one', { skip, timeout: 120_000 }, () => {
  const root = path.join(s.tmp, 'real');
  const env = sealed({
    HOME: path.join(root, 'home'),
    HOPRIG_CONFIG_DIR: path.join(root, 'config'),
    HOPRIG_STATE_DIR: path.join(root, 'state'),
    HOPRIG_WORKSPACE_DIR: path.join(root, 'ws'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    PATH: pathWith(root, fakeBin(path.join(root, 'bin'), {})),
    PORT: String(CLOSED_PORT), // the dashboard's port is one of its own, never 7433
    NO_COLOR: '1',
  });
  fs.mkdirSync(env.HOME, { recursive: true });
  // The gateways have ports of their own: a copy of one on this computer is never asked on its default port.
  fs.mkdirSync(env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ addons: closedGateways() }));
  const r = spawnSync(process.execPath, [BIN, 'doctor', '--offline'], { env, cwd: env.HOME, encoding: 'utf8', timeout: 100_000 });
  assert.match(r.stdout, /· A box for commands\s+this computer has one \(bwrap\)/, r.stdout + r.stderr);
});
