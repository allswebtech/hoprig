// The automation "keep the workspace in step" (off by default, pushing a switch of its own), the command in every
// shell (~/.local/bin and the PATH lines, added once), and the doctor's workspace lines.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from './helpers.mjs';

const t = tempHome('ws-care');
test.after(() => t.cleanup());
const rule = await import('../../src/automation/workspacesync.mjs');
const { DEFAULTS, cleanSettingsPatch } = await import('../../src/automation/settings.mjs');
const { ensureCommand, commandCheck, wrapperText, MARK } = await import('../../src/setup/localbin.mjs');
const H = 3600_000;

test('the rule: off by default; every few hours; pushes only when that is on too; tells a list once', async () => {
  assert.deepEqual(DEFAULTS.workspace, { map: true, commitMap: false, sync: false, push: false, everyHours: 6 });
  assert.deepEqual(rule.decide({ data: {}, now: 10 * H, settings: DEFAULTS.workspace }).actions, [{ type: 'map', commit: false, push: false }], 'only the map upkeep is on by default');
  const on = { sync: true, push: false, everyHours: 6 };
  const d = rule.decide({ data: {}, now: 10 * H, settings: on });
  assert.deepEqual(d.actions, [{ type: 'sync', push: false }]);
  assert.deepEqual(rule.decide({ data: d.data, now: 15 * H, settings: on }).actions, []);
  assert.deepEqual(rule.decide({ data: d.data, now: 16 * H, settings: { ...on, push: true } }).actions, [{ type: 'sync', push: true }]);
  assert.throws(() => cleanSettingsPatch({ workspace: { everyHours: 0 } }, DEFAULTS), /1 to 168/);
  assert.equal(cleanSettingsPatch({ workspace: { sync: true } }, DEFAULTS).workspace.push, false);

  const told = [];
  const records = [];
  let saved = {};
  const result = { repos: [{ label: 'ai_brain', did: ['pulled 2'], todo: [] }, { label: 'shop', did: [], todo: [{ why: 'main and its upstream have both moved', command: 'git …' }] }] };
  const ctx = { record: (e) => records.push(e), notify: (e) => told.push(e), data: {}, save: (x) => (saved = x), workspaceSync: async ({ push }) => (assert.equal(push, false), result) };
  await rule.apply([{ type: 'sync', push: false }], ctx);
  assert.equal(told.length, 1);
  assert.match(records[0].did, /ai_brain: pulled 2/);
  await rule.apply([{ type: 'sync', push: false }], { ...ctx, data: saved });
  assert.equal(told.length, 1, 'the same list is not told twice');
  await rule.apply([{ type: 'sync', push: false }], { ...ctx, workspaceSync: async () => { throw new Error('offline'); } });
  assert.match(records.at(-1).outcome, /failed: offline/);
});

test('the command in every shell: two small scripts and one PATH line per shell file, added once; a file not ours is left', () => {
  if (process.platform === 'win32') return;
  const home = path.join(t.root, 'cmd-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bashrc'), '# ~/.bashrc\ncase $- in *i*) ;; *) return ;; esac\nexport NVM_DIR="$HOME/.nvm"\n');
  const node = process.execPath;
  const script = path.resolve('bin/hoprig.mjs');
  const dry = ensureCommand({ home, shell: '/bin/bash', platform: 'linux', node, script, dryRun: true });
  assert.ok(dry.did.length >= 4);
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'hoprig')), false);
  const r = ensureCommand({ home, shell: '/bin/bash', platform: 'linux', node, script });
  assert.deepEqual(r.did.map((l) => l.replace(home, '~')), ['wrote ~/.local/bin/hoprig', 'wrote ~/.local/bin/hop', 'added ~/.local/bin to PATH in ~/.profile', 'added ~/.local/bin to PATH in ~/.bashrc']);
  assert.equal(fs.readFileSync(path.join(home, '.local', 'bin', 'hop'), 'utf8'), wrapperText(node, script));
  const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.ok(bashrc.startsWith('case ":$PATH:"') && bashrc.indexOf(MARK) < bashrc.indexOf('return'), 'before the line that stops a non-interactive shell');
  assert.deepEqual(ensureCommand({ home, shell: '/bin/bash', platform: 'linux', node, script }).did, [], 'a second run adds nothing');
  // zsh reads ~/.zshenv in every shell; a file of npm's own in ~/.local/bin is left alone.
  fs.writeFileSync(path.join(home, '.local', 'bin', 'hop'), '#!/bin/sh\n# npm\n');
  const z = ensureCommand({ home, shell: '/bin/zsh', platform: 'linux', node, script });
  assert.ok(z.did.some((l) => l.endsWith('.zshenv')));
  assert.ok(z.kept[0].endsWith('hop is not ours: left as it is'));
  // The written script really starts Hoprig without anything else on PATH.
  const out = execFileSync(path.join(home, '.local', 'bin', 'hoprig'), ['version'], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' });
  assert.match(out, /^\d+\.\d+\.\d+/);
  assert.equal(commandCheck({ home, platform: 'linux' }).status, 'ok');
  fs.writeFileSync(path.join(home, '.local', 'bin', 'hoprig'), wrapperText('/nowhere/node', script));
  assert.equal(commandCheck({ home, platform: 'linux' }).status, 'warn');
  assert.equal(commandCheck({ home: path.join(t.root, 'nobody'), platform: 'linux' }).fix, 'hoprig setup');
});

test('doctor: the tree, the brain on a git server or not, the map against this computer', async () => {
  const { workspaceChecks } = await import('../../src/workspace/doctor.mjs');
  const { workspaceSetup } = await import('../../src/workspace/setup.mjs');
  const none = await workspaceChecks();
  assert.deepEqual(none.map((c) => [c.id, c.status]), [['workspace', 'info']]);
  await workspaceSetup();
  const made = await workspaceChecks();
  assert.deepEqual(made.map((c) => c.id), ['workspace', 'workspace-brain', 'workspace-map']);
  assert.equal(made[1].status, 'warn');
  assert.match(made[1].detail, /not on a git server yet/);
  assert.equal(made[2].status, 'info');
  assert.match(made[2].detail, /none yet/);
});
