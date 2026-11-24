// The move's copy and its check (src/setup/movecopy.mjs, movecheck.mjs) on a made-up root home with a real repository
// (a branch, a stash, an untracked and an ignored file, a linked work tree), Claude Code's folder with a project's
// conversations (agents' files at depth four), settings that name root's home, a Custom link's config.yml and an entry
// of another owner. The owner is set and read through functions the test hands in (a test cannot make a file of
// another user): every chown is written down, and an entry nobody gave to the user counts as another owner's. A
// "step as the user" runs here as the test's own user.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const P = await import('../../src/setup/moveplan.mjs');
const C = await import('../../src/setup/movecopy.mjs');
const K = await import('../../src/setup/movecheck.mjs');
const { capture } = await import('../../src/setup/system.mjs');
const { projectSlug } = await import('../../src/sessions.mjs');

const write = (f, t = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = '3f1c2b8e-7d4a-4e21-9b0c-5a6d7e8f9012';
// The made-up servers lie in a folder reached through a link, as every temporary folder on macOS (/var is a link to
// /private/var): Hoprig is handed the path through the link, git and Claude Code see the real one.
const linked = path.join(s.tmp, 'linked');
fs.mkdirSync(path.join(s.tmp, 'real'));
fs.symlinkSync(path.join(s.tmp, 'real'), linked);
/** `p` (under the link) by its real path, also when not made yet: the folder Claude Code runs in (process.cwd()). */
const real = (p) => path.join(fs.realpathSync(s.tmp), 'real', path.relative(linked, p));
/** The name of Claude Code's project folder for `p`: from its real path. */
const slug = (p) => projectSlug(real(p));

/**
 * A socket listening at `dir`/`name`, made from inside `dir` by its short relative name: a socket's path holds at most
 * 103 bytes on macOS (104 with its end), and a temporary folder there is long. → the listener.
 */
async function listenIn(dir, name) {
  const net = await import('node:net');
  const listener = net.createServer();
  const was = process.cwd();
  process.chdir(dir);
  try {
    await new Promise((res, rej) => listener.once('error', rej).listen(name, res));
  } finally {
    process.chdir(was);
  }
  assert.ok(fs.lstatSync(path.join(dir, name)).isSocket(), 'the socket is in its folder');
  return listener;
}

/** A fresh made-up server: root's installation under `<n>/root`, the user's empty home under `<n>/users/hoprig`. */
function server(n) {
  const base = path.join(linked, n);
  const root = path.join(base, 'root');
  const home = path.join(base, 'users', 'hoprig');
  const dirs = { config: path.join(root, '.config/hoprig'), state: path.join(root, '.local/state/hoprig'), claude: path.join(root, '.claude'), workspace: path.join(root, 'Workspace') };
  write(path.join(dirs.config, 'config.json'), JSON.stringify({ workspaceDir: dirs.workspace, server: { port: 7433 }, recent: [`${root}/Workspace/projects/shop`, '/opt/other'], [`${root}/x`]: 1 }));
  write(path.join(dirs.config, 'profiles/api.env'), `PRERUN="node ${root}/.local/bin/x addons start gw"\n`);
  write(path.join(dirs.state, 'addons/fixed-link/config.yml'), `tunnel: made-up\ncredentials-file: ${root}/.local/state/hoprig/addons/fixed-link/made-up.json\nroot-text: ${root}xyz\n`);
  write(path.join(dirs.state, 'addons/fixed-link/made-up.json'), '{"secret":"made-up"}');
  write(path.join(dirs.state, 'router.log'), `${root}/left behind`);
  write(path.join(dirs.state, 'runs/old.json'), '{}');
  const shop = path.join(dirs.workspace, 'projects', 'shop');
  fs.mkdirSync(shop, { recursive: true });
  git(shop, 'init', '-q');
  write(path.join(shop, '.gitignore'), '*.log\n');
  write(path.join(shop, 'README.md'), 'shop\n');
  git(shop, 'add', '.');
  git(shop, 'commit', '-qm', 'first');
  git(shop, 'branch', 'feature');
  write(path.join(shop, 'README.md'), 'shop, stashed\n');
  git(shop, 'stash', '-q');
  write(path.join(shop, 'notes.txt'), 'untracked\n');
  write(path.join(shop, 'debug.log'), 'ignored\n');
  write(path.join(shop, 'README.md'), 'shop, changed\n');
  git(shop, 'worktree', 'add', '-q', '-b', 'tree', path.join(dirs.workspace, 'projects', 'shop-tree'));
  fs.symlinkSync(path.join(shop, 'README.md'), path.join(dirs.workspace, 'readme-link'));
  write(path.join(dirs.workspace, 'ai_brain/workspace.json'), JSON.stringify({ projects: { shop: `${root}/Workspace/projects/shop` } }));
  // Claude Code: the project's conversation and an agent's file four folders down.
  const proj = path.join(dirs.claude, 'projects', slug(shop));
  write(path.join(proj, `${ID}.jsonl`), `{"cwd":"${shop}"}\n`);
  write(path.join(proj, ID, 'subagents', 'a', 'b', 'agent-1.jsonl'), '{"agent":1}\n');
  write(path.join(root, '.claude.json'), JSON.stringify({ projects: { [shop]: { allowedTools: [] } } }));
  write(path.join(root, '.ssh/authorized_keys'), 'ssh-ed25519 AAAA made-up-login');
  write(path.join(root, '.ssh/id_ed25519'), 'made-up private');
  fs.chmodSync(path.join(root, '.ssh/id_ed25519'), 0o600);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.hoprig-made-by-move'), 'Hoprig work user hoprig\n'); // Hoprig's mark: root's (lstat below)
  return { base, root, home, dirs, shop };
}

/** The readers and writers of one move: owners written down in `owned`, a clock that moves 1 s a call. */
function hands(srv, { foreign = null, copyFile } = {}) {
  const owned = new Map();
  let t = 0;
  const realLstat = fs.lstatSync;
  const look = {
    home: srv.root, uid: 0, env: { TMUX_TMPDIR: path.join(srv.base, 'tmux') }, dirs: srv.dirs, statfs: () => ({ bavail: 1e7, bsize: 4096 }), workRunning: async () => 0,
    lstat: (p) => {
      const st = realLstat(p);
      // The mark Hoprig left in the user's home is root's (a test cannot make a file of another owner).
      const uid = p === srv.home ? 1001 : p === foreign ? 5555 : p === path.join(srv.home, '.hoprig-made-by-move') ? 0 : null;
      return uid === null ? st : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid });
    },
    run: async (argv) => (argv[0] === 'getent' && argv[2] === 'hoprig' ? { ok: true, stdout: `hoprig:x:1001:1001:Hoprig work user:${srv.home}:/bin/bash\n` } : { ok: false, code: 2, stdout: '', stderr: '' }),
  };
  const copy = { chown: (p, uid) => owned.set(p, uid), now: () => (t += 1000), ...(copyFile ? { copyFile } : {}) };
  const ownerOf = (p) => owned.get(p) ?? -1;
  const asUser = (argv, o) => capture(argv, o);
  return { look, copy, owned, ownerOf, asUser };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out[p] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('a repository with a branch, a stash, an untracked and an ignored file and a linked work tree arrives whole, and the check finds it the same', async () => {
  const srv = server('whole');
  const h = hands(srv, { foreign: path.join(srv.shop, 'notes.txt') });
  const plan = await P.movePlan({ io: h.look });
  assert.equal(plan.ok, true, plan.stops.join('\n'));
  const rootBefore = snapshot(srv.root);
  const progress = [];
  const r = await C.copyParts(plan, { io: h.copy, onProgress: (p) => progress.push(p), asUser: h.asUser });
  assert.equal(r.ok, true, r.error);
  const copy = path.join(srv.home, 'Workspace/projects/shop');
  // The repository: its branch, its stash, the untracked and the ignored file, the change not committed.
  assert.match(git(copy, 'branch', '--list'), /feature/);
  assert.equal(git(copy, 'stash', 'list').split('\n').length, 1);
  assert.equal(fs.readFileSync(path.join(copy, 'notes.txt'), 'utf8'), 'untracked\n');
  assert.equal(fs.readFileSync(path.join(copy, 'debug.log'), 'utf8'), 'ignored\n');
  assert.equal(git(copy, 'status', '--porcelain'), git(srv.shop, 'status', '--porcelain'));
  // The linked work tree has its head, and git's two records of it name the new place.
  const tree = path.join(srv.home, 'Workspace/projects/shop-tree');
  assert.equal(git(tree, 'rev-parse', 'HEAD'), git(path.join(srv.dirs.workspace, 'projects/shop-tree'), 'rev-parse', 'HEAD'));
  // git writes this folder by the name it was given or by its real place, by its version: the same folder either way.
  const record = fs.readFileSync(path.join(tree, '.git'), 'utf8').trim();
  assert.match(record, /^gitdir: /);
  assert.equal(fs.realpathSync(record.slice('gitdir: '.length)), fs.realpathSync(`${copy}/.git/worktrees/shop-tree`));
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(copy, '.git/worktrees/shop-tree/gitdir'), 'utf8').trim()), fs.realpathSync(`${tree}/.git`));
  assert.deepEqual(r.repaired, [{ repo: copy, ok: true }]);
  // A link into root's home points into the user's.
  assert.equal(fs.readlinkSync(path.join(srv.home, 'Workspace/readme-link')), path.join(copy, 'README.md'));
  // The owner of everything copied is the user, also the entry of another owner; links themselves.
  assert.equal(h.owned.get(path.join(copy, 'notes.txt')), 1001);
  assert.equal(h.owned.get(path.join(srv.home, 'Workspace/readme-link')), 1001);
  // Root's side is the same as before.
  assert.deepEqual(snapshot(srv.root), rootBefore);
  // The copy said how far it was while it ran: entries and bytes of the total.
  assert.ok(progress.length >= 3, `${progress.length} progress lines`);
  const last = progress.at(-1);
  assert.ok(last.entries > 0 && last.bytes > 0 && last.totalEntries === plan.total.entries && last.totalBytes === plan.total.bytes, JSON.stringify(last));
  // The check: same heads, status, branches, stashes and counts; owners not the user 0; conversations the same.
  const c = await K.checkCopy(plan, r, { asUser: h.asUser, ownerOf: h.ownerOf });
  assert.deepEqual(c.problems, []);
  assert.equal(c.repos, 2, 'the repository and its linked work tree');
  assert.equal(c.owners, 0);
  assert.deepEqual(c.hashes, { same: 2, total: 2, differ: [] }, "the conversation and the agent's file four folders down");
});

