// Sentences of the changelog's unreleased block (site/content/changelog.md, from "## 0.3.6") and of the released
// 0.3.5, 0.3.4 and 0.3.3 blocks after it (to the next "## "; each entry is read where it stands now) that
// list what the code decides, read against that code: which kinds of command stay your card (the wall's kinds,
// src/wall.mjs WALL_TITLE), in a session of Tia's at Full too (src/hook.mjs herHeld).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WALL_TITLE } from '../../src/wall.mjs';
import { herHeld } from '../../src/hook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const text = fs.readFileSync(path.join(ROOT, 'site/content/changelog.md'), 'utf8').replace(/\r\n?/g, '\n');
const at = text.indexOf('\n## 0.3.6 ');
const mid0 = text.indexOf('\n## ', at + 1);
const mid = text.indexOf('\n## ', mid0 + 1);
const mid2 = text.indexOf('\n## ', mid + 1);
assert.ok(at >= 0 && text.startsWith('\n## 0.3.5 (25 November 2026)\n', mid0) && text.startsWith('\n## 0.3.4 (25 November 2026)\n', mid) && text.startsWith('\n## 0.3.3 (24 November 2026)\n', mid2), 'the unreleased block, then the released 0.3.5, 0.3.4 and 0.3.3');
const block = text.slice(at, text.indexOf('\n## ', mid2 + 1));
/** The whole line of the entry whose bold lead-in is `lead`. */
const entry = (lead) => {
  const line = block.split('\n').find((l) => l.startsWith(`- **${lead}**`));
  assert.ok(line, `the entry "${lead}" stands`);
  return line;
};

/** Each kind of the wall, in the plain words the block says it with. */
const SAID = {
  admin: 'administrator rights',
  release: 'a release or publishing',
  'api-write': 'a direct call to GitHub or GitLab that can change something there',
  pr: 'a pull request',
  push: 'a push to the main branch or a tag',
  'push-prune': 'a push that deletes branches',
  'push-elsewhere': 'a push or a merge Hoprig cannot place or check',
  'push-nodefault': 'a push or a merge Hoprig cannot place or check',
  merge: 'a merge into the main branch',
  'merge-elsewhere': 'a push or a merge Hoprig cannot place or check',
  'delete outside': "a delete outside the session's folder",
  deploy: 'a deploy',
  project: 'a change to project.json',
  settings: "Hoprig's own files",
  unreadable: 'a command Hoprig cannot read',
};

test('every kind the wall holds has its words here, so a new kind is said in the block', () => {
  assert.deepEqual(Object.keys(WALL_TITLE).sort(), Object.keys(SAID).sort());
});

test('Hands-off: "What stays yours in every case" names every kind the wall holds', () => {
  const line = entry('What stays yours in every case.');
  const missing = Object.entries(SAID).filter(([, w]) => !line.includes(w)).map(([k, w]) => `${k}: "${w}"`);
  assert.deepEqual(missing, []);
  assert.doesNotMatch(line, /a merge,|the project's own settings/, 'a merge only into the main branch; the kind is project.json');
});

test('a session Tia started: what stays your card at Full is every kind but administrator rights, and an administrator command Hoprig cannot read', () => {
  // The code first: at Full her plain administrator act is lifted, one Hoprig cannot read is not, the rest stay.
  const cfg = { server: { herRights: { level: 'full', version: '9.9.9' } } };
  const at = (held) => herHeld(held, null, { cfg, version: '9.9.9' });
  assert.equal(at({ kind: 'admin' }), null);
  assert.ok(at({ kind: 'admin', unsure: true }));
  for (const kind of Object.keys(SAID).filter((k) => k !== 'admin')) assert.ok(at({ kind }), kind);
  // Then the block: the sentence that says what stays at Full names each of them.
  const line = entry('A session Tia started asks you before an act that is yours alone.');
  const full = line.split(/(?<=\.) /).find((s) => s.includes('stay your card at Full too'));
  assert.ok(full, 'the sentence that says what stays your card at Full');
  const want = [...new Set(Object.entries(SAID).filter(([k]) => k !== 'admin').map(([, w]) => w)), 'a command Hoprig cannot read (an administrator command too)'];
  assert.deepEqual(want.filter((w) => !full.includes(w)), []);
});

test('her administrator rights: an update keeps Off and Ask each time, and turns only Full into Ask each time', async () => {
  const { herRightsLevel } = await import('../../src/assistant/herrights.mjs');
  const set = (level) => ({ server: { herRights: { level, version: '1.0.0' } } });
  assert.equal(herRightsLevel(set('off'), '1.0.1'), 'off');
  assert.equal(herRightsLevel(set('ask'), '1.0.1'), 'ask');
  assert.equal(herRightsLevel(set('full'), '1.0.1'), 'ask');
  assert.equal(herRightsLevel({}, '1.0.1'), 'off', 'as installed');
  const line = entry('Administrator rights for Tia, in three levels.');
  assert.doesNotMatch(line, /\*\*Off\*\* \(as installed, and after an update\)/, 'an update does not set Off');
  assert.match(line, /\*\*Off\*\* \(as installed; an update keeps Off or Ask each time as it was\)/);
  assert.match(line, /an update of Hoprig sets Full back to Ask each time/);
});

test('her git sign-in: only gh and git over https to github.com use her token, so ssh keeps your own sign-in', async () => {
  const { herGitEnv, GIT_HOST } = await import('../../src/assistant/hersignin.mjs');
  const env = herGitEnv('made-up-token', { base: {} });
  const keys = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => env[k]);
  assert.ok(keys.length > 0);
  for (const k of keys) assert.ok(k.startsWith(`credential.https://${GIT_HOST}.`), k);
  assert.equal(env.GH_TOKEN, 'made-up-token');
  const line = entry('A git sign-in of her own for her sessions.');
  assert.doesNotMatch(line, /signs in to the git server with that token in place of yours;/, 'not over ssh');
  assert.match(line, /through `gh` and git over https/);
  assert.match(line, /reached over ssh, `git@github\.com:…`, keeps your own ssh sign-in/);
});

test('what still needs a terminal on a server: not the skills and not a restart, as docs/COMPUTERS.md says', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const line = entry('What still needs a terminal on the server:');
  assert.doesNotMatch(line, /the skills, a restart of the system when one is pending/, 'the old list is gone');
  assert.ok(line.includes("Claude Code's install and its sign-in, adding its providers (a subscription's sign-in or an API key), and a `sudo` password wherever one is asked. A suggested skill is added on that computer's **Skills** page, and a restart is on its page under **Advanced → Power → Restart** where the system lets your user restart it without a password."), 'the new list');
  assert.ok(read('web/app.js').includes("export const CODING_PAGES = ['workspace', 'providers', 'brain', 'skills',"), 'Skills is a page of each computer');
  assert.ok(!read('src/machines/index.mjs').includes('skillhub'), 'the main computer may reach another computer\'s skills');
  const pc = read('web/pc.js');
  assert.ok(pc.includes("section('Power', undefined,") && pc.includes("powerBtn('reboot', 'Restart')") && !/name \? section\('Power'/.test(pc), 'Advanced → Power → Restart on every computer');
  assert.ok(read('web/skillhub.js').includes("registerPage({ id: 'skills', title: 'Skills',"), 'the page is called Skills');
  assert.ok(pc.includes("{ id: 'advanced', title: 'Advanced',"), 'the tab is called Advanced');
  assert.ok(read('src/machines/index.mjs').includes('/^\\/api\\/accounts(\\/|$)/'), 'the providers of another computer stay its own');
});
