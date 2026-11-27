// What the compare pages and the skill page say about Hoprig, held to the code: the Node.js floor, the name of the
// computer the others report to, and the platform facts. When the code changes, the sentence has to change with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

test('the skill page names the Node.js floor of the skill package', () => {
  const floor = JSON.parse(read('packages/hoprig-skill/package.json')).engines.node.replace(/^>=\s*/, '');
  assert.equal(floor, '24.13.1');
  const page = flat(read('site/content/skill.md'));
  assert.match(page, /with Node\.js 24\.13\.1 or newer/);
  assert.doesNotMatch(page, /Node\.js 22 or newer/);
});

test('the skill page offers only options the skill package knows', () => {
  const bin = read('packages/hoprig-skill/bin/hoprig-skill.mjs');
  const page = read('site/content/skill.md');
  for (const o of new Set(page.match(/--[a-z][a-z-]+/g))) {
    if (o === '--user') continue; // "hop skills add hoprig --user" is Hoprig's own command, checked below
    assert.ok(bin.includes(`'${o}'`), `hoprig-skill knows ${o}`);
  }
  assert.match(read('src/skillhub/cli.mjs'), /\[--project <dir> \| --user\]/);
});

test('the compare pages call the computer the others report to the main computer, never a hub', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'site/content/compare'))) {
    const page = read(`site/content/compare/${f}`).replace(/\]\([^)]*\)/g, ']'); // an address keeps its path
    assert.doesNotMatch(page, /\bhubs?\b/i, `${f} says "hub"`);
  }
});

test('the tmux page says the server rule of the code: the SSH and cloud signs count on Linux only', () => {
  const page = flat(read('site/content/compare/tmux-ssh-vpn.md'));
  assert.ok(page.includes('On a server (a computer with a public address, or, on Linux, also one you reach over SSH with no desktop or one in a cloud), "devices on my network" is not offered.'), 'the rule');
  assert.ok(!page.includes('a public address, one you reach over SSH with no desktop, or one in a cloud'), 'the old rule for every system is gone');
  const server = read('src/setup/server.mjs');
  assert.ok(server.includes("export function sshWithoutDesktop(env = {}, platform = process.platform, display = false) {\n  if (platform !== 'linux') return false;"), 'SSH without a desktop: Linux only');
  assert.ok(server.includes("if (ips.length) return with_({ kind: 'public', address: ips[0] });") && server.includes("if (platform === 'linux') {\n    const name = cloudOf("), 'a public address on every system, the cloud on Linux only');
  assert.match(flat(read('docs/INSTALL.md')), /A Mac or a Windows computer counts as a server only by its public address\./);
});

test('the compare overview says the platform facts: three systems, Windows new, the Mac\'s newer parts not tried by hand', () => {
  const page = flat(read('site/content/compare/index.md'));
  assert.match(page, /It runs on Windows, macOS and Linux\. Windows is new: a real home Windows PC has seen less of it than a Linux computer has, and the newer parts \(the chat, the editor, Work\) were not tried by hand on a real Mac\./);
  assert.doesNotMatch(page, /since 0\.2/, 'a version number a newcomer cannot place');
  assert.doesNotMatch(page, /not ready/);
});
