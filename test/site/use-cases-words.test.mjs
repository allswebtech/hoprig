// Words every use case says the same way: the computer the others report to is the main computer (the option
// `--hub` keeps its name), and Tia's limit is the daily limit for paid use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'site/content/use-cases');
const pages = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\s+/g, ' ')]);

test('no use case calls the main computer a hub (the option --hub keeps its name)', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'src/setup/setup.mjs'), 'utf8'), /make it the main computer/);
  for (const [f, s] of pages) assert.doesNotMatch(s.replace(/--hub\b/g, ''), /\bhubs?\b/i, f);
  const team = pages.find(([f]) => f === 'team-machines.md')[1];
  assert.match(team, /One machine is the main computer; the others join it \(`hoprig join`\)/);
});

test('the Mac line names the newer parts a real Mac has not run, never a version number a newcomer cannot place', () => {
  for (const [f, s] of pages) assert.doesNotMatch(s, /what is new (in|since) 0\.2\b/, f);
  assert.match(pages.find(([n]) => n === 'not-a-developer.md')[1], /On a Mac, the newer parts \(the chat, the editor, the desktop\) have not been tried by hand on a real Mac;/);
  for (const f of ['code-from-your-phone.md', 'api-key-or-gateway.md']) assert.match(pages.find(([n]) => n === f)[1], /A computer with Windows, macOS or Linux that stays on while you work/, f);
});

test('no use case says the Mac installs were checked read-only: the installs ran on GitHub\'s Mac machines', () => {
  // A newcomer cannot place "checked read-only".
  for (const [f, s] of pages) assert.doesNotMatch(s, /checked read-only/, f);
  const computer = pages.find(([f]) => f === 'new-computer.md')[1];
  assert.match(computer, /These installs were run on clean Ubuntu, Debian, Fedora and Alpine, and on GitHub's Windows and Mac machines\./);
});

test('the Providers picture is described as the README describes it: what the picture shows', () => {
  const alt = 'The Providers page: a line that says 4 can work, 2 are at a limit and 3 need a sign-in, Refresh, the providers in groups with one button each, and the panel When an account reaches its limit';
  assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes(`<img src="docs/screenshots/accounts-desktop-light.webp" alt="${alt}"`), 'the README\'s alt text');
  const page = pages.find(([f]) => f === 'api-key-or-gateway.md')[1];
  assert.ok(page.includes(`![${alt}](/screenshots/accounts-desktop-light.webp)`), 'the use case says the same');
  assert.ok(!page.includes('each subscription and API key with its usage and limits'), 'the old words are gone');
});

test('the server page: the skills and a restart are on the dashboard, as docs/COMPUTERS.md says', () => {
  const page = pages.find(([f]) => f === 'server-from-the-dashboard.md')[1];
  assert.ok(!page.includes('`hoprig setup`, adding skills)'), 'the skills are not said to need a terminal');
  assert.ok(page.includes('A suggested skill is added on that computer\'s **Skills** page, and a restart is on its page under **Advanced → Power → Restart** where the system lets your user restart it without a password.'), 'skills and restart');
  // The Skills page is a page of each computer, reachable from the main computer; Power → Restart on every computer's page.
  assert.ok(fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8').includes("export const CODING_PAGES = ['workspace', 'providers', 'brain', 'skills',"));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'src/machines/index.mjs'), 'utf8').includes('skillhub'), 'the skills of another computer are not forbidden');
  const pc = fs.readFileSync(path.join(ROOT, 'web/pc.js'), 'utf8');
  assert.ok(pc.includes("section('Power', undefined,") && pc.includes("powerBtn('reboot', 'Restart')") && !/name \? section\('Power'/.test(pc));
  // The two bold labels are the page's and the tab's titles, letter for letter.
  assert.ok(fs.readFileSync(path.join(ROOT, 'web/skillhub.js'), 'utf8').includes("registerPage({ id: 'skills', title: 'Skills',"), 'the page is called Skills');
  assert.ok(pc.includes("{ id: 'advanced', title: 'Advanced',"), 'the tab is called Advanced');
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/COMPUTERS.md'), 'utf8').replace(/\s+/g, ' '), /A restart of the server is on its page, under \*\*Advanced → Power → Restart\*\*, where the system lets your user restart it without that password/);
});

test('no use case names Tia\'s limit a spending cap', () => {
  // The Operator's button says the one name too (web/operator.js), and the page quotes it as the code has it.
  assert.match(fs.readFileSync(path.join(ROOT, 'web/operator.js'), 'utf8'), /'Set a daily limit for paid use'/);
  for (const [f, s] of pages) assert.doesNotMatch(s, /spending cap|daily cap\b/i, f);
});
