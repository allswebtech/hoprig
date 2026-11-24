// The use case "not a developer", held to the installer and set-up it walks through: which program installs what,
// and what set-up asks. When install.sh or src/setup/setup.mjs changes, the page's steps have to change with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const PAGE = 'site/content/use-cases/not-a-developer.md';

test('the install line installs Node.js and Hoprig; Claude Code is set-up\'s question, not the installer\'s', () => {
  const sh = read('install.sh');
  const setup = read('src/setup/setup.mjs');
  // install.sh never runs Claude Code's installer; set-up does, after its own question.
  assert.doesNotMatch(sh, /claude\.ai\/install/);
  assert.match(sh, /Install now\? \[Y\/n\]/);
  assert.match(sh, /sudo may ask for your computer password\./);
  assert.match(setup, /ui\.line\('warn', 'Claude Code is not installed\.'\);\n\s*if \(!\(await ui\.confirm\('Install it now\?', true\)\)\)/);
  const page = flat(read(PAGE));
  assert.doesNotMatch(page, /after asking you once: Node\.js \(the program that Hoprig and Claude Code run on\) and Claude Code itself/);
  assert.match(page, /It lists what is missing and asks you once: Node\.js \(the program that Hoprig and Claude Code run on\), and on Linux a few system programs, for which the computer may ask for your password\. Then it installs Hoprig\./);
  assert.match(page, /When Claude Code is missing, it asks whether to install it now\./);
});

test('not signed in to Claude: set-up says to sign in and run it again', () => {
  assert.match(read('src/setup/setup.mjs'), /run "claude" once, type \/login, then run setup again\./);
  // After /login the person is still inside Claude Code: `hoprig setup` typed there is a message to the AI.
  assert.match(flat(read(PAGE)), /In the terminal, type `claude` and press Enter, type `\/login` and sign in in the browser, then type `\/exit` to come back to the terminal and run `hoprig setup` again\./);
});

test('step 1 points at the install line, which stands below the steps', () => {
  const page = read(PAGE);
  assert.match(flat(page), /paste the line below \(the one that starts with `curl`\), then press Enter\./);
  assert.ok(page.indexOf('```sh\ncurl ') > page.indexOf('\n6. '), 'the install line stands after the six steps');
});

test('the phone signs in through the QR code; the password is in the file set-up names under it', () => {
  const setup = read('src/setup/setup.mjs');
  assert.match(setup, /Scan with your phone's camera\$\{link \? ' to sign in \(the link works once, for 15 minutes\)' : ''\}/);
  assert.match(setup, /if \(pw\) ui\.out\(`  Password, if asked: in \$\{tilde\(pw\)\}`\);/);
  assert.match(setup, /not encrypted, so not for a shared or public Wi-Fi/);
  const page = flat(read(PAGE));
  assert.doesNotMatch(page, /over plain http/);
  assert.match(page, /the QR code at the end signs your phone in, and the dashboard's password, if it is ever asked, is in the file named under the QR code;/);
});

test('hoprig doctor: the page says where to type it', () => {
  assert.match(flat(read(PAGE)), /At any time, type `hoprig doctor` in the terminal: it checks everything/);
});

test('the questions the page names are the ones set-up asks', () => {
  const setup = read('src/setup/setup.mjs');
  const first = read('src/setup/firstrun.mjs');
  const git = read('src/workspace/gitstep.mjs');
  assert.match(setup, /ui\.choose\('Who should be able to open the dashboard\?'/);
  assert.match(setup, /\['local', 'only this computer'\]/, 'choice 1 keeps it on this computer');
  assert.match(git, /Sign in to GitHub now\?/);
  assert.match(first, /A project to work on: .*\(Enter to skip\)/);
  const page = flat(read(PAGE));
  assert.match(page, /who may open the dashboard \(pressing Enter lets your phone on the same Wi-Fi open it;/);
  assert.match(page, /choose 1 to keep it on this computer only\), whether to sign in to GitHub, and the name of a first project\. Each one can be skipped and done later\./);
});
