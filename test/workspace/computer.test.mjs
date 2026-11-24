// Each computer's own file in the brain (computer.mjs): two temporary homes on one local bare repository. Each writes
// its own file and never the other's; a label another computer's file holds is refused; the same label coming back
// after a format starts with an empty list of what is here; no path of the computer, host name, address, token or
// password is in either file (markers are planted where they could leak); a computer without a label writes no file
// and nothing asks; the strict reader refuses a bad file and never follows a link; `status --all` says who has what.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-computer');
test.after(() => w.cleanup());
const C = await import('../../src/workspace/computer.mjs');
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { main } = await import('../../src/workspace/cli.mjs');

const brainUrl = w.bare('brain', { empty: true });
const A = w.computer('alpha');
A.use();
const brainA = path.join(A.ws, 'ai_brain');
w.sh(w.root, 'clone', '-q', brainUrl, brainA);
fs.mkdirSync(A.projects, { recursive: true });
w.clone(w.bare('shop'), path.join(A.projects, 'shop'));
await M.updateMap({ dir: A.ws, projects: A.projects });
w.sh(brainA, 'add', '-A');
w.sh(brainA, 'commit', '-q', '-m', 'map');
w.sh(brainA, 'push', '-q', '-u', 'origin', 'main');
const B = w.computer('beta');
const brainB = path.join(B.ws, 'ai_brain');
w.clone(brainUrl, brainB);
fs.mkdirSync(B.projects, { recursive: true });

const fileOf = (c, label) => path.join(c.ws, 'ai_brain', 'computers', `${label}.json`);
const read = (c, label) => JSON.parse(fs.readFileSync(fileOf(c, label), 'utf8'));
const cli = async (args) => {
  const q = await quietUi();
  let out = '';
  const code = await main(args, { ui: q.ui, write: (s) => (out += s) });
  return { code, text: q.text() + out };
};

test('without a label: no file is written and nothing is asked; status says how to give one', async () => {
  A.use();
  const r = await C.writeOwnFile({ dir: A.ws, projects: A.projects });
  assert.equal(r.written, false);
  assert.match(r.why, /no label in the workspace yet:  hoprig workspace label <name>/);
  const u = await upkeepMap({ dir: A.ws, projects: A.projects });
  assert.equal(fs.existsSync(path.join(brainA, 'computers')), false, 'the upkeep wrote no file');
  assert.ok(!u.needs.some((n) => /label/.test(n)), 'no label is no need: it is said in status, not told every round');
  const s = await cli(['status']);
  assert.match(s.text, /this computer has no label in the workspace yet, so it writes no file of its own in the brain:  hoprig workspace label <name>/);
});

test('a label is tidied to lower case; a slash, a dot, a space, 200 characters are refused', async () => {
  for (const bad of ['a/b', '../x', 'a.b', 'two words', 'x'.repeat(200), '', '-lead']) await assert.rejects(C.setLabel(bad, { dir: A.ws, projects: A.projects, dryRun: true }), (e) => e.status === 400, bad);
  assert.equal(C.cleanLabel('  Alpha '), 'alpha');
  assert.equal(C.suggestLabel('Alexs-MacBook.local'), 'alexs-macbook');
});