test('settings name the new home in the copy only: JSON values and keys, config.yml, the provider file, the workspace map, Claude Code\'s settings', async () => {
  const srv = server('paths');
  const h = hands(srv);
  const plan = await P.movePlan({ io: h.look });
  const r = await C.copyParts(plan, { io: h.copy, asUser: h.asUser });
  assert.equal(r.ok, true, r.error);
  const cfg = JSON.parse(fs.readFileSync(path.join(srv.home, '.config/hoprig/config.json'), 'utf8'));
  assert.equal(cfg.workspaceDir, path.join(srv.home, 'Workspace'));
  assert.deepEqual(cfg.recent, [`${srv.home}/Workspace/projects/shop`, '/opt/other']);
  assert.equal(cfg[`${srv.home}/x`], 1);
  const yml = fs.readFileSync(path.join(srv.home, '.local/state/hoprig/addons/fixed-link/config.yml'), 'utf8');
  assert.match(yml, new RegExp(`credentials-file: ${srv.home}/\\.local/state/hoprig/addons/fixed-link/made-up\\.json`));
  assert.match(yml, new RegExp(`root-text: ${srv.root}xyz`), 'a longer name that only starts like the home is left alone');
  assert.match(fs.readFileSync(path.join(srv.home, '.config/hoprig/profiles/api.env'), 'utf8'), new RegExp(`node ${srv.home}/\\.local/bin/x`));
  assert.match(fs.readFileSync(path.join(srv.home, 'Workspace/ai_brain/workspace.json'), 'utf8'), new RegExp(`${srv.home}/Workspace/projects/shop`));
  assert.ok(JSON.parse(fs.readFileSync(path.join(srv.home, '.claude.json'), 'utf8')).projects[`${srv.home}/Workspace/projects/shop`]);
  // What belongs to root's running dashboard stays behind; a conversation's lines are never rewritten.
  assert.equal(fs.existsSync(path.join(srv.home, '.local/state/hoprig/router.log')), false);
  assert.equal(fs.existsSync(path.join(srv.home, '.local/state/hoprig/runs')), false);
  const newProj = path.join(srv.home, '.claude/projects', slug(path.join(srv.home, 'Workspace/projects/shop')));
  assert.equal(fs.readFileSync(path.join(newProj, `${ID}.jsonl`), 'utf8'), `{"cwd":"${srv.shop}"}\n`);
  // The keys git uses come with their modes; the login keys file does not.
  assert.equal(fs.statSync(path.join(srv.home, '.ssh/id_ed25519')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(srv.home, '.ssh/authorized_keys')), false);
  // Root's settings still name root's home.
  assert.equal(JSON.parse(fs.readFileSync(path.join(srv.dirs.config, 'config.json'), 'utf8')).workspaceDir, srv.dirs.workspace);
});

