// The kits block of the shell start files (src/setup/localbin.mjs ensureKitsBlock): ONE block between marker lines,
// written once and replaced in place, never doubled, the home as $HOME; a start file that is a link, or one where the
// owner sets the variable himself, is left as it is, and said.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BLOCK_BEGIN, BLOCK_END, MARK, ensureCommand, ensureKitsBlock, kitsBlockHas, ownValue, shellValue } from '../../src/setup/localbin.mjs';

const homeOf = (tc) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsblock-'));
  tc.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};
const FLUTTER = { key: 'flutter', var: 'PATH', prepend: true, value: '$HOME/Workspace/development/flutter/flutter/bin' };
const NVM = { key: 'nvm', var: 'NVM_DIR', value: '$HOME/Workspace/development/nodejs/nvm' };
const count = (text, s) => text.split(s).length - 1;

test('written once between two marker lines; a second run changes nothing; a new line joins the same block', { skip: process.platform === 'win32' && 'the kits block is written into the start files of Linux and macOS shells only (Windows gets none)' }, (tc) => {
  const home = homeOf(tc);
  fs.writeFileSync(path.join(home, '.bashrc'), '# the owner\'s own\nalias ll="ls -l"\n');
  const o = { home, shell: '/bin/bash', platform: 'linux' };
  const first = ensureKitsBlock({ ...o, lines: [FLUTTER] });
  assert.deepEqual(first.did, ['wrote the kits block in ~/.profile', 'wrote the kits block in ~/.bashrc']);
  const rc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.equal(rc, `${BLOCK_BEGIN}\ncase ":$PATH:" in *":$HOME/Workspace/development/flutter/flutter/bin:"*) ;; *) PATH="$HOME/Workspace/development/flutter/flutter/bin:$PATH"; export PATH ;; esac  # flutter\n${BLOCK_END}\n# the owner's own\nalias ll="ls -l"\n`, 'at the top of ~/.bashrc, before its "not interactive" stop');
  assert.deepEqual(ensureKitsBlock({ ...o, lines: [FLUTTER] }), { did: [], kept: [] });
  assert.ok(kitsBlockHas(FLUTTER, o));
  assert.ok(!kitsBlockHas(NVM, o));
  ensureKitsBlock({ ...o, lines: [NVM] });
  for (const f of ['.profile', '.bashrc']) {
    const t = fs.readFileSync(path.join(home, f), 'utf8');
    assert.equal(count(t, BLOCK_BEGIN), 1, `${f}: one block`);
    assert.equal(count(t, '# flutter'), 1);
    assert.match(t, /# flutter\nexport NVM_DIR="\$HOME\/Workspace\/development\/nodejs\/nvm"  # nvm\n# <<< hoprig kits <<</);
  }
});

test('a line of the same key is replaced in place; the rest of the file stays as it was', (tc) => {
  const home = homeOf(tc);
  const before = `export EDITOR=vi\n${BLOCK_BEGIN}\nexport NVM_DIR="$HOME/old/nvm"  # nvm\n${BLOCK_END}\nexport LAST=1\n`;
  fs.writeFileSync(path.join(home, '.profile'), before);
  ensureKitsBlock({ home, shell: '/bin/sh', platform: 'linux', lines: [NVM] });
  assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), `export EDITOR=vi\n${BLOCK_BEGIN}\nexport NVM_DIR="$HOME/Workspace/development/nodejs/nvm"  # nvm\n${BLOCK_END}\nexport LAST=1\n`);
});

test('a start file that is a link, and the owner\'s own line, are left as they are and said', { skip: process.platform === 'win32' && 'the kits block is written into the start files of Linux and macOS shells only (Windows gets none)' }, (tc) => {
  const home = homeOf(tc);
  const real = path.join(home, 'dotfiles-profile');
  fs.writeFileSync(real, 'export A=1\n');
  fs.symlinkSync(real, path.join(home, '.profile'));
  fs.writeFileSync(path.join(home, '.bashrc'), 'export NVM_DIR="$HOME/.nvm"\n');
  const r = ensureKitsBlock({ home, shell: '/bin/bash', platform: 'linux', lines: [NVM] });
  assert.deepEqual(r.did, []);
  assert.deepEqual(r.kept, ['~/.profile is a link: left as it is (add the lines yourself if you want them there)', '~/.bashrc sets NVM_DIR itself: your line is left as it is']);
  assert.equal(fs.readFileSync(real, 'utf8'), 'export A=1\n');
  assert.equal(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), 'export NVM_DIR="$HOME/.nvm"\n');
});

