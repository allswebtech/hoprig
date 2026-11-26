// A locale the computer lacks (an ssh client's LANG on a fresh cloud server): set-up says so once with the fix and
// runs its programs with C.UTF-8 (else C); the service never carries such a variable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, fakeClaude, fakeFetch, pathWith, recorder, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
globalThis.fetch = fakeFetch({ 'https://downloads.claude.ai/claude-code-releases/latest': '2.1.300' });
const L = await import('../../src/setup/locale.mjs');
const K = await import('../../src/setup/checks.mjs');
const SU = await import('../../src/setup/setup.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { unitText } = await import('../../src/server/service/systemd.mjs');
const { carried } = await import('../../src/server/service/env.mjs');

const SERVER = L.parseLocales('C\nC.utf8\nPOSIX\n'); // what a fresh cloud server has
const NOPARTS = {
  workspace: async () => ({ ok: true, changed: false }), git: async () => ({ ok: true, changed: false }),
  pc: async () => ({ ok: true, changed: false, missing: [], code: 0 }), projects: async () => ({ dir: '/nowhere', names: [] }),
  projectSkills: async () => ({ ok: true, added: [], skipped: [] }), userSkills: async () => ({ ok: true, added: [], skipped: [] }),
};

test('which locales are there, and the environment set-up runs its programs with', () => {
  assert.equal(L.localeThere('C.UTF-8', SERVER), true);
  assert.equal(L.localeThere('en_GB.UTF-8', SERVER), false);
  assert.equal(L.localeThere('en_GB.UTF-8', null), true, 'not known: nothing is judged');
  assert.deepEqual(L.missingLocale({ LANG: 'C.UTF-8', LC_ALL: 'de_DE.UTF-8' }, SERVER), { name: 'LC_ALL', value: 'de_DE.UTF-8' });
  assert.equal(L.missingLocale({ LANG: 'C.UTF-8' }, SERVER), null);
  assert.deepEqual(L.withWorkingLocale({ LANG: 'en_GB.UTF-8', LC_CTYPE: 'UTF-8', PATH: '/x' }, SERVER), { PATH: '/x', LANG: 'C.UTF-8' }); // seal: a value no program is started with
  assert.deepEqual(L.withWorkingLocale({ LC_ALL: 'en_GB.UTF-8' }, L.parseLocales('C\nPOSIX\n')), { LANG: 'C' }, 'no C.UTF-8 either: C');
});

test('the service carries no LANG, LC_ALL or LC_CTYPE that names a missing locale; one that is there stays', () => {
  const env = { PATH: '/usr/bin', LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', LC_CTYPE: 'C.UTF-8' }; // seal: a value no program is started with
  assert.deepEqual(carried(env, SERVER), [['PATH', '/usr/bin'], ['LC_CTYPE', 'C.UTF-8']]);
  const u = unitText({ node: '/n', bin: '/b', env, locales: SERVER });
  assert.doesNotMatch(u, /LANG=|LC_ALL=/);
  assert.match(u, /^Environment="LC_CTYPE=C\.UTF-8"$/m);
  assert.match(unitText({ node: '/n', bin: '/b', env, locales: L.parseLocales('C\nen_GB.utf8\n') }), /^Environment="LANG=en_GB\.UTF-8"$/m);
});

test('set-up says it once with the fix, and its programs run with C.UTF-8', { skip: process.platform === 'win32' && 'a missing locale is a Linux matter (locale-gen): a Linux computer is handed in' }, async () => {
  const seen = path.join(s.tmp, 'claude-lang.txt');
  const bin = fakeBin(path.join(s.tmp, 'bin'), { claude: `printf '%s|%s\\n' "\${LANG:-}" "\${LC_ALL:-}" >> '${seen}'\n${fakeClaude({ loggedIn: true })}` });
  const env = { ...process.env, PATH: pathWith(s.tmp, bin), LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8' };
  for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[k];
  const sys = K.sysInfo({ env, platform: 'linux', has: (c) => c !== 'systemctl' && !!K.sysInfo({ env }).has(c), pm: 'apt', root: false, serviceSupported: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, locales: SERVER, release: { ID: 'ubuntu', ID_LIKE: 'debian' } });
  sys.probe = async () => 0;
  const rec = recorder();
  const ui = makeUi({ interactive: false, write: rec.write, askLine: async () => '' });
  await SU.setup(['--yes', '--no-service', '--only', 'base'], { ui, sys, parts: NOPARTS });
  const lines = rec.text.split('\n').filter((l) => /locale/.test(l));
  assert.deepEqual(lines.map((l) => l.trim()), ['! The locale en_GB.UTF-8 (LC_ALL, sent by your terminal) is not on this computer: set-up runs its programs with C.UTF-8. Fix: sudo locale-gen en_GB.UTF-8'], rec.text);
  const ran = fs.readFileSync(seen, 'utf8').trim().split('\n');
  assert.ok(ran.length >= 1);
  for (const l of ran) assert.equal(l, 'C.UTF-8|', 'every run of the program: LANG=C.UTF-8, no LC_ALL');
});

test('the parts after the dashboard\'s steps start their programs with C.UTF-8 too (they use this process\'s environment)', { skip: process.platform === 'win32' && 'a missing locale is a Linux matter (locale-gen): a Linux computer is handed in' }, async () => {
  const seen = path.join(s.tmp, 'part-lang.txt');
  const bin = fakeBin(path.join(s.tmp, 'bin-parts'), { claude: fakeClaude({ loggedIn: true }), probe: `printf '%s|%s\\n' "\${LANG:-}" "\${LC_ALL:-}" >> '${seen}'` });
  const was = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
  Object.assign(process.env, { LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8' });
  try {
    const env = { ...process.env, PATH: pathWith(s.tmp, bin) };
    for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[k];
    const sys = K.sysInfo({ env, platform: 'linux', has: (c) => c !== 'systemctl' && !!K.sysInfo({ env }).has(c), pm: 'apt', root: false, serviceSupported: false, publicIps: [], dmi: {}, localDisplay: false, savedServer: null, locales: SERVER });
    sys.probe = async () => 0;
    const { capture } = await import('../../src/setup/system.mjs');
    // As the Git step and the computer step run their programs: with no env of their own, so process.env's.
    const part = async () => {
      await capture([path.join(bin, 'probe')]);
      return { ok: true, changed: false };
    };
    const rec = recorder();
    await SU.setup(['--yes', '--no-service', '--only', 'git'], { ui: makeUi({ interactive: false, write: rec.write, askLine: async () => '' }), sys, parts: { ...NOPARTS, git: part } });
    assert.equal(fs.readFileSync(seen, 'utf8'), 'C.UTF-8|\n', rec.text);
  } finally {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('the fix can be typed as it is said: locale-gen with a name on Ubuntu only; a value with no language is changed on your side', () => {
  const ubuntu = { ID: 'ubuntu', ID_LIKE: 'debian' };
  const debian = { ID: 'debian' };
  const words = (env, o) => L.localeWords(L.missingLocale(env, SERVER), 'C.UTF-8', o);
  assert.match(words({ LANG: 'en_GB.UTF-8' }, { pm: 'apt', release: ubuntu }), /Fix: sudo locale-gen en_GB\.UTF-8$/);
  assert.match(words({ LANG: 'en_GB.UTF-8' }, { pm: 'apt', release: debian }), /Fix: sudo dpkg-reconfigure locales \(choose en_GB\.UTF-8\)$/, 'Debian\'s locale-gen takes no name');
  assert.match(words({ LANG: 'en_GB.UTF-8' }, { pm: 'dnf', release: { ID: 'fedora' } }), /Fix: export LANG=C\.UTF-8 in your shell's start file$/);
  // macOS's ssh sends LC_CTYPE=UTF-8: no locale has that name, so nothing here can make it.
  for (const release of [ubuntu, debian]) {
    const w = words({ LC_CTYPE: 'UTF-8' }, { pm: 'apt', release });
    assert.match(w, /Fix: export LC_CTYPE=C\.UTF-8 in your shell's start file on this computer, or stop your ssh client sending it \(SendEnv LC_\* in its ssh config\)$/);
    assert.doesNotMatch(w, /locale-gen|dpkg-reconfigure/);
  }
});
