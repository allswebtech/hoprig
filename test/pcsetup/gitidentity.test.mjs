// `project new` and `project add` without a global git identity: the name and e-mail are asked (a terminal), taken
// from --git-name/--git-email or from Hoprig's settings, and given to git with -c for those commands only. The global
// git config is held byte for byte: nothing global is ever set.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from '../workspace/helpers.mjs';

const t = tempHome('gitid');
process.env.HOPRIG_WORKSPACE_DIR = t.ws;
test.after(() => t.cleanup());
// A global config with no identity, as on a fresh computer.
const GLOBAL = process.env.GIT_CONFIG_GLOBAL;
const BYTES = '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n';
fs.writeFileSync(GLOBAL, BYTES);

const { projectNew, projectAdd } = await import('../../src/pcsetup/project.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { quietUi } = await import('./dryrun-fixture.mjs');
const projects = path.join(t.ws, 'projects');
const author = (dir) => execFileSync('git', ['-C', dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'], { encoding: 'utf8' }).trim();

test('no identity anywhere and no terminal: refused before anything is written, with both ways to give one', async () => {
  const ui = await quietUi();
  assert.equal(await projectNew(['alpha', '--no-github'], { ui }), 1);
  assert.match(ui.text(), /--git-name "Your Name" --git-email you@example\.com/);
  assert.equal(fs.existsSync(path.join(projects, 'alpha')), false);
  assert.equal(fs.readFileSync(GLOBAL, 'utf8'), BYTES);
});

test('--git-name and --git-email: the first commit has them, the global config is unchanged', async () => {
  const ui = await quietUi();
  assert.equal(await projectNew(['shop', '--no-github', '--git-name', 'Alex Lee', '--git-email', 'alex@example.com'], { ui }), 0, ui.text());
  assert.equal(author(path.join(projects, 'shop')), 'Alex Lee <alex@example.com>|Alex Lee <alex@example.com>');
  // Only that commit has it: the words say so, and give the one command for the next ones (a plain commit there would
  // otherwise go out under git's guess or be refused).
  assert.match(ui.text(), /the first commit was made as Alex Lee <alex@example\.com>; nothing was set in git/);
  assert.match(ui.text(), /git config user\.name "Alex Lee"\n\s+git config user\.email alex@example\.com/);
  assert.doesNotMatch(ui.text(), /commits of this project as/);
  assert.equal(fs.readFileSync(GLOBAL, 'utf8'), BYTES);
  const local = spawnSync('git', ['-C', path.join(projects, 'shop'), 'config', '--local', '--get-regexp', '^user\\.'], { encoding: 'utf8' });
  assert.deepEqual([local.status, local.stdout.trim()], [1, ''], 'nor in the repository (git exits 1: nothing found)');
});

test('asked in a terminal; from Hoprig\'s settings; project add the same way', async () => {
  const ui = await quietUi({ interactive: true, answers: (q) => (/name/.test(q) ? 'Sam Doe' : 'sam@example.com') });
  assert.equal(await projectNew(['beta', '--no-github'], { ui }), 0, ui.text());
  assert.ok(ui.asked.some((q) => /Your name for commits/.test(q)));
  assert.equal(author(path.join(projects, 'beta')).split('|')[0], 'Sam Doe <sam@example.com>');
  saveConfig({ gitIdentity: { name: 'Kim Roe', email: 'kim@example.com' } });
  const ui2 = await quietUi();
  assert.equal(await projectAdd(['beta', 'api'], { ui: ui2 }), 0, ui2.text());
  assert.equal(author(path.join(projects, 'beta', 'code', 'beta-api')).split('|')[0], 'Kim Roe <kim@example.com>');
  assert.equal(fs.readFileSync(GLOBAL, 'utf8'), BYTES);
});

test('a bad --git-email is refused', async () => {
  const ui = await quietUi();
  assert.equal(await projectNew(['gamma', '--no-github', '--git-name', 'A', '--git-email', 'not an address'], { ui }), 1);
  assert.match(ui.text(), /--git-email needs an e-mail address/);
});
