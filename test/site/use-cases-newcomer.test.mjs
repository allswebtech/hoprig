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

test('the install line installs Node.js and Hoprig; Claude Code is set-up\'s own step, not the installer\'s', () => {
  const sh = read('install.sh');
  const setup = read('src/setup/setup.mjs');
  // install.sh never runs Claude Code's installer; set-up does, without a question.
  assert.doesNotMatch(sh, /claude\.ai\/install/);
  assert.doesNotMatch(sh, /Install now/, 'the installer asks nothing before it installs');
  assert.doesNotMatch(read('install.ps1'), /Install now|Confirm-Step/);
  assert.match(sh, /If your computer asks for its password, type it and press Enter/);
  assert.match(setup, /if \(!ui\.quiet\) ui\.line\('warn', 'Claude Code is not installed\.'\);/);
  // No question where Claude Code is on in Coding tools and someone is there or said --yes; asked (and skipped with no terminal) elsewhere.
  assert.match(setup, /includes\('claude'\) && \(ui\.interactive \|\| ui\.yes\)\) && !\(await ui\.confirm\('Install it now\?', true\)\)/);
  const page = flat(read(PAGE));
  assert.doesNotMatch(page, /asks you once|after asking you once: Node\.js \(the program that Hoprig and Claude Code run on\) and Claude Code itself/);
  assert.match(page, /It lists what is missing and installs it, without asking: Node\.js \(the program that Hoprig and Claude Code run on\), and on Linux a few system programs, for which the computer may ask for your password\. Then it installs Hoprig\./);
  assert.match(page, /When Claude Code is missing, it installs it for you\./);
});

test('not signed in to Claude: set-up says so and goes on, and the sign-in is Get started\'s press', () => {
  // The press the guide names is the one Home's Get started shows (its label comes from the server).
  assert.match(read('src/setup/onboarding.mjs'), /\{ kind: 'claude-login', label: 'Sign in to Claude' \}/);
  assert.match(read('src/setup/setup.mjs'), /No Claude account logged in: sign in on the dashboard, Home → Get started → Sign in to Claude/);
  assert.match(flat(read(PAGE)), /4\. If you are not signed in to Claude yet, it says so in one line and goes on: you sign in later on the dashboard, where Home's Get started list has \*\*Sign in to Claude\*\* \(it opens Claude's sign-in page in your browser\)\./);
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

test('the checks: the guide names the Health page and its Fix, the command only as the other way', () => {
  // The page's own names: Computers in the menu, a computer's Setup tab, a check's Fix button.
  assert.match(read('web/computers.js'), /registerPage\(\{ id: 'computers', title: 'Computers',/);
  assert.match(read('web/pc.js'), /\{ id: 'setup', title: 'Setup',/);
  assert.match(read('web/health.js'), /btn\('small primary', \{ label: 'Fix',/);
  assert.match(flat(read(PAGE)), /At any time, open \*\*Computers\*\*, then this computer, then its \*\*Setup\*\* tab: it checks everything, and under a problem that one press can fix there is a \*\*Fix\*\* button, which asks before it changes anything\. \(Or, in a terminal, `hoprig doctor` shows the same checks\.\)/);
});

test('after the install line the guide sends no one to a terminal: no sign-in or check is a command to type', () => {
  const page = flat(read(PAGE));
  for (const typed of [/type `claude`/, /`\/login`/, /`\/exit`/, /run `hoprig setup` again/, /type `hoprig doctor`/, /the one command that fixes it/]) assert.doesNotMatch(page, typed);
  // Every command the guide shows outside the install line is "the other way", after "Or, in a terminal,".
  const steps = page.replace(/```sh[^`]*```/, '');
  for (const m of steps.matchAll(/`hoprig [^`]*`/g)) {
    const before = steps.slice(Math.max(0, m.index - 80), m.index);
    assert.ok(m[0] === '`hoprig setup`' || /Or, in a terminal, $/.test(before), `${m[0]} is a step of its own: ${before}${m[0]}`);
  }
  // Step 1 says in one sentence what the line does, and the one terminal moment the page admits is that line.
  assert.match(page, /The line fetches Hoprig's installer from GitHub and runs it on your computer\./);
  assert.match(page, /You still need the terminal once, to paste the install line\./);
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
