// Every command Hoprig prints for the owner to paste quotes its paths for a POSIX shell (showCommand): a folder named
// with a quote, $( ), a space and a backtick reaches the command as one word, and nothing in its name runs. Each kind
// of printed command (mv, rm, git -C, chmod, cd) is made by the real code for such a folder and pasted into sh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const NASTY = "it's $(touch pwned) a `touch pwned2` b";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-paste-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const scratch = path.join(root, 'cwd');
fs.mkdirSync(scratch);
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start');
  return dir;
};
/** Paste a printed line into sh; nothing in a folder's name may have run. → its output */
function paste(line) {
  const out = execFileSync('sh', ['-c', line], { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  assert.deepEqual(fs.readdirSync(scratch), [], `something in the path ran: ${line}`);
  return out;
}
let n = 0;
const nasty = () => path.join(root, `${++n}`, NASTY);

test('mv: workspace set, a brain in the way of restore, a provider file named like a command', async () => {
  const { setPlaces } = await import('../../src/workspace/places.mjs');
  const from = nasty();
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'mine.txt'), 'mine');
  const to = `${from}-new`;
  const r = setPlaces({ projects: to }, { save: () => {}, load: () => ({ projectsDir: from }), remember: () => {} });
  assert.equal(r.moves.length, 1, JSON.stringify(r));
  paste(r.moves[0]);
  assert.equal(fs.readFileSync(path.join(to, 'mine.txt'), 'utf8'), 'mine');

  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const ws = nasty();
  fs.mkdirSync(path.join(ws, 'ai_brain'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ai_brain', 'notes.md'), 'mine');
  const e = await restoreWorkspace('https://github.com/alex/brain.git', { withProjects: true, ui: makeUi({ interactive: false, write: () => {} }), dir: ws }).catch((x) => x);
  const mv = /Move it aside first \((.*)\) and run restore again/.exec(e.message);
  assert.ok(mv, e.message);
  paste(mv[1]);
  assert.ok(fs.existsSync(path.join(ws, 'ai_brain.old', 'notes.md')));

  const { profilesCheck } = await import('../../src/setup/checks.mjs');
  const profiles = nasty();
  fs.mkdirSync(profiles, { recursive: true });
  fs.writeFileSync(path.join(profiles, 'codex.env'), 'X=1\n');
  const before = process.env.HOPRIG_PROFILES_DIR;
  process.env.HOPRIG_PROFILES_DIR = profiles;
  try {
    paste(profilesCheck([], ['codex']).fix);
  } finally {
    process.env.HOPRIG_PROFILES_DIR = before;
  }
  assert.ok(fs.existsSync(path.join(profiles, 'codex-provider.env')));
});

test('rm: a memory link that points elsewhere', async () => {
  const { planMemoryPairs } = await import('../../src/pcsetup/workspace.mjs');
  const { projectSlug } = await import('../../src/sessions.mjs');
  const base = nasty();
  const launch = path.join(root, 'launch');
  const link = path.join(base, 'projects', projectSlug(launch), 'memory');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(root, 'elsewhere'), link);
  const [p] = planMemoryPairs([{ launch, memory: path.join(root, 'mem') }], { base, fix: 'hoprig project link x' });
  assert.equal(p.action, 'conflict');
  assert.ok(p.fix.endsWith(' && hoprig project link x'), p.fix);
  paste(p.fix.slice(0, -' && hoprig project link x'.length));
  assert.ok(!fs.existsSync(link) && !fs.lstatSync(path.dirname(link)).isSymbolicLink());
});

test('git -C: what a sync leaves to the owner, and the map\'s commit', async () => {
  const { syncRepo } = await import('../../src/pcsetup/workspace.mjs');
  const seed = repo(path.join(root, 'seed'));
  const bare = path.join(root, 'server.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare]);
  const dir = nasty();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '-q', bare, dir]);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
  git(dir, 'add', 'new.txt');
  const r = await syncRepo(dir, 'code/x');
  const st = r.todo.find((t) => / status$/.test(t.command));
  assert.ok(st, JSON.stringify(r.todo));
  assert.match(paste(st.command), /new\.txt/);

  const { updateMap } = await import('../../src/workspace/map.mjs');
  const ws = nasty();
  repo(path.join(ws, 'ai_brain'));
  const projects = path.join(ws, 'projects');
  repo(path.join(projects, 'shop'));
  const m = await updateMap({ dir: ws, projects, manifests: false });
  paste(m.commit);
  assert.equal(git(path.join(ws, 'ai_brain'), 'log', '-1', '--format=%s'), 'Update the workspace map');
});

