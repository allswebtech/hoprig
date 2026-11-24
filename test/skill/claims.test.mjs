// What the skill's hand-written part says about the program, held to what the program does: which update command
// takes which copy, what only looks, and which commands hand out a sign-in and stay the user's own steps.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, probeEnv } from '../../tools/build-skill.mjs';
import { sealed, sealedPath } from '../seal.mjs';

const SKILL = fs.readFileSync(path.join(ROOT, 'templates/skills/hoprig/SKILL.md'), 'utf8');
const HOPRIG = path.join(ROOT, 'bin/hoprig.mjs');
const NPX = path.join(ROOT, 'packages/hoprig-skill/bin/hoprig-skill.mjs');

function tempHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claims-')));
  // doctor asks systemd whether user services run here: a stand-in says no, before the runner's traps.
  const standIns = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-bin-'));
  for (const name of ['systemctl', 'loginctl']) fs.writeFileSync(path.join(standIns, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // doctor and pc also probe the coding tool, tmux, gh and tailscale: they are found on PATH and then run (claude and
  // tmux by their full path). Harmless stand-ins answer, so the owner's real Claude Code and GitHub sign-ins, real
  // tmux and real tailscale are never read. Each answers --version and reports "not there / not signed in" otherwise.
  const standIn = (name, body) => fs.writeFileSync(path.join(standIns, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  standIn('claude', 'case "$1" in --version) echo "1.0.0";; *) exit 1;; esac');
  standIn('gh', 'case "$1" in --version) echo "gh version 2.0.0 (2024-01-01)";; *) exit 1;; esac');
  standIn('docker', 'case "$1" in --version) echo "Docker version 24.0.0, build abc0123";; *) exit 1;; esac');
  standIn('tmux', '[ "$1" = "-V" ] && echo "tmux 3.4" || exit 1');
  standIn('tailscale', 'exit 1');
  const env = sealed({ ...probeEnv(home), PORT: '0', PATH: sealedPath([standIns, process.env.PATH]) });
  const run = (bin, ...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd: home, encoding: 'utf8', timeout: 60_000, input: '' });
  return { home, run, done: () => [home, standIns].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

/** The sentence of SKILL.md that holds `needle`, joined over its line breaks. */
const sentence = (needle) => SKILL.replace(/\n\s*/g, ' ').split(/(?<=\.)\s+(?=[A-Z0-9*`-])/).find((s) => s.includes(needle)) || '';

test('a copy from npx hoprig-skill is not updated by hop skills update, and the skill says how it is', () => {
  const t = tempHome();
  try {
    assert.equal(t.run(NPX, '--claude').status, 0);
    const r = t.run(HOPRIG, 'skills', 'update', 'hoprig', '--check');
    assert.notEqual(r.status, 0, 'if hop skills update learns to take a copy from npx, change the skill\'s sentence');
    assert.match(r.stdout + r.stderr, /not installed by Hoprig/);
  } finally {
    t.done();
  }
  const line = sentence('`hop skills update`');
  assert.match(line, /Hoprig installed/, line);
  assert.match(SKILL.replace(/\n\s*/g, ' '), /A copy from `npx hoprig-skill` is updated by running that command again/);
  assert.doesNotMatch(line, /newer versions, this one too\./);
});

test('what the skill lists under "Look first" changes nothing of the user\'s; the two that refresh files are named', () => {
  const look = /\*\*Look first\.\*\*([\s\S]*?)\n2\. /.exec(SKILL)[1];
  const commands = [...new Set([...look.matchAll(/`hop ([^`]+)`/g)].map((m) => m[1]))];
  assert.ok(commands.length >= 9, look);
  // A coding tool's or gh's own state, Hoprig's own note of the Claude sign-in and a field report of a doctor run with a
  // cross (src/field): no file of the user's.
  const OWN = /^(\.claude(\/\.claude\.json(\.lock)?|\/backups(\/\.claude\.json\.backup\.\d+)?)?|\.local(\/state(\/gh(\/device-id)?)?)?|state(\/claude-login\.json|\/field(\/reports(\/\d{8}T\d{6}Z-[0-9a-f]{16}\.json)?)?)?)$/;
  const writers = [];
  for (const c of commands) {
    const t = tempHome();
    try {
      const args = c.split(' ');
      if (['doctor', 'pc', 'skills'].includes(args[0])) args.push('--offline'); // no network in a test
      const r = t.run(HOPRIG, ...args);
      assert.equal(r.error, undefined, `hop ${c} ended by itself`);
      const left = fs.readdirSync(t.home, { recursive: true }).map((p) => p.split(path.sep).join('/'));
      assert.deepEqual(left.filter((p) => !OWN.test(p)), [], `hop ${c} wrote a file of the user's`);
      if (left.length) writers.push(c);
    } finally {
      t.done();
    }
  }
  assert.doesNotMatch(look, /only read/);
  for (const c of writers) assert.match(look, new RegExp(`\`hop ${c}\`[^.]*refresh`), `the skill says that hop ${c} refreshes its own files`);
});

test('the commands that hand out a sign-in or open the dashboard are the user\'s own steps, not the AI\'s', () => {
  const own = sentence('are the user\'s own steps');
  for (const c of ['hop link', 'hop pair', 'hop machines invite', 'hop public on', 'hop gateways add', 'hop passwd']) {
    assert.ok(own.includes(`\`${c}`), `${c} is named a user's own step: ${own}`);
  }
  assert.match(own, /do not run it/);
});

test('the skill says where --help is safe: after a subcommand some commands take it as a value and act', () => {
  const t = tempHome();
  let acted;
  try {
    t.run(HOPRIG, 'auto', 'on', '--help');
    const file = path.join(t.home, 'config', 'config.json');
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    acted = !!(cfg.autoSwitch && cfg.autoSwitch.enabled);
  } finally {
    t.done();
  }
  const text = SKILL.replace(/\n\s*/g, ' ');
  // When the program learns to print the help there, the warning goes from the skill too.
  if (acted) assert.match(text, /Put `--help` right after the command word[^.]*`hop auto on --help` turns Auto mode on/);
  else assert.doesNotMatch(text, /`hop auto on --help` turns Auto mode on/);
});