test('a block whose end line is gone, or a second begin line, leaves the file as it is and says so; later runs too', { skip: process.platform === 'win32' && 'the kits block is written into the start files of Linux and macOS shells only (Windows gets none)' }, (tc) => {
  const home = homeOf(tc);
  const o = { home, shell: '/bin/sh', platform: 'linux' };
  const cases = {
    '.profile': `export A=1\n${BLOCK_BEGIN}\nexport B=2\nexport C=3\n`,
    '.bash_profile': `export A=1\n${BLOCK_BEGIN}\nexport B=2\n${BLOCK_BEGIN}\nexport C=3\n${BLOCK_END}\n`,
  };
  for (const [f, text] of Object.entries(cases)) fs.writeFileSync(path.join(home, f), text);
  const first = ensureKitsBlock({ ...o, lines: [FLUTTER] });
  assert.deepEqual(first.did, []);
  assert.deepEqual(first.kept, [
    '~/.profile has a hoprig kits block without its end line, or two begin lines: left as it is (mend or remove the block, then run this again)',
    '~/.bash_profile has a hoprig kits block without its end line, or two begin lines: left as it is (mend or remove the block, then run this again)',
  ]);
  ensureKitsBlock({ ...o, lines: [NVM] });
  ensureKitsBlock({ ...o, lines: [FLUTTER, NVM] });
  for (const [f, text] of Object.entries(cases)) assert.equal(fs.readFileSync(path.join(home, f), 'utf8'), text, `${f}: every byte as the owner left it`);
  assert.ok(kitsBlockHas(NVM, o), 'nothing is due in a file that is left alone');
});

test('a line the owner put inside the block, with no key, stays when the block is written again', (tc) => {
  const home = homeOf(tc);
  const before = `export EDITOR=vi\n${BLOCK_BEGIN}\nexport NVM_DIR="$HOME/old/nvm"  # nvm\nexport MINE=1\n${BLOCK_END}\nexport LAST=1\n`;
  fs.writeFileSync(path.join(home, '.profile'), before);
  ensureKitsBlock({ home, shell: '/bin/sh', platform: 'linux', lines: [NVM, FLUTTER] });
  const t = fs.readFileSync(path.join(home, '.profile'), 'utf8');
  assert.match(t, /^export EDITOR=vi\n/);
  assert.match(t, /\nexport MINE=1\n/);
  assert.match(t, /export NVM_DIR="\$HOME\/Workspace\/development\/nodejs\/nvm"  # nvm\n/);
  assert.match(t, /# flutter\n# <<< hoprig kits <<<\nexport LAST=1\n$/);
  assert.equal(count(t, BLOCK_BEGIN), 1);
});

test('fish gets its own form; a dry run writes nothing; the PATH line of hoprig setup stays its own', (tc) => {
  const home = homeOf(tc);
  const o = { home, shell: '/usr/bin/fish', platform: 'linux' };
  assert.deepEqual(ensureKitsBlock({ ...o, lines: [FLUTTER], dryRun: true }).did.length, 2);
  assert.ok(!fs.existsSync(path.join(home, '.profile')));
  ensureCommand({ home, shell: '/usr/bin/fish', platform: 'linux', node: '/x/node', script: '/x/hoprig.mjs' });
  ensureKitsBlock({ ...o, lines: [FLUTTER] });
  const fish = fs.readFileSync(path.join(home, '.config', 'fish', 'conf.d', 'hoprig.fish'), 'utf8');
  assert.match(fish, /contains -- \$HOME\/Workspace\/development\/flutter\/flutter\/bin \$PATH; or set -gx PATH \$HOME\/Workspace\/development\/flutter\/flutter\/bin \$PATH  # flutter/);
  assert.equal(count(fish, MARK), 1);
  assert.equal(count(fs.readFileSync(path.join(home, '.profile'), 'utf8'), MARK), 1);
});

test('a variable the owner sets in one start file is his in all of them: no other file gets a line that would set it over his', { skip: process.platform === 'win32' && 'the kits block is written into the start files of Linux and macOS shells only (Windows gets none)' }, (tc) => {
  const home = homeOf(tc);
  fs.writeFileSync(path.join(home, '.bashrc'), 'export ANDROID_HOME="$HOME/mysdk"\n');
  fs.writeFileSync(path.join(home, '.profile'), '. "$HOME/.bashrc"\n');
  const HOMELINE = { key: 'android-home', var: 'ANDROID_HOME', value: '$HOME/Workspace/development/sdk/android-sdk' };
  assert.deepEqual(ownValue('ANDROID_HOME', { home, shell: '/bin/bash', platform: 'linux' }), { file: path.join(home, '.bashrc'), value: path.join(home, 'mysdk') });
  assert.equal(kitsBlockHas(HOMELINE, { home, shell: '/bin/bash', platform: 'linux' }), true);
  const r = ensureKitsBlock({ home, shell: '/bin/bash', platform: 'linux', lines: [HOMELINE] });
  assert.deepEqual(r.did, []);
  assert.deepEqual(r.kept, ['~/.profile: no ANDROID_HOME line is written, because another of your start files sets it', '~/.bashrc sets ANDROID_HOME itself: your line is left as it is']);
  assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), '. "$HOME/.bashrc"\n');
  // A PATH folder is not a variable of his: only his own file counts for it, as before.
  assert.equal(ownValue('PATH', { home, shell: '/bin/bash', platform: 'linux' }), null);
});

test('a value: the home as $HOME; a path a shell would read otherwise is refused', () => {
  assert.equal(shellValue('/home/alex/Workspace/development/flutter/flutter/bin', '/home/alex'), '$HOME/Workspace/development/flutter/flutter/bin');
  assert.equal(shellValue('/opt/ws/development', '/home/alex'), '/opt/ws/development');
  assert.equal(shellValue('/home/alex/my $(x)', '/home/alex'), null);
  assert.equal(shellValue('/home/alex/a b', '/home/alex'), null);
});
