// The landing page's words against the product: one set of platform facts wherever the platforms are named, no
// offer of the demo command before the install, the Node.js floor, and the words other parts of the product use now
// (the main computer, End, the daily limit for paid use). Reads files only: no build, no demo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { frontMatter } = await import('../../site/lib/markdown.mjs');
const seo = await import('../../site/lib/seo.mjs');
const await_tia = await import('../../src/assistant/tia.mjs');
const await_floor = await import('../../src/nodefloor.mjs');
const raw = read('site/content/index.md');
const { data, body } = frontMatter(raw);
const flat = (s) => s.replace(/\s+/g, ' ');
const section = (q) => flat(body.slice(body.indexOf(`### ${q}`), body.indexOf('\n### ', body.indexOf(`### ${q}`) + 4) >>> 0));

test('the first screen and the site\'s platform sentence say the same short facts: it works on three systems, Windows is new', () => {
  assert.equal(data.under, seo.PLATFORMS, 'the line under the install is the site\'s one platform sentence');
  assert.match(seo.PLATFORMS, /^Works on Windows, macOS and Linux\. /);
  assert.match(seo.PLATFORMS, /Windows is new: a real home Windows PC has seen less of it than a Linux computer has\.$/);
  assert.doesNotMatch(seo.PLATFORMS, /not ready/);
  assert.ok(seo.PLATFORMS.length <= 160, `short on the first screen (${seo.PLATFORMS.length} characters)`);
});

