// The home part of the whole-computer check (leavehome.mjs), in a temporary home holding one thing of each kind: each
// is named with its size and what to do; what is safe (a memory link into a repository, a key copied into the
// credentials folder, a cache, shell history, a newer dump, test data) is not. A private folder inside a dot-folder is
// never entered (its size would show), a link is never followed, a small budget ends in "not measured further", a
// private key's content and hash are in no return value, and the home is the same before and after.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, writeTree } from './helpers.mjs';

const h = tempHome('leavehome');
test.after(() => h.cleanup());
const { homeLook, MIN_SIZE } = await import('../../src/workspace/leavehome.mjs');
const { projectSlug } = await import('../../src/sessions.mjs');

const MB = 1024 * 1024;
const MARKER = 'leavehome-marker-k3y-7f2a9c';
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARKER}\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ\n-----END OPENSSH PRIVATE KEY-----\n`;
const KEY2 = `-----BEGIN OPENSSH PRIVATE KEY-----\nsecond-key-copied-${MARKER.length}\n-----END OPENSSH PRIVATE KEY-----\n`;
const ws = h.ws;
const at = (rel) => path.join(h.home, rel);
// A file of `size` bytes that takes no room (the walk reads sizes, never contents).
const sparse = (p, size) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  fs.truncateSync(p, size);
};
const noMarks = { keep: [], ignore: [], outside: [], testData: [], label: null };
const now = Date.now();

// ---- the home ----
writeTree(h.home, {
  '.ssh/id_ed25519': KEY, // a private key with a .pub, no copy anywhere
  '.ssh/id_ed25519.pub': 'ssh-ed25519 AAAA test@example\n',
  '.ssh/deploy_key': KEY2, // no .pub, but a private key's first line; copied into the credentials folder
  '.ssh/known_hosts': 'git.example.test ssh-ed25519 AAAA\n',
  '.ssh/notes.txt': 'not a key\n',
  '.android/debug.keystore': 'keystore-bytes-made-up\n',
  '.claude/projects/-x-shop/memory/MEMORY.md': '- a memory\n', // a real memory folder
  '.claude/CLAUDE.md': '# my rules\n', // a rules file, not linked to the brain
  '.claude/skills/mine/SKILL.md': '# a skill\n',
  '.toolp/small.txt': 'a little\n',
  '.toolq/small.txt': 'a little\n',
});
writeTree(ws, { 'credentials/cred-file-name-zq1': '', 'credentials/ssh/kept-copy-name-zq2': KEY2, 'projects/web/ai_brain/claude-memory/MEMORY.md': '- in git\n' });
execFileSync('git', ['init', '-q', path.join(ws, 'projects', 'web')]);
// A memory link into a repository: safe, not named.
fs.mkdirSync(at('.claude/projects/-x-web'), { recursive: true });
fs.symlinkSync(path.join(ws, 'projects', 'web', 'ai_brain', 'claude-memory'), at('.claude/projects/-x-web/memory'));
sparse(at('.toolx/data.db'), 2 * MB); // a program's own data
sparse(at('.cache/big.bin'), 50 * MB); // a cache
sparse(at('.bash_history'), 2 * MB); // shell history
sparse(at('.config/toolc/state.db'), 3 * MB); // one level down in .config
// Private folders inside a dot-folder: never entered, so their size never counts.
sparse(at('.toolp/no-ai/private-name-q7.txt'), 5 * MB);
sparse(at('.toolp/sub/NO-AI/private-name-r8.txt'), 5 * MB);
// Links out of the home: never followed.
sparse(path.join(h.root, 'outside', 'big.bin'), 5 * MB);
fs.symlinkSync(path.join(h.root, 'outside'), at('.toolq/out'));
fs.symlinkSync(path.join(h.root, 'outside'), at('.toolp/Ignore'));
fs.symlinkSync(path.join(h.root, 'outside'), at('.linkdot'));
for (let i = 0; i < 100; i++) writeTree(h.home, { [`.toolm/f${i}`]: 'x' });
// Hoprig's own settings (its folder is outside this home in the test: named by its path).
writeTree(process.env.HOPRIG_CONFIG_DIR, { 'config.json': '{}\n' });
// The workspace's dumps: postgresql's is older than its data, mysql's newer.
writeTree(ws, { 'database/postgresql/old.sql': '-- dump\n', 'database/mysql/new.sql': '-- dump\n' });
fs.utimesSync(path.join(ws, 'database', 'postgresql', 'old.sql'), new Date(now - 86400e3), new Date(now - 86400e3));
const facts = {
  databases: [
    { engine: 'postgresql', dataDir: path.join(h.root, 'pg'), running: true, newestChange: new Date(now - 3600e3).toISOString() },
    { engine: 'mysql', dataDir: path.join(h.root, 'my'), running: true, newestChange: new Date(now - 2 * 86400e3).toISOString() },
    { engine: 'mariadb', dataDir: path.join(h.root, 'maria'), running: true, newestChange: new Date(now).toISOString() },
  ],
};

/** Every entry under `d` with its kind, size, time and link target: what a look must leave as it was. */
function listing(d) {
  const out = [];
  const walk = (p) => {
    for (const n of fs.readdirSync(p).sort()) {
      const f = path.join(p, n);
      const st = fs.lstatSync(f);
      out.push([path.relative(d, f), st.isSymbolicLink() ? `link:${fs.readlinkSync(f)}` : st.isDirectory() ? 'dir' : 'file', st.size, st.mtimeMs, st.mode]);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(f);
    }
  };
  walk(d);
  return out;
}

let before;
let r;
test('one look of the home', async () => {
  before = listing(h.root);
  r = await homeLook({ home: h.home, dir: ws, marks: { ...noMarks, testData: ['mariadb'] }, facts });
  assert.ok(Array.isArray(r.items) && Array.isArray(r.asks) && Array.isArray(r.outside) && Array.isArray(r.notChecked));
});

const one = (kind, where) => r.items.find((i) => i.kind === kind && i.where === where);
const shaped = (i) => {
  assert.equal(i.id, `${i.kind}:${i.where}`);
  for (const k of ['what', 'todo']) assert.ok(typeof i[k] === 'string' && i[k].length > 10, `${i.id} ${k}`);
  assert.equal(typeof i.command, 'string');
  assert.equal(i.pushable, false);
};

test('a real memory folder is named with its size and what to do; a memory link into a repository is not', () => {
  const m = one('memory', '~/.claude/projects/-x-shop/memory');
  assert.ok(m, JSON.stringify(r.items));
  shaped(m);
  assert.equal(m.size, '- a memory\n'.length);
  assert.match(m.todo, /hoprig project link/);
  assert.equal(r.items.filter((i) => i.kind === 'memory').length, 1, 'the link into web/ is safe');
  assert.ok(!JSON.stringify(r).includes('-x-web'));
});

test('a rules file and a skills folder not linked to the brain are named, with the command that links them', () => {
  const rules = r.items.filter((i) => i.kind === 'rules').map((i) => i.where).sort();
  assert.deepEqual(rules, ['~/.claude/CLAUDE.md', '~/.claude/skills']);
  for (const i of r.items.filter((x) => x.kind === 'rules')) {
    shaped(i);
    assert.equal(i.command, 'hoprig workspace link');
    assert.ok(i.size > 0);
  }
});

test('a private key with no copy is named; the same key copied into the credentials folder is not; the keystore is', () => {
  const k = one('key', '~/.ssh/id_ed25519');
  assert.ok(k);
  shaped(k);
  assert.equal(k.size, Buffer.byteLength(KEY));
  assert.deepEqual(r.items.filter((i) => i.kind === 'key').map((i) => i.where), ['~/.ssh/id_ed25519'], 'deploy_key has a copy; known_hosts, .pub and notes are no keys');
  const ks = one('keystore', '~/.android/debug.keystore');
  assert.ok(ks);
  shaped(ks);
});

test('the credentials folder in no git is named with its size and the command; its files are never named', () => {
  const c = one('credentials', '~/Workspace/credentials');
  assert.ok(c);
  shaped(c);
  assert.equal(c.command, 'hoprig workspace credentials --github');
  assert.equal(c.size, Buffer.byteLength(KEY2));
  const text = JSON.stringify(r);
  for (const n of ['cred-file-name-zq1', 'kept-copy-name-zq2']) assert.ok(!text.includes(n), n);
});

test("Hoprig's own settings are named by folder and size only", () => {
  const s = r.items.filter((i) => i.kind === 'hoprig');
  assert.deepEqual(s.map((i) => i.where), [process.env.HOPRIG_CONFIG_DIR]);
  assert.equal(s[0].size, 3);
  assert.match(s[0].todo, /copy it yourself if you want your providers and settings on the next computer/);
  assert.ok(!JSON.stringify(r).includes('config.json'));
});

test('databases: a dump older than the data is named; a newer dump is not; an engine of test data is not', () => {
  const d = r.items.filter((i) => i.kind === 'database');
  assert.equal(d.length, 1, JSON.stringify(d));
  shaped(d[0]);
  assert.match(d[0].what, /^postgresql runs here/);
  assert.equal(d[0].command, 'hoprig pc leave --test-data postgresql');
});

test('a dot-folder of 2 MB not known is asked about once with its size; a cache, history, and small ones are not', () => {
  const asks = Object.fromEntries(r.asks.map((a) => [a.where, a]));
  assert.deepEqual(Object.keys(asks).sort(), ['~/.config/toolc', '~/.toolx']);
  assert.equal(asks['~/.toolx'].size, 2 * MB);
  assert.equal(asks['~/.toolx'].id, 'dotfolder:~/.toolx');
  assert.equal(asks['~/.toolx'].kind, 'dotfolder');
  assert.match(asks['~/.toolx'].question, /^~\/\.toolx holds 2\.0 MB of a program's own data: keep \(you back it up\) or ignore\?$/);
  assert.ok(MIN_SIZE <= 2 * MB);
  const text = JSON.stringify(r);
  for (const n of ['.cache', '.bash_history', '.toolm', '.android"']) assert.ok(!text.includes(`~/${n}`), n);
});

test('a private folder (no-ai, NO-AI, a link named Ignore) inside a dot-folder is never entered', () => {
  assert.ok(!r.asks.some((a) => a.where === '~/.toolp'), 'its 10 MB inside private folders would have made it asked');
  const text = JSON.stringify(r);
  for (const n of ['private-name-q7', 'private-name-r8', 'no-ai', 'NO-AI']) assert.ok(!text.includes(n), n);
});

test('a link out of the home is never followed: as a dot-folder, or inside one', () => {
  for (const w of ['~/.toolq', '~/.linkdot']) assert.ok(!JSON.stringify(r).includes(w), w);
});

test('nothing outside was named, and every item and ask is distinct', () => {
  assert.deepEqual(r.outside, []);
  const ids = [...r.items, ...r.asks].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a private key's content and its hash are in no return value", () => {
  const text = JSON.stringify(r);
  assert.ok(!text.includes(MARKER));
  for (const k of [KEY, KEY2]) assert.ok(!text.includes(crypto.createHash('sha256').update(k).digest('hex')));
  assert.ok(!text.includes('BEGIN OPENSSH'));
});

test('a budget of 50 entries ends in "not measured further", never in a guess', async () => {
  const small = await homeLook({ home: h.home, dir: ws, marks: noMarks, facts: { databases: [] }, budget: { entries: 50, ms: 30000 } });
  const m = small.notChecked.find((n) => n.where === '~/.toolm');
  assert.ok(m, JSON.stringify(small.notChecked));
  assert.match(m.why, /^at least .+, not measured further$/);
  assert.ok(!small.asks.some((a) => a.where === '~/.toolm'));
  assert.ok(!JSON.stringify(small).includes(MARKER));
});

test('the whole home and its temporary folder are the same before and after', () => {
  assert.deepEqual(listing(h.root), before);
});
