// What Hoprig's own set-up leaves in the AI brain, a git repository of the person's: only the skills themselves (the
// person's knowledge, which the Git and GitHub row then names), never Hoprig's own record of what it installed nor a
// dated copy of it. A temporary home whose brain is a clone of a bare repository of this test's own; an older
// Hoprig's skills folder with its record; the workspace link; `hoprig setup --dry-run`; then a real `hoprig setup
// --only skills --yes`. A record already in the brain is left exactly as it is: never deleted, moved or committed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recorder } from './helpers.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-brainwrites-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const ws = path.join(home, 'Workspace');
const brain = path.join(ws, 'ai_brain');
const state = path.join(root, 'state');
const claude = path.join(home, '.claude');
const gitcfg = path.join(root, 'gitconfig');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(gitcfg, '[user]\n\tname = Alex Demo\n\temail = alex@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[protocol "file"]\n\tallow = always\n');
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  HOPRIG_CONFIG_DIR: path.join(root, 'config'), HOPRIG_STATE_DIR: state, CLAUDE_CONFIG_DIR: claude, HOPRIG_WORKSPACE_DIR: ws,
});
for (const k of ['HOPRIG_PROFILES_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete process.env[k];
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The git server: the brain with the record another computer once committed.
const bare = path.join(root, 'server', 'ai_brain.git');
fs.mkdirSync(bare, { recursive: true });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
const seed = path.join(root, 'seed');
fs.mkdirSync(path.join(seed, 'skills'), { recursive: true });
git(seed, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(seed, 'BRAIN.md'), '# The AI brain\n');
const COMMITTED = `${JSON.stringify({ version: 1, skills: {} }, null, 2)}\n`;
fs.writeFileSync(path.join(seed, 'skills', '.hoprig-skills.json'), COMMITTED);
git(seed, 'add', '-A');
git(seed, 'commit', '-q', '-m', 'Start the AI brain');
git(seed, 'push', '-q', bare, 'main');
fs.mkdirSync(ws, { recursive: true });
execFileSync('git', ['clone', '-q', bare, brain], { stdio: 'ignore' });

// What an older Hoprig left in Claude Code's own skills folder: the bundled skill and its record beside it.
const hub = await import('../../src/skillhub/hub.mjs');
const review = await hub.prepare('hoprig', {});
const placed = hub.approve(review.id);
const { MANIFEST } = await import('../../src/skillhub/store.mjs');
// Hoprig's record of the person's own skills, in its state folder (src/skillhub/store.mjs userRecordFile).
const userRecordFile = () => path.join(state, 'skillhub', 'user-skills.json');
const userSkills = path.join(claude, 'skills');
fs.writeFileSync(path.join(userSkills, MANIFEST), `${JSON.stringify({ version: 1, skills: { hoprig: { source: placed.source, files: {} } } }, null, 2)}\n`);
fs.rmSync(userRecordFile(), { force: true });

/** Every file and link under `dir` (not .git) → its hash or target. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
// Not trimmed: the first line's mark starts with a space (" M").
const loose = () => execFileSync('git', ['-C', brain, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => [l.slice(0, 2), l.slice(3)]);
/** A loose path of the brain that the table of what Hoprig writes allows: a skill's own files, nothing of Hoprig's. */
const aSkill = (p) => /^skills\/[A-Za-z0-9][A-Za-z0-9._-]*\/[^.]/.test(p) && !/\.hoprig-skills/.test(p);

async function setup(args) {
  const K = await import('../../src/setup/checks.mjs');
  const SU = await import('../../src/setup/setup.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const r = recorder();
  const ui = makeUi({ interactive: false, yes: args.includes('--yes'), dryRun: args.includes('--dry-run'), write: r.write, askLine: async () => '' });
  const sys = K.sysInfo({ env: { ...process.env }, platform: 'linux', pm: 'apt', root: false, user: 'alex', serviceSupported: false, publicIps: [], dmi: {}, localDisplay: true, savedServer: undefined, locales: new Set(['c', 'c.utf8', 'posix']), release: { ID: 'ubuntu', ID_LIKE: 'debian' } });
  sys.probe = async () => 0;
  sys.running = async () => null;
  const code = await SU.setup(args, { ui, sys });
  return { code, text: r.text };
}

test('the workspace link moves the skills into the brain, and Hoprig\'s record goes to its own state folder', async () => {
  const { applyLink } = await import('../../src/workspace/link.mjs');
  const linked = applyLink({}).find((l) => l.id === 'skills');
  assert.match(linked.done, /then linked/, JSON.stringify(linked));
  for (const [, p] of loose()) assert.ok(aSkill(p), `only a skill is loose in the brain, not ${p}`);
  assert.ok(loose().some(([, p]) => p === 'skills/hoprig/SKILL.md'));
  assert.deepEqual(fs.readdirSync(path.join(brain, 'skills')).filter((n) => n.startsWith('.hoprig-skills')), ['.hoprig-skills.json'], 'no dated copy');
  assert.equal(fs.readFileSync(path.join(brain, 'skills', MANIFEST), 'utf8'), COMMITTED, 'the record the brain holds is left as it is');
  assert.ok(JSON.parse(fs.readFileSync(userRecordFile(), 'utf8')).skills.hoprig, 'Hoprig still knows the skill it installed');
  assert.ok(hub.installed({}).skills.find((s) => s.name === 'hoprig').managed);
});

test('setup --dry-run changes nothing in the whole home, the brain or the state folder', async () => {
  const before = { home: snapshot(home), state: snapshot(state) };
  const r = await setup(['--dry-run', '--only', 'skills']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual({ home: snapshot(home), state: snapshot(state) }, before, r.text);
});

test('a real setup adds skills to the brain and nothing of Hoprig\'s own', async () => {
  const brainBefore = snapshot(brain);
  const r = await setup(['--only', 'skills', '--yes']);
  assert.equal(r.code, 0, r.text);
  const added = Object.keys(snapshot(brain)).filter((p) => !(p in brainBefore));
  assert.ok(added.length > 0 && added.every(aSkill), `added under the brain: ${added.join(', ')}`);
  for (const [mark, p] of loose()) assert.ok(mark === '??' && aSkill(p), `only new skills are loose in the brain, not "${mark} ${p}"`);
  assert.equal(fs.readFileSync(path.join(brain, 'skills', MANIFEST), 'utf8'), COMMITTED, 'never changed, deleted or moved');
  assert.equal(git(brain, 'log', '--oneline').split('\n').length, 1, 'nothing committed by itself');
  const rec = JSON.parse(fs.readFileSync(userRecordFile(), 'utf8')).skills;
  for (const n of hub.installed({}).skills.filter((s) => s.name !== 'hoprig').map((s) => s.name)) assert.ok(rec[n], `${n} is in Hoprig's record`);
});
