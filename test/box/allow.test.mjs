// The box (docs/BOX.md): an allow list of folders, never the whole disk minus a list. Inside: a closed list of system
// folders read-only, the runtime of Node read-only, the caller's read and write folders, a home and a /tmp of its own,
// a small /dev and its own /proc. Nothing else of the real home, wherever it is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boxCheck, planRun, realHomes, refused, runBoxed, runWith, userLink, walkFolder } from '../../src/box/box.mjs';
import { BOX_HOME, ETC, bwrapArgs } from '../../src/box/linux.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-allow-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const work = path.join(tmp, 'work');
const lib = path.join(tmp, 'lib');
const outside = path.join(tmp, 'outside');
for (const d of [work, lib, outside]) fs.mkdirSync(d);
fs.writeFileSync(path.join(lib, 'shared.txt'), 'shared');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'made-up secret');
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

/** The pairs of a bind option in `args`: [[from, to], ...]. */
const binds = (args, opt) => args.flatMap((a, i) => (a === opt ? [[args[i + 1], args[i + 2]]] : []));

test('the arguments name a closed list: /usr and the loader\'s names of /etc, never /, /home, /etc, /opt or /var', () => {
  const p = planRun(['/bin/true'], { cwd: work, write: [work], read: [lib], timeoutMs: 1000 }, { homes: ['/home/alex'] });
  assert.equal(p.why, undefined);
  const { args } = bwrapArgs(p);
  const ro = binds(args, '--ro-bind').map(([from]) => from);
  const tryRo = binds(args, '--ro-bind-try').map(([from]) => from);
  const rw = binds(args, '--bind').map(([from]) => from);
  assert.deepEqual(rw, [work], 'only the write folder is writable');
  for (const d of ['/', '/home', '/root', '/run', '/var', '/mnt', '/media', '/etc', '/opt', '/nix', '/tmp']) {
    assert.ok(![...ro, ...tryRo, ...rw].includes(d), `${d} is not bound`);
  }
  assert.deepEqual(tryRo, ETC.map((n) => `/etc/${n}`));
  assert.ok(ro.includes('/usr') && ro.includes(lib) && ro.includes(p.runtime));
  assert.ok(args.includes('--tmpfs') && args[args.indexOf(BOX_HOME) - 1] === '--tmpfs', 'the home is a memory folder');
  assert.ok(args.join(' ').includes('--tmpfs /tmp'), '/tmp is a memory folder');
  assert.ok(args.join(' ').includes('--dev /dev') && args.join(' ').includes('--proc /proc'));
});

test('the whole disk, a real home, or a folder that holds one is refused: nothing runs', () => {
  const homes = ['/home/alex', '/srv/users/alex'];
  assert.equal(refused('/', homes), 'the whole disk');
  assert.equal(refused('/home/alex', homes), 'a home');
  assert.equal(refused('/home', homes), 'a folder that holds a home');
  assert.equal(refused('/srv', homes), 'a folder that holds a home');
  assert.equal(refused('/home/alex/shop', homes), '', 'a project in the home may be named');
  assert.equal(refused('/home/alexander', homes), '');
  for (const opt of ['write', 'read']) {
    const p = planRun(['/bin/true'], { cwd: work, write: [work], [opt]: [path.dirname(tmp)], timeoutMs: 1000 }, { homes: [path.join(path.dirname(tmp), 'alex')] });
    assert.match(p.why, /holds a home/, opt);
  }
  // The runtime of Node itself, when it would be a home or hold one.
  const p = planRun(['/bin/true'], { cwd: work, write: [work], timeoutMs: 1000 }, { execPath: '/home/alex/bin/node', real: (x) => x, stat: () => ({ isDirectory: () => true }), homes: ['/home/alex'] });
  assert.match(p.why, /folder of Node .* is a home/);
});

test('both real homes are known: the password database\'s and the one HOME names', () => {
  const homes = realHomes();
  assert.ok(homes.includes(path.resolve(os.userInfo().homedir)));
  assert.ok(homes.includes(path.resolve(os.homedir())));
});