test("a project's conversations are listed in its new place and one is continued there with the stand-in tool", async () => {
  const srv = server('talk');
  const h = hands(srv);
  const plan = await P.movePlan({ io: h.look });
  const r = await C.copyParts(plan, { io: h.copy, asUser: h.asUser });
  assert.equal(r.ok, true, r.error);
  const newShop = path.join(srv.home, 'Workspace/projects/shop');
  assert.deepEqual(r.placed.map((p) => p.to), [slug(newShop)]);
  // The dashboard's history of the project in its new place (sessions.mjs, as the user's Claude folder).
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(srv.home, '.claude');
  try {
    const { sessionsIn } = await import('../../src/sessions.mjs');
    assert.deepEqual(sessionsIn(real(newShop)).map((x) => x.id), [ID]);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = was;
  }
  // The stand-in tool continues a conversation only from the folder its file lies under (the naming rule).
  const bin = fakeBin(path.join(srv.base, 'bin'), {
    claude: `[ "$1" = --resume ] || exit 2\nslug=$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')\nf="$CLAUDE_CONFIG_DIR/projects/$slug/$2.jsonl"\n[ -f "$f" ] || { echo "No conversation found with session ID: $2"; exit 1; }\necho '{"continued":true}' >> "$f"\necho continued`,
  });
  const out = execFileSync(path.join(bin, 'claude'), ['--resume', ID], { cwd: newShop, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(srv.home, '.claude') }, encoding: 'utf8' });
  assert.equal(out.trim(), 'continued');
  assert.match(fs.readFileSync(path.join(srv.home, '.claude/projects', slug(newShop), `${ID}.jsonl`), 'utf8'), /continued/);
});

