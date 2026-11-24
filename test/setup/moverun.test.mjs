// `hoprig move-to-user` from start to end (src/setup/movecli.mjs, moverun.mjs) on a made-up root home: the real copy
// and check, every system call of the switch a stand-in that writes down what it was asked. Without a yes nothing is
// changed; with --yes the copy, the check, the switch and the catch-up run in that order, and root's copy is kept.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const M = await import('../../src/setup/movecli.mjs');
const C = await import('../../src/setup/movecopy.mjs');
const K = await import('../../src/setup/movecheck.mjs');
const { capture } = await import('../../src/setup/system.mjs');
const { stateKey } = await import('../../src/server/dashboardfile.mjs');

const root = path.join(s.tmp, 'root');
const home = path.join(s.tmp, 'users', 'hoprig');
const dirs = { config: path.join(root, '.config/hoprig'), state: path.join(root, '.local/state/hoprig'), claude: path.join(root, '.claude'), workspace: path.join(root, 'Workspace') };
const write = (f, t = 'x') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
write(path.join(dirs.config, 'config.json'), JSON.stringify({ workspaceDir: dirs.workspace }));
write(path.join(dirs.state, 'server.json'), '{}');
const shop = path.join(dirs.workspace, 'projects/shop');
write(path.join(shop, 'README.md'), 'shop\n');
execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: shop });
execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', 'commit', '-qm', 'first', '--allow-empty'], { cwd: shop });
fs.mkdirSync(home, { recursive: true });
const MARK = path.join(home, '.hoprig-made-by-move');
fs.writeFileSync(MARK, 'Hoprig work user hoprig\n');

const owned = new Map();
const realLstat = fs.lstatSync;
const io = {
  home: root, uid: 0, env: { TMUX_TMPDIR: path.join(s.tmp, 'tmux') }, dirs, statfs: () => ({ bavail: 1e7, bsize: 4096 }), workRunning: async () => 0,
  // The user's home is the user's; the mark Hoprig left in it is root's (a test cannot make a file of another owner).
  lstat: (p) => (p === home || p === MARK ? Object.assign(Object.create(Object.getPrototypeOf(realLstat(p))), realLstat(p), { uid: p === home ? 1001 : 0 }) : realLstat(p)),
  run: async (argv) => (argv[0] === 'getent' && argv[2] === 'hoprig' ? { ok: true, stdout: `hoprig:x:1001:1001:Hoprig work user:${home}:/bin/bash\n` } : argv[0] === 'loginctl' ? { ok: true, stdout: 'Linger=no\n' } : { ok: false, code: 2, stdout: '', stderr: '' }),
};
const calls = [];
let holder = 0;
// Read when the trial asks, as the user's dashboard does: by then the copied state folder is there and has its real path.
const userKey = () => stateKey(path.join(home, '.local/state/hoprig'));
const ok = { ok: true, stdout: '', stderr: '' };
const switchSys = {
  hasRunuser: () => true, linger: async () => (calls.push('linger'), ok), waitBus: async () => true,
  installUser: async () => (calls.push('install-user'), ok), freePort: async () => 8441,
  startTrial: async () => (calls.push('trial'), { stop: async () => {} }),
  facts: async (p) => (p === 8441 || holder === 1001 ? { state: userKey() } : null),
  stopRoot: async () => (calls.push('stop-root'), (holder = null), ok), startRoot: async () => (calls.push('start-root'), (holder = 0), ok), disableRoot: async () => (calls.push('disable-root'), ok),
  installUserService: async () => (calls.push('user-service'), (holder = 1001), ok), stopUserService: async () => (calls.push('stop-user-service'), ok),
  listenerUid: async () => holder, portFree: async () => holder === null,
  writeFile: (f, t) => (calls.push('moved-file'), fs.writeFileSync(f, t)), sleep: async () => {},
};
const steps = {
  reach: async () => ({ ok: true, unreached: [] }), // never the real network
  copy: (p, o) => (calls.push('copy'), C.copyParts(p, { ...o, io: { chown: (q, uid) => owned.set(q, uid) }, asUser: capture })),
  check: (p, c, o) => (calls.push('check'), K.checkCopy(p, c, { ...o, asUser: capture, ownerOf: (q) => owned.get(q) ?? -1 })),
  switchSys: () => switchSys, own: (q) => owned.set(q, 1001),
  endTerminals: async (t) => (calls.push(`end ${t.length}`), []), gateways: async () => [], sleep: async () => {},
};

test('without a yes (no terminal to answer in) nothing is copied or changed', async () => {
  const out = [];
  const ui = { confirm: async () => false };
  assert.equal(await M.main([], { io, cfg: {}, steps, ui, out: (l) => out.push(l), err: (l) => out.push(l) }), 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(home), ['.hoprig-made-by-move'], 'only the mark Hoprig left when it made the user');
  assert.match(out.at(-1), /^Nothing was changed\. To move: hoprig move-to-user --yes/);
});

test('--yes: copy, check, switch, catch-up and terminals in that order; progress said; root\'s copy kept', async () => {
  const out = [];
  const code = await M.main(['--yes'], { io, cfg: {}, steps, out: (l) => out.push(l), err: (l) => out.push(l) });
  const text = out.join('\n');
  assert.equal(code, 0, text);
  assert.deepEqual([...calls], ['copy', 'check', 'linger', 'install-user', 'trial', 'stop-root', 'user-service', 'disable-root', 'moved-file', 'end 0'], text);
  assert.match(text, /Move Hoprig to hoprig now\? .* yes \(--yes\)/);
  assert.match(text, /^ {2}copying: \d+ of \d+ entries/m);
  assert.match(text, /The copy is checked \(\d+ s\): 1 repository with the same heads, status, branches and stashes; .* entries not owned by hoprig: 0\./);
  assert.match(text, /Done\. Hoprig runs as hoprig; sign in with the same password\. Root's copy is kept in /);
  assert.ok(fs.existsSync(path.join(shop, 'README.md')), "root's workspace is still there");
  assert.ok(fs.existsSync(path.join(home, 'Workspace/projects/shop/README.md')));
  assert.match(fs.readFileSync(path.join(root, 'HOPRIG-MOVED.txt'), 'utf8'), /runs as the user hoprig since/);
});

test("the progress line never says more than the total: root's side grew since the look", () => {
  assert.equal(M.progressLine({ phase: 'copy', entries: 195, bytes: 3e6, totalEntries: 194, totalBytes: 2e6 }), '  copying: 194 of 194 entries, 2 of 2 MB');
  assert.equal(M.progressLine({ phase: 'copy', entries: 80, bytes: 1e6, totalEntries: 194, totalBytes: 2e6 }), '  copying: 80 of 194 entries, 1 of 2 MB');
  assert.equal(M.progressLine({ phase: 'copy', entries: 7, bytes: 0, totalEntries: null, totalBytes: null }), '  copying: 7 entries, 0 MB');
});

test('--back: the user\'s service stopped, root\'s started again', async () => {
  calls.length = 0;
  holder = 1001;
  const out = [];
  assert.equal(await M.main(['--back'], { io, cfg: {}, steps, out: (l) => out.push(l), err: (l) => out.push(l) }), 0, out.join('\n'));
  assert.deepEqual(calls, ['stop-user-service', 'start-root']);
});
