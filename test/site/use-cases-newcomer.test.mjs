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
  assert.match(page, /It lists what is missing and installs it, without asking: Node\.js \(the program that Hoprig and Claude Code run on\), Git on Windows when it is missing, and on Linux a few system programs, for which the computer may ask for your password\. Then it installs Hoprig\./);
  assert.match(page, /When Claude Code is missing, it installs it for you\./);
});

test('not signed in to Claude: set-up says so and goes on, and the sign-in is Get started\'s press', () => {
  // The press the guide names is the one Home's Get started shows (its label comes from the server).
  assert.match(read('src/setup/onboarding.mjs'), /\{ kind: 'claude-login', label: 'Sign in to Claude' \}/);
  assert.match(read('src/setup/setup.mjs'), /No Claude account logged in: sign in on the dashboard, Home → Get started → Sign in to Claude/);
  assert.match(flat(read(PAGE)), /4\. Home says the next step\. If you are not signed in to Claude yet, it is \*\*Sign in to Claude\*\* \(it opens Claude's sign-in page in your browser\);/);
  assert.match(read('web/firstrun.js'), /signIn: 'Sign in to Claude'/);
  assert.match(read('web/firstrun.js'), /paid: 'No Claude plan\? Pay as you use'/);
});

test('step 1 points at the install lines, which stand below the steps, one for each system', () => {
  const page = read(PAGE);
  assert.match(flat(page), /paste the line below for your system, then press Enter\./);
  assert.ok(page.indexOf('```powershell\nirm ') > page.indexOf('\n6. '), 'the Windows line stands after the six steps');
  assert.ok(page.indexOf('```sh\ncurl ') > page.indexOf('```powershell'), 'then the Mac line');
  assert.ok(page.indexOf('```sh\nwget ') > page.indexOf('```sh\ncurl '), 'then the Linux line');
});

test('the first run ends with the browser open and signed in, and the phone is for later', () => {
  const first = read('src/setup/firstrun.mjs');
  assert.match(first, /ends by opening the browser signed in/);
  assert.match(read('install.ps1'), /A Start menu entry Hoprig, which opens it again signed in\./);
  const page = flat(read(PAGE));
  assert.match(page, /3\. At the end your browser opens on Hoprig, already signed in: there is no password to find\. On Windows the Start menu entry Hoprig opens it again\./);
  assert.match(page, /6\. You do not need your phone at first\. To use Hoprig from your phone, turn that on later in Settings\./);
});

test('the checks: the guide names the Health page and its Fix, the command only as the other way', () => {
  // The page's own names: Computers in the menu, a computer's Health tab, a check's Fix button.
  assert.match(read('web/computers.js'), /registerPage\(\{ id: 'computers', title: 'Computers',/);
  assert.match(read('web/pc.js'), /\{ id: 'health', title: 'Health',/);
  assert.match(read('web/health.js'), /btn\('small primary', \{ label: 'Fix',/);
  assert.match(flat(read(PAGE)), /At any time, open \*\*Computers\*\*, then this computer, then its \*\*Health\*\* tab: it checks everything, and under a problem that one press can fix there is a \*\*Fix\*\* button, which asks before it changes anything\. \(Or, in a terminal, `hoprig doctor` shows the same checks\.\)/);
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

test('a first run asks nothing, as the page says', () => {
  const first = read('src/setup/firstrun.mjs');
  assert.match(first, /A first run is `hoprig setup` on a computer with no settings file yet and nothing chosen by hand\. It asks nothing,/);
  assert.match(first, /keeps the dashboard to this computer/);
  const page = flat(read(PAGE));
  assert.match(page, /It asks nothing on a first run, and only this computer can open the dashboard\./);
  assert.doesNotMatch(page, /who may open the dashboard \(pressing Enter/);
});