test('a folder of the new name already there keeps its files; only missing ones are added', async () => {
  const srv = server('keep');
  const h = hands(srv);
  const plan = await P.movePlan({ io: h.look });
  const newShop = path.join(srv.home, 'Workspace/projects/shop');
  // Root's Claude folder already holds a folder under the new path's name (an earlier try): its file is kept.
  const already = path.join(srv.dirs.claude, 'projects', slug(newShop));
  write(path.join(already, `${ID}.jsonl`), '{"kept":true}\n');
  const plan2 = await P.movePlan({ io: h.look });
  const r = await C.copyParts(plan2, { io: h.copy, asUser: h.asUser });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(srv.home, '.claude/projects', slug(newShop), `${ID}.jsonl`), 'utf8'), '{"kept":true}\n');
  assert.ok(fs.existsSync(path.join(srv.home, '.claude/projects', slug(newShop), ID, 'subagents/a/b/agent-1.jsonl')), 'the missing file is added');
  assert.ok(plan.ok);
});

test('a socket in a copied part is skipped by the copy and not counted by the check: the check passes', async () => {
  const srv = server('socket');
  const sock = path.join(srv.dirs.workspace, 'projects', 'shop', 'agent.sock');
  const listener = await listenIn(path.dirname(sock), 'agent.sock');
  try {
    const h = hands(srv);
    const plan = await P.movePlan({ io: h.look });
    assert.equal(plan.ok, true, plan.stops.join('\n'));
    const r = await C.copyParts(plan, { io: h.copy, asUser: h.asUser });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.skipped, [sock]);
    const check = await K.checkCopy(plan, r, { asUser: h.asUser, ownerOf: h.ownerOf });
    assert.deepEqual(check.problems.filter((l) => /entries/.test(l)), [], check.problems.join('\n'));
  } finally {
    await new Promise((res) => listener.close(res));
  }
});