test('in the real box: only the named folders are there, a file outside cannot be read, the home is the box\'s own', { skip }, async () => {
  const script = `
    const fs = require('fs');
    const tryRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return e.code; } };
    const list = (p) => { try { return fs.readdirSync(p).sort(); } catch (e) { return e.code; } };
    console.log(JSON.stringify({
      top: list('/'), etc: list('/etc'), home: list(${JSON.stringify(BOX_HOME)}), tmp: list('/tmp'),
      outside: tryRead(${JSON.stringify(path.join(outside, 'secret.txt'))}),
      shared: tryRead(${JSON.stringify(path.join(lib, 'shared.txt'))}),
      writeLib: (() => { try { fs.writeFileSync(${JSON.stringify(path.join(lib, 'x'))}, 'x'); return 'written'; } catch (e) { return e.code; } })(),
      passwd: tryRead('/etc/passwd'),
      callerHome: list(${JSON.stringify(os.homedir())}),
      dbHome: list(${JSON.stringify(os.userInfo().homedir)}),
    }));`;
  const r = await runBoxed([process.execPath, '-e', script], { cwd: work, write: [work], read: [lib], timeoutMs: 20_000 });
  assert.equal(r.ok, true, r.why + r.out);
  const seen = JSON.parse(r.out.trim().split('\n').pop());
  const allowedTop = new Set(['bin', 'dev', 'etc', 'home', 'lib', 'lib64', 'proc', 'sbin', 'tmp', 'usr', ...[work, lib, process.execPath].map((d) => d.split('/')[1])]);
  assert.deepEqual(seen.top.filter((n) => !allowedTop.has(n)), [], `only named folders at the top: ${seen.top}`);
  assert.deepEqual(seen.etc.filter((n) => ![...ETC, 'passwd', 'group', 'hosts'].includes(n)), []);
  assert.deepEqual(seen.home, [], 'the box\'s home is empty');
  assert.equal(seen.outside, 'ENOENT');
  assert.equal(seen.shared, 'shared');
  assert.equal(seen.writeLib, 'EROFS', 'a read folder is read-only');
  assert.match(seen.passwd, /^box:x:\d+:\d+:box:\/home\/box:/);
  assert.doesNotMatch(seen.passwd, new RegExp(os.userInfo().username === 'box' ? '$^' : os.userInfo().username), 'no real user name');
  // The real homes: absent, or holding nothing but the path down to a named folder (the runtime of Node may live there).
  const named = [work, lib, fs.realpathSync(process.execPath)];
  for (const [h, got] of [[os.homedir(), seen.callerHome], [os.userInfo().homedir, seen.dbHome]]) {
    if (got === 'ENOENT') continue;
    const allowed = new Set(named.filter((d) => d.startsWith(h + '/')).map((d) => d.slice(h.length + 1).split('/')[0]));
    assert.deepEqual(got.filter((n) => !allowed.has(n)), [], `the home ${h} shows only parents of named folders`);
  }
});

test('a system folder, or a folder that holds one, is refused: those bring sockets and processes back into the box', () => {
  for (const d of ['/proc', '/sys', '/dev', '/run', '/var', '/var/run', '/etc', '/mnt', '/media', '/tmp']) {
    assert.match(refused(d, []), /^a system folder$/, d);
  }
  const uid = process.getuid?.();
  if (uid != null) {
    assert.match(refused(`/run/user/${uid}`, []), /system folder/, 'the session socket folder under /run');
    assert.match(refused(`/tmp/tmux-${uid}`, []), /system folder/, "tmux's socket folder");
  }
  assert.equal(refused('/var/lib/made-up-under-var', []), '', 'a folder under a system folder, not the folder itself, may be named');
});

test('planRun refuses a system folder as a read or a write folder: nothing runs', () => {
  // The ones this computer has (macOS has no /proc and no /run).
  const here = ['/proc', '/run', '/var', '/etc', '/tmp'].filter((d) => fs.existsSync(d));
  assert.ok(here.length >= 3, here.join(' '));
  for (const opt of ['read', 'write']) {
    for (const d of here) {
      const p = planRun(['/bin/true'], { cwd: work, write: [work], [opt]: [d], timeoutMs: 1000 }, { homes: ['/home/alex'] });
      assert.match(p.why, /system folder/, `${opt} ${d}`);
    }
  }
});

