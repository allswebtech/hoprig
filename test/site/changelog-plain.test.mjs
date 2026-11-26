// "What changes when you update" in the changelog's unreleased block (site/content/changelog.md) is read by people who
// are not programmers: a word they cannot know is said in plain words where it first stands, a sentence that tells
// them to do something says where, and the two things called "Hands off" are told apart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = read('site/content/changelog.md').replace(/\r\n?/g, '\n');
// The unreleased block (from "## 0.3.6") and the released 0.3.5, 0.3.4 and 0.3.3 blocks after it: an entry is read
// where it stands now. A block without the section adds nothing.
const at = text.indexOf('\n## 0.3.6 ');
const mid0 = text.indexOf('\n## ', at + 1);
const mid = text.indexOf('\n## ', mid0 + 1);
const mid2 = text.indexOf('\n## ', mid + 1);
assert.ok(at >= 0 && text.startsWith('\n## 0.3.5 (25 November 2026)\n', mid0) && text.startsWith('\n## 0.3.4 (25 November 2026)\n', mid) && text.startsWith('\n## 0.3.3 (24 November 2026)\n', mid2), 'the unreleased block, then the released 0.3.5, 0.3.4 and 0.3.3');
const section = (b) => {
  const from = b.indexOf('### What changes when you update');
  return from < 0 ? '' : b.slice(from, b.indexOf('\n### ', from + 1));
};
const update = section(text.slice(at, mid0)) + section(text.slice(mid0, mid)) + section(text.slice(mid, mid2)) + section(text.slice(mid2, text.indexOf('\n## ', mid2 + 1)));

test('a word of the update section is said in plain words where it first stands', () => {
  const PLAIN = {
    '"Hands off"': 'the highest of her three levels, in Settings → Tia',
    profile: "(a profile is a provider's settings file)",
    root: "(the computer's administrator account)",
  };
  const missing = [];
  for (const [term, words] of Object.entries(PLAIN)) {
    const first = term.startsWith('"') ? update.indexOf(term) : update.search(new RegExp(`\\b${term}\\b`));
    const said = update.indexOf(words);
    if (first < 0) missing.push(`"${term}" is not in the section`);
    else if (said < first || said - first > 120) missing.push(`"${term}" first stands without "${words}" close after it`);
  }
  assert.deepEqual(missing, []);
  for (const old of ['long-term-support', 'restarts the service', 'with its branch followed', 'the command says so']) assert.ok(!update.includes(old), `"${old}" is said in plain words now`);
  assert.match(update, /the first release of Node\.js 22 that gets long-term fixes/);
  assert.match(update, /On an older Node\.js, `hoprig` says so in one line/);
  assert.match(update, /restarts the dashboard when they differ/);
  assert.match(update, /the AI brain kept on GitHub \(or another git server\) and linked to it/);
});

test('Tia\'s level "Hands off" is told apart from Hands-off, as the page names them', () => {
  // Her three levels (web/tia.js) and the Hands-off settings page (web/handsoffsettings.js).
  assert.match(read('web/tia.js'), /ask: \['Ask me'[^\]]*\], work: \['Do the work'[^\]]*\], handsoff: \['Hands off'/);
  assert.match(read('web/handsoffsettings.js'), /title: 'Hands-off'/);
  const line = update.split('\n').find((l) => l.includes('With her level at "Hands off"'));
  assert.ok(line, 'the first "Hands off" names it as her level');
  assert.match(line, /a different thing from Hands-off, Hoprig answering a coding tool's questions for you/);
});

test('the settings file of handsOff.offered is named with where it is', () => {
  // src/paths.mjs: the settings are config.json in ~/.config/hoprig unless a variable says otherwise.
  const paths = read('src/paths.mjs');
  assert.match(paths, /path\.join\(home\(\), '\.config', 'hoprig'\)/);
  assert.match(paths, /configFile = \(\) => path\.join\(configDir\(\), 'config\.json'\)/);
  assert.match(update, /set `handsOff\.offered` to `false` in Hoprig's settings file, `config\.json` in `~\/\.config\/hoprig`\./);
});