test('every other place of the landing page that names the platforms says the same facts', () => {
  const card1 = flat(body.slice(body.indexOf('### 1. It sets up the computer'), body.indexOf('### 2.')));
  assert.match(card1, /It asks nothing on a first run and leaves alone what is already there\. Works on Windows, macOS and Linux\./);
  const win = section('Does it work on Windows?');
  assert.match(win, /Yes, and it is new\. The install line and the tests run on GitHub's Windows machines \(with Node\.js 24 and 26\), and the first run was walked on Windows four ways: a new PC with scripts off, scripts allowed, an administrator window, and Git missing\./);
  assert.match(win, /A real home Windows PC has seen less of Hoprig than a Linux computer has\./);
  assert.match(win, /on a Mac the newer parts \(the chat, the editor, the desktop, Work\) have not been tried by hand on a real Mac\./);
  // Words a newcomer cannot place: a version number, the setup's inner checks, the workspace's groups.
  for (const old of [/since 0\.2/, /checked read-only/, /the workspace's groups/, /the providers and Auto mode were run there/, /not ready/i]) assert.doesNotMatch(win, old);
  assert.match(section('How ready is it?'), /Its tests run on Linux, macOS and Windows with Node\.js 24 and 26 on every change \(the Windows jobs are still allowed to fail\)\./);
  assert.match(section('How ready is it?'), /The newer parts \(the chat, the editor, the desktop, Work\) were tried by hand on Linux and not on a real Mac/);
  assert.doesNotMatch(raw, /since 0\.2/, 'no version number a first-time visitor cannot place');
  assert.doesNotMatch(seo.NOT_DONE.join('\n'), /since 0\.2/, 'what search engines read says the same');
  assert.match(body, /^\| Sets up a fresh computer for coding \| Yes, on Windows, macOS and Linux \|/m);
  assert.match(body, /^\| Windows \| Yes, new \|/m);
  // The old words that said less, or the same facts another way.
  assert.doesNotMatch(raw, /macOS partly|the tests run, but installs|checked, not run yet|Run on Linux;|Windows is not ready|Windows \| Not yet/);
  // What search engines read: the Mac's newer parts among what is not done, and no Windows entry that says it is not ready.
  const NOT = seo.NOT_DONE.join('\n');
  assert.match(NOT, /^macOS: .*not tried by hand on a real Mac/m);
  assert.match(NOT, /^Windows is new: /m);
  assert.doesNotMatch(NOT, /Windows is not ready/);
  const mac = seo.NOT_DONE.find((x) => x.startsWith('macOS: '));
  assert.match(mac, /but the newer parts \(.*\) were not tried by hand on a real Mac;/);
  for (const old of [/was not tried/, /checked read-only/, /the workspace's groups/, /the setup's installs/]) assert.doesNotMatch(mac, old);
});

test('a term is said in plain words before the page leans on it: session, skills, GitHub\'s program, Auto mode, the public link', () => {
  const intro = flat(body.slice(0, body.indexOf('## What does Hoprig do?')));
  assert.match(intro, /moves a session \(one conversation with a coding tool\) to another provider/);
  const card1 = flat(body.slice(body.indexOf('### 1. It sets up the computer'), body.indexOf('### 2.')));
  assert.match(card1, /GitHub's own program and your sign-in to it, Claude Code, your projects, and the skills \(short instructions for the AI\) that fit them\./);
  assert.doesNotMatch(card1, /GitHub's command line/);
  const card3 = flat(body.slice(body.indexOf('### 3. A session goes on'), body.indexOf('## Who it is for')));
  // web/accounts.js: the Providers page, its choice "Carry on with the next provider … This is called Auto mode."
  assert.match(read('web/accounts.js'), /registerPage\(\{ id: 'providers', title: 'Providers'/);
  assert.match(read('web/accounts.js'), /This is called Auto mode\./);
  assert.match(card3, /Auto mode, a choice on the Providers page, can do it for you, in Claude Code\./);
  assert.match(section('Do I need a server?'), /with the public link \(a free Cloudflare address that Hoprig turns on with one switch\)\./);
});

test('the answer about the Operator and Tia says what her levels and her switches are before it uses their names', () => {
  const tia = section('What are the Operator and Tia?');
  // The levels as Settings → Tia names them (web/tia.js levelWords) and their short lines (src/assistant/tia.mjs).
  const ui = read('web/tia.js');
  for (const name of ['Ask me', 'Do the work', 'Hands off']) assert.ok(ui.includes(`['${name}', v.help.level`), name);
  const { HELP, DEFAULTS } = await_tia;
  assert.equal(DEFAULTS.level, 'work', 'Do the work is the level as installed');
  assert.match(HELP.levelShort.ask, /^She asks you before everything she types into a session\.$/);
  assert.match(HELP.levelShort.work, /^She does the job herself and asks you before anything risky\.$/);
  const levels = 'She has three levels, set in Settings → Tia: **Ask me** (she asks you before everything she types into a session), **Do the work** (as installed: she does the job herself and asks you before anything risky) and **Hands off** (she may also use the paid providers you allowed, within the daily limit below).';
  assert.ok(tia.includes(levels), 'the three levels said first');
  // The switches in Settings → Tia: the limit rule (src/operator/rules.mjs), Tia decides (web/operator-decide.js
  // DECIDE_WORDS), the look (web/operator-look.js LOOK_WORDS).
  assert.match(read('src/operator/rules.mjs'), /'When a session stops at a usage limit, continue it on the next provider of my order\.'/);
  assert.match(read('web/operator-decide.js'), /she asks a small model once to pick one of the steps prepared for it, or to leave it to you/);
  assert.match(read('web/operator-look.js'), /When a run fails for a reason nobody can explain, she starts one look into it: a session .* that can only read the project/);
  const switches = 'In **Settings → Tia** she has switches of her own, all off at first: rules such as the limit rule (a session at a usage limit goes on with the next provider of your order); **Tia decides** (for a new item that needs you, she asks a small model one short question and does the step it picks, or leaves it to you); and a look into what nobody can explain (a session that only reads the project, to find why a run failed).';
  assert.ok(tia.includes(switches), 'the switches said before their names are used');
  // Each name is explained before its first use in the answer.
  for (const [name, said] of [['**Ask me**', levels], ['**Hands off**', levels], ['**Tia decides**', switches], ['limit rule', switches], ['nobody can explain', switches]]) {
    assert.ok(tia.indexOf(name) >= tia.indexOf(said), `${name} is first used where it is explained`);
  }
});

test('the landing page has no row of screenshots: the story shows those screens, and the page never drew the row', () => {
  assert.doesNotMatch(raw, /^:::shots?$/m);
});

test('the story says what the demo\'s screens show today: one main button at a limit, the paid way marked, the first run as one card', async () => {
  const { SHOTS, STEPS } = await import('../../site/app/(site)/story-data.mjs');
  const alt = (n) => SHOTS.find((s) => s.name === n).alt;
  // web/lib.js limitBox: one way in front, the others under "Other ways"; costWords: " · costs money per use".
  assert.match(read('web/lib.js'), /'Other ways'/);
  assert.match(read('web/lib.js'), /costs money per use/);
  assert.match(alt('limit-reached'), /one button to go on with the same conversation on another plan, the other ways folded under it/);
  const limit = STEPS.find((s) => s.id === 'limit').text;
  assert.match(limit, /one tap continues the same conversation on another plan or account of yours/);
  assert.match(limit, /A way that costs money per use says so\./);
  // web/firstrun.js on Home: one card, "Welcome to Hoprig", its steps and the three ways to a first chat.
  assert.match(alt('first-run'), /one card, Welcome to Hoprig, with Signed in to Claude and Start your first chat, New project or My own folder/);
  assert.match(read('web/firstrun.js'), /Welcome to /);
  for (const s of SHOTS) assert.doesNotMatch(s.alt, /providers as buttons|each with its button/, s.name);
});

test('nothing offers the demo command to someone who has not installed: it exists only after the install', () => {
  assert.doesNotMatch(raw, /hoprig demo/, 'the landing page');
  assert.doesNotMatch(read('site/lib/seo.mjs'), /Just looking/);
});

test('the Node.js versions: the floor is 24.13.1, and the versions named are the ones the tests run on', () => {
  const { MIN_NODE_TEXT } = await_floor;
  const ready = section('How ready is it?');
  assert.ok(ready.includes(`Hoprig needs Node.js ${MIN_NODE_TEXT} or newer, and the install adds it.`), ready);
  const matrix = /os: \[ubuntu-latest, macos-latest\]\n\s+node: \[([\d, ]+)\]/.exec(read('.github/workflows/test.yml'))[1].split(/,\s*/);
  const named = /with Node\.js ([\d, and]+) on every change/.exec(ready)[1].split(/,\s*|\s+and\s+/);
  assert.deepEqual(named, matrix, 'the Node versions named are the blocking job\'s');
});

test('the words of today: the main computer (never "hub"), End (never "Close" for sessions), one name for the daily limit for paid use', () => {
  for (const [f, text] of [['site/content/index.md', raw], ['site/app/(site)/words.ts', read('site/app/(site)/words.ts')], ['site/app/(site)/story-data.mjs', read('site/app/(site)/story-data.mjs')], ['site/lib/seo.mjs', read('site/lib/seo.mjs')]]) {
    assert.doesNotMatch(text, /\bhub\b/i, `${f}: hub`);
    assert.doesNotMatch(text, /\bClose (them|\d+ sessions?)\b/, `${f}: Close for ending sessions`);
    assert.doesNotMatch(text, /spending cap|daily cap/i, `${f}: the old names of the limit`);
  }
  assert.match(section('Do I need a server?'), /always-on main computer/);
  const tia = section('What are the Operator and Tia?');
  assert.match(tia, /Within a daily limit for paid use you set in Settings → Tia \(none at first\)/);
  // Since she answers out of the box on a subscription, nothing may say she waits for a limit there.
  assert.match(tia, /On a subscription she simply answers; when every subscription is at its limit she says so with the time and does not move to a paid provider by herself\./);
});
