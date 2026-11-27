// The automation "keep the workspace in step" (off by default, pushing a switch of its own), the command in every
// shell (~/.local/bin and the PATH lines, added once), and the doctor's workspace lines.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from './helpers.mjs';
import { sealed } from '../seal.mjs';

const t = tempHome('ws-care');
test.after(() => t.cleanup());
const rule = await import('../../src/automation/workspacesync.mjs');
const { DEFAULTS, cleanSettingsPatch } = await import('../../src/automation/settings.mjs');
const { ensureCommand, commandCheck, wrapperText, MARK } = await import('../../src/setup/localbin.mjs');
const H = 3600_000;

test('the rule: off by default; every few hours; pushes only when that is on too; tells a list once', async () => {
  assert.deepEqual(DEFAULTS.workspace, { map: true, commitMap: null, memory: false, sync: false, push: false, pushBranches: {}, everyHours: 6, credentials: false, onlyHere: false, servers: false, ffProjects: { projects: true } }, 'commitMap: never chosen, it follows the brain; memory and pushing the other branches off');
  assert.deepEqual(rule.decide({ data: {}, now: 10 * H, settings: DEFAULTS.workspace }).actions, [{ type: 'map', commit: false, push: false, memory: false }, { type: 'look', ff: { projects: true } }], 'the map upkeep and the look at the projects are on by default');
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
  // Once: projects are no longer kept in step by it (an owner who had it on relied on that); then the list to decide.
  assert.equal(told.length, 2);
  assert.match(told[0].title, /a project is kept in step when you ask/);
  assert.match(records[0].did, /ai_brain: pulled 2/);
  await rule.apply([{ type: 'sync', push: false }], { ...ctx, data: saved });
  assert.equal(told.length, 2, 'the same list is not told twice, nor the note');
  await rule.apply([{ type: 'sync', push: false }], { ...ctx, workspaceSync: async () => { throw new Error('offline'); } });
  assert.match(records.at(-1).outcome, /failed: offline/);
});

test('npm\'s own link to this Hoprig in ~/.local/bin is left without a word; a link to another Hoprig is named', () => {
  if (process.platform === 'win32') return;
  const home = path.join(t.root, 'npm-link-home');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = path.resolve('bin/hoprig.mjs');
  // What `npm install -g --prefix ~/.local` leaves: links to the package's own bin file.
  for (const n of ['hoprig', 'hop']) fs.symlinkSync(script, path.join(bin, n));
  const r = ensureCommand({ home, shell: '/bin/bash', platform: 'linux', node: process.execPath, script });
  assert.deepEqual(r.kept, [], 'no "is not ours" line for what npm itself just put there');
  assert.equal(fs.lstatSync(path.join(bin, 'hoprig')).isSymbolicLink(), true, 'left as it is');
  const other = path.join(home, 'other-hoprig.mjs');
  fs.writeFileSync(other, '');
  fs.rmSync(path.join(bin, 'hop'));
  fs.symlinkSync(other, path.join(bin, 'hop'));
  const o = ensureCommand({ home, shell: '/bin/bash', platform: 'linux', node: process.execPath, script });
  assert.deepEqual(o.kept.map((l) => l.replace(home, '~')), ['~/.local/bin/hop is not ours: left as it is']);
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
  const out = execFileSync(path.join(home, '.local', 'bin', 'hoprig'), ['version'], { env: sealed({ PATH: '/usr/bin:/bin', HOME: home }), encoding: 'utf8' });
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

test('save a change of the map: never chosen follows the brain\'s address; a choice always wins; the page and Tia see true or false', async () => {
  const { commitMapState, effectiveSettings, readSettings } = await import('../../src/automation/settings.mjs');
  const { remoteOf } = await import('../../src/workspace/layout.mjs');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  assert.deepEqual(commitMapState({ commitMap: null }, 'git@github.com:me/brain.git'), { on: true, chosen: false, github: true });
  assert.deepEqual(commitMapState({ commitMap: null }, 'https://git.example.com/brain.git'), { on: true, chosen: false, github: false });
  assert.deepEqual(commitMapState({ commitMap: null }, null), { on: false, chosen: false, github: false });
  assert.deepEqual(commitMapState({ commitMap: false }, 'git@github.com:me/brain.git'), { on: false, chosen: true, github: false }, 'a saved choice wins');
  assert.equal(readSettings({ workspace: { commitMap: false } }).workspace.commitMap, false, 'an existing config keeps its value');
  assert.equal(readSettings({}).workspace.commitMap, null);
  assert.equal(effectiveSettings(readSettings({}), () => 'x').workspace.commitMap, true);
  assert.equal(effectiveSettings(readSettings({ workspace: { commitMap: false } }), () => { throw new Error('not asked'); }).workspace.commitMap, false);
  // The address is read from the git config, for a plain repository and a worktree.
  const dir = fsm.mkdtempSync(p.join(os.tmpdir(), 'hop-remote-'));
  try {
    const brain = p.join(dir, 'ai_brain');
    fsm.mkdirSync(p.join(brain, '.git'), { recursive: true });
    fsm.writeFileSync(p.join(brain, '.git', 'config'), '[core]\n\tbare = false\n');
    assert.equal(remoteOf(brain), null);
    fsm.writeFileSync(p.join(brain, '.git', 'config'), '[core]\n\turl = not-this\n[remote "origin"]\n\turl = git@github.com:me/brain.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    assert.equal(remoteOf(brain), 'git@github.com:me/brain.git');
    const wt = p.join(dir, 'wt');
    fsm.mkdirSync(p.join(brain, '.git', 'worktrees', 'wt'), { recursive: true });
    fsm.writeFileSync(p.join(brain, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fsm.mkdirSync(wt);
    fsm.writeFileSync(p.join(wt, '.git'), `gitdir: ${p.join(brain, '.git', 'worktrees', 'wt')}\n`);
    assert.equal(remoteOf(wt), 'git@github.com:me/brain.git');
    assert.equal(remoteOf(p.join(dir, 'none')), null);
  } finally {
    fsm.rmSync(dir, { recursive: true, force: true });
  }
});