test('a system folder reached through a link (macOS: /var, /etc and /tmp lead to /private/...) is refused by the place it leads to', () => {
  const mac = { '/var': '/private/var', '/etc': '/private/etc', '/tmp': '/private/tmp' };
  // As on a Mac: the links are root's, so the walk follows them to the place they lead to.
  const inj = { real: (x) => mac[x] || x, stat: () => ({ isDirectory: () => true }), lstat: (x) => ({ isSymbolicLink: () => x in mac, uid: 0 }), readlink: (x) => mac[x].slice(1), homes: ['/Users/alex'] };
  for (const opt of ['read', 'write']) {
    for (const d of Object.keys(mac)) {
      const p = planRun(['/bin/true'], { cwd: work, write: [work], [opt]: [d], timeoutMs: 1000 }, inj);
      assert.match(p.why || '', /system folder/, `${opt} ${d}`);
    }
  }
  assert.match(planRun(['/bin/true'], { cwd: work, write: [work], read: ['/private'], timeoutMs: 1000 }, inj).why || '', /holds a system folder/);
});

test('a write folder that is, or holds, the folder of Node is refused: its Node and global packages would be writable', () => {
  const inj = { execPath: '/opt/mk-rt/v1/bin/node', real: (x) => x, stat: () => ({ isDirectory: () => true }), lstat: () => ({ isSymbolicLink: () => false }), homes: ['/home/alex'] };
  const isRt = planRun(['/bin/true'], { cwd: '/opt/mk-rt/v1', write: ['/opt/mk-rt/v1'], timeoutMs: 1000 }, inj);
  assert.match(isRt.why, /folder of Node or holds it/);
  const holdsRt = planRun(['/bin/true'], { cwd: '/opt/mk-rt/v1', write: ['/opt/mk-rt'], timeoutMs: 1000 }, inj);
  assert.match(holdsRt.why, /folder of Node or holds it/);
});

test('a write folder inside the folder of Node is refused, and in the real box its node stays as it was', async () => {
  const inj = { execPath: '/opt/mk-rt/v1/bin/node', real: (x) => x, stat: () => ({ isDirectory: () => true }), lstat: () => ({ isSymbolicLink: () => false }), homes: ['/home/alex'] };
  for (const d of ['/opt/mk-rt/v1/bin', '/opt/mk-rt/v1/lib/node_modules']) {
    const p = planRun(['/bin/true'], { cwd: d, write: [d], timeoutMs: 1000 }, inj);
    assert.match(p.why, /lies inside the folder of Node \(\/opt\/mk-rt\/v1\)/, d);
  }
  const read = planRun(['/bin/true'], { cwd: '/opt/mk-rt/v1/bin', read: ['/opt/mk-rt/v1/bin'], timeoutMs: 1000 }, inj);
  assert.equal(read.why, undefined, 'a read folder there stays read-only and is allowed');
  // A made-up runtime on the real disk: the run is refused, so its bin/node is not changed.
  const rt = path.join(tmp, 'made-up-rt');
  const bin = path.join(rt, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), 'ORIGINAL\n');
  const p = planRun(['/bin/sh', '-c', `echo CHANGED > ${path.join(bin, 'node')}`], { cwd: bin, write: [bin], timeoutMs: 8000 }, { execPath: path.join(bin, 'node'), homes: ['/home/alex'] });
  assert.match(p.why, /lies inside the folder of Node/);
  if (!skip) {
    const r = await runWith(['/bin/sh', '-c', `echo CHANGED > ${path.join(bin, 'node')}`], { cwd: bin, write: [bin], timeoutMs: 8000 }, { plan: (a, o) => planRun(a, o, { execPath: path.join(bin, 'node') }) });
    assert.equal(r.ok, false);
    assert.match(r.why, /nothing ran: write: .* lies inside the folder of Node/);
  }
  assert.equal(fs.readFileSync(path.join(bin, 'node'), 'utf8'), 'ORIGINAL\n');
});

test('a named folder reached through a link planted inside a write folder is refused; the real target is allowed', () => {
  const proj = path.join(tmp, 'proj7');
  const secretDir = path.join(tmp, 'made-up-private7');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  fs.symlinkSync(secretDir, path.join(proj, 'vendor')); // what a session's own run could leave behind in its write folder
  const viaLink = planRun(['/bin/true'], { cwd: proj, write: [proj], read: [path.join(proj, 'vendor')], timeoutMs: 1000 }, { homes: ['/home/alex'] });
  assert.match(viaLink.why, /read: .* is reached through a link a command could have made/);
  const named = planRun(['/bin/true'], { cwd: proj, write: [proj], read: [secretDir], timeoutMs: 1000 }, { homes: ['/home/alex'] });
  assert.equal(named.why, undefined, 'naming the real target is allowed (DECIDED 5)');
});

