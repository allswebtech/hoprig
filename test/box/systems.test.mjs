// The box (docs/BOX.md): per system. Linux uses bwrap; macOS sandbox-exec with a generated profile (deny by default, the
// same allow list, no network), whose TEXT is tested here on every system (the self-test decides on a real Mac);
// Windows, or no means, is a no with one line why and the one step that would help, as words, never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkWith } from '../../src/box/box.mjs';
import { meansCall } from '../../src/box/call.mjs';
import { startFailure } from '../../src/box/linux.mjs';
import { MAC_SYSTEM, macProfile } from '../../src/box/mac.mjs';
import { findMeans } from '../../src/box/means.mjs';

const PLAN = { argv: ['/usr/local/bin/node', 'test.mjs'], cwd: '/Users/alex/shop', write: ['/Users/alex/shop'], read: ['/opt/tools'], guard: ['/Users/alex/shop/.git'], env: { PATH: '/x/bin:/usr/bin', HOME: '/home/box', CI: '1' }, runtime: '/usr/local/lib/node' }; // seal: a plan whose profile text is read, no program is started with it
const BOX = { home: '/private/var/folders/xy/T/hoprig-box-1/home', tmp: '/private/var/folders/xy/T/hoprig-box-1/tmp' };

test('macOS: the profile denies by default, allows the closed list and the named folders, and no network', () => {
  const { text, why } = macProfile(PLAN, BOX);
  assert.equal(why, undefined);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '(version 1)');
  assert.equal(lines[1], '(deny default)');
  assert.ok(lines.includes('(deny network*)'));
  assert.doesNotMatch(text, /\(allow network/);
  assert.doesNotMatch(text, /\(allow file-read\* \(subpath "\/"\)|subpath "\/Users"\)|subpath "\/Users\/alex"\)|\/Volumes|\/dev\/tty/);
  for (const d of MAC_SYSTEM) assert.ok(text.includes(`(subpath "${d}")`), d);
  const rw = lines.find((l) => l.startsWith('(allow file-read* file-write* '));
  for (const d of [PLAN.write[0], BOX.home, BOX.tmp]) assert.ok(rw.includes(`(subpath "${d}")`), d);
  assert.ok(!rw.includes('/opt/tools') && !rw.includes(PLAN.runtime), 'read folders and the runtime are read-only');
  assert.ok(lines.some((l) => l.startsWith('(allow file-read* ') && l.includes('(subpath "/opt/tools")') && l.includes(`(subpath "${PLAN.runtime}")`)));
  // Rule 6: the git folder is denied for writing after the allow (in SBPL the later rule wins).
  const deny = lines.findIndex((l) => l.startsWith('(deny file-write*'));
  assert.ok(deny > lines.indexOf(rw) && lines[deny].includes('"/Users/alex/shop/.git"'));
  assert.ok(lines.includes('(allow signal (target same-sandbox))'), 'it signals only its own processes');
  // Only the names of the folders above a named folder may be looked up, never their contents.
  const meta = lines.find((l) => l.startsWith('(allow file-read-metadata '));
  assert.ok(meta.includes('(literal "/Users/alex")') && !meta.includes('subpath'));
});

test('macOS: a folder name with a quote, a backslash or a control character is refused, never written into the profile', () => {
  for (const bad of ['/Users/alex/a"b', '/Users/alex/a\\b', '/Users/alex/a\nb']) {
    assert.match(macProfile({ ...PLAN, write: [bad] }, BOX).why, /cannot hold/);
  }
});

test('macOS: sandbox-exec starts the command only after the profile, with the box\'s own home and temporary folder, removed afterwards', { skip: process.platform === 'win32' && 'the temporary folders are POSIX' }, () => {
  const c = meansCall('sandbox-exec', { ...PLAN, cwd: '/' });
  try {
    assert.equal(c.args[0], '-p');
    assert.match(c.args[1], /^\(version 1\)\n\(deny default\)/);
    assert.deepEqual(c.args.slice(2), ['--', ...PLAN.argv]);
    assert.equal(c.statusFd, false);
    assert.ok(fs.statSync(c.env.HOME).isDirectory() && fs.statSync(c.env.TMPDIR).isDirectory());
    assert.ok(c.args[1].includes(`(subpath "${c.env.HOME}")`));
    assert.equal(c.env.CI, '1');
  } finally {
    c.cleanup();
  }
  assert.equal(fs.existsSync(c.env.HOME), false, 'the box\'s home is gone afterwards');
  assert.equal(fs.existsSync(path.dirname(c.env.HOME)), false);
});

test('Windows: no box yet, with the one step that would help, as words', async () => {
  const m = findMeans('win32');
  assert.deepEqual(m, { kind: null, why: 'Windows has no box in Hoprig yet', step: 'run Hoprig inside WSL 2 and install bubblewrap there' });
  const r = await checkWith({ platform: 'win32', run: async () => assert.fail('nothing is started on Windows') });
  assert.equal(r.ok, false);
  assert.equal(r.step, m.step);
});

test('Linux without bwrap: install bubblewrap, as words; another system: no box', () => {
  const none = findMeans('linux', { stat: () => { throw new Error('ENOENT'); }, real: () => { throw new Error('ENOENT'); } });
  assert.equal(none.step, 'install bubblewrap (for example: sudo apt install bubblewrap)');
  assert.equal(findMeans('freebsd').kind, null);
  const mac = findMeans('darwin', { stat: () => { throw new Error('ENOENT'); }, real: () => { throw new Error('ENOENT'); } });
  assert.equal(mac.kind, null);
});

test('a bwrap that may not make its spaces, or is too old: that why, and the step', () => {
  for (const line of ['bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces', 'bwrap: setting up uid map: Permission denied', 'bwrap: Creating new namespace failed: Operation not permitted']) {
    const f = startFailure(line);
    assert.match(f.why, /^bubblewrap is not allowed to make its spaces here/);
    assert.match(f.step, /user namespaces/);
  }
  assert.match(startFailure('bwrap: Unknown option --disable-userns').step, /0\.8 or later/);
  assert.equal(startFailure('bwrap: execvp x: No such file or directory').step, '');
});

test('a command that cannot be started is not a broken box: its own message, and never the AppArmor step', () => {
  const notThere = startFailure('bwrap: execvp nosuchprog: No such file or directory');
  assert.match(notThere.why, /^the command could not be started: nosuchprog is not there$/);
  assert.equal(notThere.step, '');
  const notExec = startFailure('bwrap: execvp ./notexec.sh: Permission denied');
  assert.match(notExec.why, /^the command could not be started: \.\/notexec\.sh cannot be run/);
  assert.equal(notExec.step, '', 'no AppArmor step for a command that only lacks its execute bit');
});

test('the AppArmor step names what grants user namespaces and points to the page by its URL, not a relative path', () => {
  const f = startFailure('bwrap: setting up uid map: Permission denied');
  assert.match(f.step, /user namespaces/);
  assert.match(f.step, /https:\/\/github\.com\/[^\s)]+\/docs\/BOX\.md/);
});

test('the step is words only: nothing in the box starts an installer or a program that raises rights', () => {
  const dir = path.resolve(import.meta.dirname, '..', '..', 'src', 'box');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /spawn\w*\(\s*['"`](sudo|su|pkexec|doas|apt|apt-get|brew)['"`]/, f);
    assert.doesNotMatch(text, /\[\s*['"`](sudo|pkexec|doas)['"`]/, f);
  }
});