test('chmod: the credentials folder other users can open', async () => {
  const { workspaceLine } = await import('../../src/workspace/layout.mjs');
  const ws = nasty();
  const cred = path.join(ws, 'credentials');
  fs.mkdirSync(cred, { recursive: true, mode: 0o755 });
  fs.chmodSync(cred, 0o755);
  const line = workspaceLine({ exists: true, short: 'ws', dir: ws, brain: { exists: true, git: true }, projects: [], folders: [{ id: 'credentials', rel: 'credentials', exists: true, warning: 'open' }] });
  paste(line.fix);
  assert.equal(fs.statSync(cred).mode & 0o777, 0o700);
});

test('cd: the retry of a dependency install, and the node-pty fix', async () => {
  const { runInstall } = await import('../../src/pcsetup/setup.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const dest = nasty();
  fs.mkdirSync(dest, { recursive: true });
  const lines = [];
  await runInstall(makeUi({ interactive: false, write: (s) => lines.push(s) }), dest, { label: 'pwd', argv: ['pwd'] }, async () => ({ ok: false }));
  const retry = /retry: (.*)$/m.exec(lines.join(''));
  assert.ok(retry, lines.join(''));
  assert.equal(paste(retry[1]).trim(), dest);

  const { ptyFix } = await import('../../src/setup/checks.mjs');
  const app = nasty();
  fs.mkdirSync(app, { recursive: true });
  const fix = ptyFix({ platform: 'linux', has: () => true }, app, 'unbuilt');
  assert.ok(fix.endsWith(' && npm rebuild node-pty'), fix);
  assert.equal(paste(`${fix.slice(0, -' && npm rebuild node-pty'.length)} && pwd`).trim(), app);
});

test('git clone and hoprig project clone: the retry lines of a computer set-up from a recipe', async () => {
  const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
  const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const dir = nasty();
  const sys = await sysFacts({ platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: root, home: process.env.HOME, has: () => true, exists: () => false, run: async (argv) => ({ ok: true, code: 0, stdout: `${argv[0]} 99.9.9`, stderr: '' }) });
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const failing = async () => ({ ok: false, code: 128, stdout: '', stderr: 'no' });
  const was = process.env.HOPRIG_WORKSPACE_DIR;
  process.env.HOPRIG_WORKSPACE_DIR = path.join(root, 'ws-none');
  try {
    await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], projectsDir: dir, repos: ['https://git.example.test/team/app.git'], workspaces: [NASTY] }, sys, rules: false, runner: failing, codingTools: { findTool: () => null } });
  } finally {
    if (was === undefined) delete process.env.HOPRIG_WORKSPACE_DIR;
    else process.env.HOPRIG_WORKSPACE_DIR = was;
  }
  const retry = out.join('').split('\n').filter((l) => /retry:/.test(l)).map((l) => l.slice(l.indexOf('retry:') + 7).replace(/\u001b\[[0-9;]*m/g, '').trim());
  const clone = retry.find((l) => l.startsWith('git clone '));
  const again = retry.find((l) => l.startsWith('hoprig project clone '));
  assert.ok(clone && again, retry.join('\n'));
  // Each line as the shell reads it: printf in place of the program shows the words it would get.
  assert.deepEqual(paste(clone.replace(/^git clone /, "printf '%s\\n' ")).trimEnd().split('\n'), ['https://git.example.test/team/app.git', path.join(dir, 'app')]);
  assert.deepEqual(paste(again.replace(/^hoprig project clone /, "printf '%s\\n' ")).trimEnd().split('\n'), [NASTY]);
});