test('a link left in a folder named only as read (a write folder of an earlier run) is refused, however the path is spelt', async () => {
  const base = path.join(tmp, 'link-read');
  const proj = path.join(base, 'proj');
  const other = path.join(base, 'other');
  const secretDir = path.join(base, 'made-up-private');
  for (const d of [proj, other, secretDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(secretDir, 'token.txt'), 'MADE-UP-TOKEN');
  fs.symlinkSync(secretDir, path.join(proj, 'vendor')); // left by an earlier run in which proj was writable
  fs.mkdirSync(path.join(secretDir, 'sub'));
  const vendor = path.join(proj, 'vendor');
  const cases = [
    ['read proj and its link', { cwd: proj, read: [proj, vendor] }],
    ['read the link only', { cwd: other, write: [other], read: [vendor] }],
    ['write through the link', { cwd: other, write: [other, path.join(vendor, 'sub')] }],
    ['".." after the link', { cwd: other, write: [other], read: [path.join(vendor, 'sub', '..')] }],
  ];
  for (const [label, opts] of cases) {
    const p = planRun(['/bin/cat', path.join(vendor, 'token.txt')], { ...opts, timeoutMs: 8000 }, { homes: ['/home/alex'] });
    assert.match(p.why || '', /is reached through a link a command could have made \(.*\/proj\/vendor\)/, label);
  }
  const named = planRun(['/bin/cat', path.join(secretDir, 'token.txt')], { cwd: other, write: [other], read: [secretDir], timeoutMs: 8000 }, { homes: ['/home/alex'] });
  assert.equal(named.why, undefined, 'naming the real target is allowed (DECIDED 5)');
  if (!skip) {
    const r = await runBoxed(['/bin/cat', path.join(vendor, 'token.txt')], { cwd: proj, read: [proj, vendor], timeoutMs: 8000 });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.out, /MADE-UP-TOKEN/, 'the box did not read through the link');
  }
});