test('two homes write their own files; neither touches the other\'s', async () => {
  A.use();
  // Markers where a path, a host name or a secret could leak: a folder named like the home, a token-shaped name.
  const host = os.hostname().split('.')[0].toLowerCase();
  fs.mkdirSync(path.join(A.ws, 'development', 'flutter', 'flutter'), { recursive: true });
  fs.mkdirSync(path.join(A.ws, 'development', `${host}-tools`), { recursive: true });
  fs.mkdirSync(path.join(A.ws, 'git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(A.ws, 'git', 'id_ed25519'), 'PRIVATE KEY MARKER\n');
  fs.writeFileSync(path.join(A.ws, 'git', 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'), 'x');
  fs.mkdirSync(path.join(A.ws, 'database', 'postgresql'), { recursive: true });
  fs.writeFileSync(path.join(A.ws, 'database', 'postgresql', 'dump.sql'), 'SECRET-CONTENT-MARKER');
  const ra = await C.setLabel('Alpha', { dir: A.ws, projects: A.projects });
  assert.deepEqual([ra.label, ra.state, ra.written], ['alpha', 'new', true]);
  const fa = read(A, 'alpha');
  assert.equal(fa.label, 'alpha');
  assert.match(fa.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(fa.here, ['shop']);
  assert.equal(fa.folders.development.items.find((i) => i.name === 'flutter').entries, 1);
  assert.deepEqual(fa.folders.database.items, [{ name: 'postgresql', kind: 'folder', entries: 1 }]);
  assert.deepEqual(fa.folders.backups, { there: false });
  const text = fs.readFileSync(fileOf(A, 'alpha'), 'utf8');
  for (const marker of [A.home, os.homedir(), w.root, 'ghp_', 'id_ed25519', 'PRIVATE KEY', 'SECRET-CONTENT', host]) assert.ok(!text.includes(marker), `the file holds no "${marker}"`);
  assert.ok(fa.folders.git.unnamed >= 2 && fa.folders.development.unnamed >= 1, 'such names are counted, not named');
  w.sh(brainA, 'add', 'computers');
  w.sh(brainA, 'commit', '-q', '-m', 'alpha');
  w.sh(brainA, 'push', '-q');
  B.use();
  w.sh(brainB, 'pull', '-q');
  const before = fs.readFileSync(fileOf(B, 'alpha'), 'utf8');
  const rb = await C.setLabel('beta', { dir: B.ws, projects: B.projects });
  assert.equal(rb.state, 'new');
  await upkeepMap({ dir: B.ws, projects: B.projects });
  assert.equal(fs.readFileSync(fileOf(B, 'alpha'), 'utf8'), before, 'B never writes A\'s file');
  assert.deepEqual(read(B, 'beta').here, [], 'nothing of the map is on B');
  assert.notEqual(read(B, 'beta').id, fa.id);
});

test('a label another computer\'s file holds is refused; the same label coming back after a format starts empty', async () => {
  const D = w.computer('fresh');
  D.use();
  const brainD = path.join(D.ws, 'ai_brain');
  w.clone(brainUrl, brainD);
  fs.mkdirSync(D.projects, { recursive: true });
  await assert.rejects(C.setLabel('alpha', { dir: D.ws, projects: D.projects }), (e) => e.code === 'ETAKEN' && /the label alpha is taken/.test(e.message));
  assert.equal(C.thisComputer().label, null, 'nothing stored');
  const r = await cli(['label', 'alpha']);
  assert.equal(r.code, 1);
  assert.match(r.text, /--again/);
  // This computer IS alpha, set up again: its file starts with nothing here, under this computer's new id.
  const back = await C.setLabel('alpha', { dir: D.ws, projects: D.projects, again: true });
  assert.equal(back.state, 'back');
  const f = JSON.parse(fs.readFileSync(fileOf(D, 'alpha'), 'utf8'));
  assert.deepEqual(f.here, []);
  assert.equal(f.id, C.thisComputer().id);
  // A label is given once: another one is refused.
  await assert.rejects(C.setLabel('other', { dir: D.ws, projects: D.projects }), (e) => e.code === 'ELABELLED');
  // The old computer (A) now meets a file with another id under its label: it does not write it, and says why.
  A.use();
  fs.copyFileSync(fileOf(D, 'alpha'), fileOf(A, 'alpha'));
  const ra = await C.writeOwnFile({ dir: A.ws, projects: A.projects });
  assert.equal(ra.written, false);
  assert.match(ra.why, /holds another computer's id/);
  w.sh(brainA, 'checkout', '-q', '--', 'computers/alpha.json');
});

test('the reader: a bad file is named and not used; a computers folder that is a link is not read', async () => {
  B.use();
  const dir = path.join(brainB, 'computers');
  fs.writeFileSync(path.join(dir, 'gamma.json'), JSON.stringify({ label: 'gamma', id: 'nope', here: [] }));
  fs.writeFileSync(path.join(dir, 'Bad Name.json'), '{}');
  fs.writeFileSync(path.join(dir, 'delta.json'), JSON.stringify({ label: 'delta', id: 'a'.repeat(32), here: ['../../etc'] }));
  const c = C.computersHere(B.ws);
  assert.deepEqual(c.files.map((f) => f.label).sort(), ['alpha', 'beta']);
  assert.deepEqual(c.refused.map((r) => r.name).sort(), ['Bad Name.json', 'delta.json', 'gamma.json']);
  for (const n of ['gamma.json', 'Bad Name.json', 'delta.json']) fs.rmSync(path.join(dir, n));
  // The folder swapped for a link to somewhere outside the brain: never read, never written through.
  const outside = path.join(w.root, 'outside');
  fs.mkdirSync(outside);
  fs.renameSync(dir, `${dir}.real`);
  fs.symlinkSync(outside, dir);
  assert.ok(C.computersHere(B.ws).folderWhy);
  const r = await C.writeOwnFile({ dir: B.ws, projects: B.projects });
  assert.equal(r.written, false);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the link');
  fs.rmSync(dir);
  fs.renameSync(`${dir}.real`, dir);
});

test('status --all: which computer has what, from each computer\'s own file', async () => {
  B.use();
  const r = await cli(['status', '--all']);
  assert.equal(r.code, 0);
  assert.match(r.text, /this computer is beta in the workspace/);
  // Another computer's file is "as of" the day it was last committed in the brain (whohas.mjs).
  assert.match(r.text, /alpha {2}as of \d{4}-\d{2}-\d{2} {2}Hoprig \S+ {2}shop/);
  assert.match(r.text, /beta \(this computer\)/);
  const j = await cli(['status', '--all', '--json']);
  const data = JSON.parse(j.text.slice(j.text.indexOf('{')));
  assert.deepEqual(data.computer, { label: 'beta', file: 'ai_brain/computers/beta.json' });
  assert.deepEqual(data.computers.map((x) => x.label), ['alpha', 'beta']);
  assert.equal(data.computers.find((x) => x.label === 'beta').mine, true);
});
