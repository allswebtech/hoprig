// The first day in the README's Install section and docs/INSTALL.md: after the install line, the sign-in to Claude and
// the checks are presses on the dashboard, named by the page's own words; a command is only the other way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
/** The part of a Markdown file from the heading `title` to the next heading of the same level or higher. */
const part = (file, title) => {
  const t = read(file);
  const m = new RegExp(`\\n(#{2,4}) ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).exec(t);
  assert.ok(m, `${file}: ${title}`);
  const rest = t.slice(m.index + m[0].length);
  const next = new RegExp(`\\n#{2,${m[1].length}} `).exec(rest);
  return t.slice(m.index, m.index + m[0].length + (next ? next.index : rest.length));
};

test('the page names the docs use are the page\'s own', () => {
  assert.match(read('src/setup/onboarding.mjs'), /\{ kind: 'claude-login', label: 'Sign in to Claude' \}/);
  assert.match(read('web/computers.js'), /registerPage\(\{ id: 'computers', title: 'Computers',/);
  assert.match(read('web/pc.js'), /\{ id: 'health', title: 'Health',/);
  assert.match(read('web/health.js'), /btn\('small primary', \{ label: 'Fix',/);
  assert.match(read('src/setup/checks.mjs'), /result\('login', 'Claude login',/);
  assert.match(read('web/claudelogin.js'), /btn\('small primary', \{ icon: 'user', label: 'Sign in',/);
});

test('README Install: what the line does in one sentence, and the checks on Health before hoprig doctor', () => {
  const install = flat(part('README.md', 'Install'));
  assert.match(install, /The line fetches Hoprig's installer from GitHub and runs it on your computer\./);
  assert.match(install, /Check a computer at any time on its \*\*Health\*\* tab \(\*\*Computers\*\* → the computer → \*\*Health\*\*\), where a problem that one press can fix has a \*\*Fix\*\* button \(or, in a terminal, `hoprig doctor`\)\./);
  assert.doesNotMatch(install, /Check a computer at any time with `hoprig doctor`/);
});

test('INSTALL: not signed in to Claude yet, the sign-in is Get started\'s press; the terminal is the other way', () => {
  const p = flat(part('docs/INSTALL.md', 'Not logged in to Claude yet?'));
  assert.match(p, /Setup says so in one line and carries on\. Sign in on the dashboard: \*\*Home → Get started → Sign in to Claude\*\* \(or \*\*Computers → this computer → Setup\*\*, the Claude login row's \*\*Sign in\*\*\) opens Claude's sign-in page in your browser\./);
  // After /login the person is still inside Claude Code: /exit brings the terminal back.
  assert.match(p, /In a terminal instead: run `claude`, type `\/login`, sign in in the browser, then type `\/exit`\./);
  assert.doesNotMatch(p, /then run `hoprig setup` again/);
});

test('the changelog says it under 0.3.4, in "Easier when you are not a programmer", as the code does it', () => {
  const log = read('site/content/changelog.md');
  const at = log.indexOf('\n## 0.3.4 ');
  const block = log.slice(at, log.indexOf('\n## ', at + 1));
  const easier = part('site/content/changelog.md', 'Easier when you are not a programmer');
  assert.ok(block.includes(easier), 'the section stands in the 0.3.4 block');
  const line = easier.split('\n').find((l) => l.startsWith('- **After the install line, a first day needs no terminal.**'));
  assert.ok(line, 'its own item');
  assert.ok(line.includes("Home's Get started → **Sign in to Claude** for the sign-in to Claude, and a computer's **Health** tab, with its **Fix** buttons, for the checks (`hoprig doctor` stays the other way)."));
  assert.ok(line.includes('names Providers → **Add provider** and Computers → this computer → **Health** before `hoprig add` and `hoprig doctor`'));
  assert.ok(line.includes('names Get started\'s **Sign in to Claude** and **Set up git and GitHub** before the commands'));
  assert.ok(line.includes('its Overview has **Install Claude Code** where it said to type a command in Setup'));
  assert.ok(line.includes("and Health's **Let them start after a restart** before the command that keeps the dashboard running after you log out."));
  // What it says is what the code does.
  assert.match(read('src/setup/setup.mjs'), /Add another provider: on the dashboard, Providers → Add provider/);
  assert.match(read('src/setup/ui.mjs'), /page: 'Home → Get started → Set up git and GitHub'/);
  assert.match(read('web/pc.js'), /label: 'Install Claude Code', onclick: \(\) => import\('\.\/getstarted\.js'\)/);
});

test('INSTALL Troubleshooting: Health first, the doctor in a terminal second; the login row names the press', () => {
  const raw = part('docs/INSTALL.md', 'Troubleshooting');
  assert.match(flat(raw), /Open \*\*Computers → this computer → Health\*\* on the dashboard: the same checks as `hoprig doctor`, with a \*\*Fix\*\* button where one press can fix a problem \(it shows what it runs and asks first\)\. In a terminal: ```sh hoprig doctor ```/);
  // The table rows keep the doctor's own two spaces, so they are read as written, not flattened.
  const p = raw;
  assert.ok(p.includes('| `✗ Claude login  not logged in` | **Home → Get started → Sign in to Claude** on the dashboard; in a terminal: `claude`, then type `/login` |'), p);
  assert.ok(!p.includes('| `✗ Claude login  not logged in` | `claude`, then type `/login` |'));
  // Lingering: Health's press first (web/health.js, the Gateways part), the command as the other way.
  assert.match(flat(raw), /On Linux, to keep the dashboard running while you are logged out: open \*\*Computers → this computer → Health\*\* and press \*\*Let them start after a restart\*\* \(it asks first; where sudo would ask for a password, the page shows the line to type\)\. In a terminal: `sudo loginctl enable-linger \$USER`\./);
  assert.match(read('web/health.js'), /label: 'Let them start after a restart'/);
});