test('a named folder is one place: a spelling that reads to another place than it walks to is refused, and nothing is read through it', async () => {
  const base = path.join(tmp, 'one-place');
  const proj = path.join(base, 'proj');
  const other = path.join(base, 'other');
  const secretDir = path.join(base, 'made-up-private');
  for (const d of [proj, other, secretDir, path.join(proj, 'sub')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(secretDir, 'token.txt'), 'MADE-UP-TOKEN');
  fs.symlinkSync(secretDir, path.join(proj, 'vendor')); // left by an earlier run in which proj was writable
  const token = path.join(secretDir, 'token.txt');
  const plan = (read) => planRun(['/bin/cat', token], { cwd: other, write: [other], read: [read], timeoutMs: 8000 }, { homes: ['/home/alex'] });
  // Read by its spelling, each of these is proj/vendor (the link); walked, the first two reach nothing at all.
  const twoWays = [
    ['".." after a name that is not there', `${proj}/nope/../vendor`],
    ['".." after a link of the system', `/bin/..${proj}/vendor`],
  ];
  for (const [label, d] of twoWays) {
    const p = plan(d);
    assert.match(p.why || '', /^read: .* (does not name one place|is reached through a link a command could have made)/, label);
    assert.equal(p.read, undefined, `${label}: no plan, so nothing is bound`);
  }
  // Spelt with ".", a doubled slash or a closing slash, the link is still seen as the link.
  for (const d of [`${proj}/./vendor`, `${proj}//vendor`, `${proj}/vendor/`, `${proj}/sub/../vendor`]) {
    assert.match(plan(d).why || '', /is reached through a link a command could have made \(.*\/proj\/vendor\)/, d);
  }
  assert.match(plan('proj/vendor').why, /not an absolute path/, 'a relative path is never resolved against anything');
  // A real folder spelt the long way round is the same one place as its plain name, and is allowed.
  const long = plan(`${proj}/sub/../../proj/sub`);
  assert.equal(long.why, undefined);
  assert.deepEqual(long.read, plan(path.join(proj, 'sub')).read, 'the same folder is bound, by its real name');
  // The three answers of the walk itself.
  assert.deepEqual(walkFolder(`${proj}/nope/../vendor`), { missing: path.join(proj, 'nope') });
  assert.deepEqual(walkFolder(`${proj}/sub/../vendor/x`), { link: path.join(proj, 'vendor') });
  assert.deepEqual(walkFolder(`${proj}/sub/..//./sub/`), { real: path.join(proj, 'sub') });
  if (!skip) {
    for (const [label, d] of twoWays) {
      const r = await runBoxed(['/bin/cat', token], { cwd: other, write: [other], read: [d], timeoutMs: 8000 });
      assert.equal(r.code, null, `${label}: nothing ran`);
      assert.doesNotMatch(r.out || '', /MADE-UP-TOKEN/, `${label}: the box did not read through the link`);
    }
  }
});

test('a link of the system (root\'s) on the way to a folder is followed, a link of the user is not', () => {
  const st = (uid, link) => ({ uid, isSymbolicLink: () => link });
  const fake = { '/sys-link': st(0, true), '/real': st(0, false), '/real/proj': st(1000, false), '/real/proj/l': st(1000, true) };
  const lstat = (p) => {
    if (fake[p]) return fake[p];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const readlink = (p) => ({ '/sys-link': '/real', '/real/proj/l': '/elsewhere' })[p];
  assert.equal(userLink('/sys-link/proj', { lstat, readlink, uid: 1000 }), '', 'a link root owns is followed');
  assert.equal(userLink('/sys-link/proj/l/x', { lstat, readlink, uid: 1000 }), '/real/proj/l', 'the user\'s link is named by its real place');
  assert.equal(userLink('/sys-link/proj', { lstat, readlink, uid: 0 }), '/sys-link', 'run as root, every link counts');
});

test('the arguments bind a read folder inside a write folder read-only AFTER the write folder, so read-only wins', () => {
  const inner = path.join(work, 'vendor-ro');
  fs.mkdirSync(inner, { recursive: true });
  const p = planRun(['/bin/true'], { cwd: work, write: [work], read: [inner], timeoutMs: 1000 }, { homes: ['/home/alex'] });
  assert.equal(p.why, undefined);
  const { args } = bwrapArgs(p);
  const bindWork = args.findIndex((a, i) => a === '--bind' && args[i + 1] === work);
  const roInner = args.findIndex((a, i) => a === '--ro-bind' && args[i + 1] === inner);
  assert.ok(bindWork >= 0, 'the write folder is bound');
  assert.ok(roInner > bindWork, `the read folder inside the write folder is bound read-only after it (bind@${bindWork}, ro@${roInner})`);
});

test('the arguments hide the runtime\'s own etc with an empty folder, where the runtime has one', () => {
  const rt = path.join(tmp, 'rt-with-etc');
  fs.mkdirSync(path.join(rt, 'etc'), { recursive: true });
  const p = planRun(['/bin/true'], { cwd: work, write: [work], timeoutMs: 1000 }, { homes: ['/home/alex'] });
  const withEtc = bwrapArgs({ ...p, runtime: rt }).args;
  assert.ok(withEtc.some((a, i) => a === '--tmpfs' && withEtc[i + 1] === path.join(rt, 'etc')), 'runtime/etc is an empty folder inside');
  const rt2 = path.join(tmp, 'rt-no-etc');
  fs.mkdirSync(rt2, { recursive: true });
  const noEtc = bwrapArgs({ ...p, runtime: rt2 }).args;
  assert.ok(!noEtc.some((a, i) => a === '--tmpfs' && noEtc[i + 1] === path.join(rt2, 'etc')), 'nothing is added where the runtime has no etc');
});

test('in the real box: a read folder inside a write folder is read-only, the write folder writable', { skip }, async () => {
  const inner = path.join(work, 'vendor-real');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'v.txt'), 'made-up');
  const script = `const fs = require('fs');
    let w; try { fs.writeFileSync(${JSON.stringify(path.join(inner, 'x'))}, 'x'); w = 'written'; } catch (e) { w = e.code; }
    let r; try { r = fs.readFileSync(${JSON.stringify(path.join(inner, 'v.txt'))}, 'utf8'); } catch (e) { r = e.code; }
    let ok; try { fs.writeFileSync(${JSON.stringify(path.join(work, 'ok-real.txt'))}, 'y'); ok = 'written'; } catch (e) { ok = e.code; }
    console.log(JSON.stringify({ w, r, ok }));`;
  const res = await runBoxed([process.execPath, '-e', script], { cwd: work, write: [work], read: [inner], timeoutMs: 20_000 });
  assert.equal(res.ok, true, res.why + res.out);
  const s = JSON.parse(res.out.trim().split('\n').pop());
  assert.equal(s.w, 'EROFS', 'the read folder inside the write folder stays read-only');
  assert.equal(s.r, 'made-up');
  assert.equal(s.ok, 'written');
});