test("the copy counts what the look counted: its last progress is the look's total and never more", async () => {
  // A tree with what counted twice or not at all: the keys git uses (beside the login keys), a project folder of
  // Claude Code that is also placed under its new path's name, and a socket the copy cannot copy.
  const srv = server('count');
  write(path.join(srv.root, '.ssh/known_hosts'), 'example.com ssh-ed25519 AAAA');
  const listener = await listenIn(srv.dirs.workspace, 'agent.sock');
  try {
    const h = hands(srv);
    const plan = await P.movePlan({ io: h.look });
    assert.equal(plan.ok, true, plan.stops.join('\n'));
    const progress = [];
    const r = await C.copyParts(plan, { io: h.copy, onProgress: (p) => progress.push(p), asUser: h.asUser });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.placed.length > 0 && r.skipped.length === 1, 'the tree has a placed project folder and a socket');
    for (const p of progress) assert.ok(p.entries <= p.totalEntries, `${p.entries} of ${p.totalEntries}`);
    assert.equal(progress.at(-1).entries, plan.total.entries, 'the last progress is the total');
    assert.equal(r.done.entries, plan.total.entries);
  } finally {
    await new Promise((res) => listener.close(res));
  }
});

test('a failure in the middle of the copy leaves root unchanged and says what was made and how to take it away', async () => {
  const srv = server('fail');
  let n = 0;
  const h = hands(srv, {
    copyFile: (a, b) => {
      if ((n += 1) === 6) throw new Error('no space left on device (made up)');
      fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
    },
  });
  const plan = await P.movePlan({ io: h.look });
  const rootBefore = snapshot(srv.root);
  const r = await C.copyParts(plan, { io: h.copy, asUser: h.asUser });
  assert.equal(r.ok, false);
  assert.deepEqual(snapshot(srv.root), rootBefore);
  const lines = C.failedCopyLines(r, plan.user).join('\n');
  assert.match(lines, /^The copy stopped: no space left on device \(made up\)\. Root's installation was not changed and still runs\./);
  // Not "take it away before you try again": the next run does that itself (its mark), so he is never sent to rm by hand.
  assert.match(lines, /Made in hoprig's home so far \(the next run of the move takes it away first; a part changed after this is set aside beside it, never deleted\):/);
  assert.doesNotMatch(lines, /before you try again/);
  assert.ok(r.made.every((m) => m.startsWith(`${srv.home}/`)), 'only the user\'s home');
  // A second look sees what the first left, and stops before it writes over anything.
  const again = await P.movePlan({ io: h.look });
  assert.equal(again.ok, false);
  assert.match(again.stops.join('\n'), /is already in hoprig's home: the move does not write over it/);
});

test('the check counts an entry of the copy that is not the user\'s, and a head that differs', async () => {
  const srv = server('bad');
  const h = hands(srv);
  const plan = await P.movePlan({ io: h.look });
  const r = await C.copyParts(plan, { io: h.copy, asUser: h.asUser });
  const stray = path.join(srv.home, 'Workspace/projects/shop/notes.txt');
  h.owned.delete(stray);
  const c = await K.checkCopy(plan, r, { asUser: h.asUser, ownerOf: h.ownerOf });
  assert.equal(c.ok, false);
  assert.equal(c.owners, 1);
  assert.match(c.problems.join('\n'), /1 entry of the copy do not belong to hoprig/);
  // A commit only in the copy: its head differs (its new objects are nobody's in this test, counted too).
  const copy = path.join(srv.home, 'Workspace/projects/shop');
  git(copy, 'commit', '-qam', 'only in the copy');
  const c2 = await K.checkCopy(plan, r, { asUser: h.asUser, ownerOf: h.ownerOf });
  assert.match(c2.problems.join('\n'), /projects\/shop: its head differs in the copy/);
  assert.ok(c2.owners > 1);
});

test('a home known by two names is carried in one pass: a new home below its real path is never carried twice', () => {
  const count = { n: 0 };
  const text = 'gitdir: /srv/homes/shop/.git/worktrees/t\nother: /root/alpha\nkept: /srv/homes-old/x\n';
  const out = C.carryText(text, ['/root', '/srv/homes'], '/srv/homes/alice', count);
  assert.equal(out, 'gitdir: /srv/homes/alice/shop/.git/worktrees/t\nother: /srv/homes/alice/alpha\nkept: /srv/homes-old/x\n');
  assert.equal(count.n, 2);
  // One name, as before.
  assert.equal(C.carryText('/root/a', '/root', '/srv/homes/alice'), '/srv/homes/alice/a');
});
