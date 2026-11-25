// `hoprig pc leave --check --also <folder>` (src/workspace/leave.mjs, leavewalk.mjs): a computer still in an older
// layout keeps everything under one other folder. Every repository in it is checked with its local refs only, every
// folder in no git is listed with its size; a link is never followed, a private folder (no-ai, in any case) is never
// entered, a walk that does not finish within its budget is named as not checked, and a folder the owner marked as
// outside is named once and not counted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gitWorld } from './gitfix.mjs';

const { capture } = await import('../../src/setup/system.mjs');
const { leaveCheck, BY_YOUR_WORD } = await import('../../src/workspace/leave.mjs');

// The home part is another module's (leavehome.mjs): a stand-in that finds nothing, so these counts are this part's.
const homeLook = async () => ({ items: [], asks: [], outside: [], notChecked: [] });

let w;
let c;
let old;
let nested;
let folds = false; // the disk folds letter case (macOS): NO-AI is the folder no-ai itself

const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const said = (r) => JSON.stringify(r, null, 1);

before(() => {
  w = gitWorld('leave-also');
  c = w.computer('alpha');
  c.use();
  old = path.join(c.home, 'Desktop', 'workspace');
  // Three repositories: one with work not committed (and a repository with no server inside its working tree), one
  // with a branch that has no copy on its server, one with no server at all.
  const alpha = w.clone(w.bare('alpha'), path.join(old, 'alpha'));
  write(path.join(alpha, 'draft.txt'), 'draft\n');
  nested = path.join(alpha, 'tools', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  w.sh(nested, 'init', '-q', '-b', 'main');
  w.commit(nested, 'n.txt', 'nested\n');
  const beta = w.clone(w.bare('beta'), path.join(old, 'beta'));
  w.sh(beta, 'switch', '-q', '-c', 'idea');
  w.commit(beta, 'idea.txt', 'idea\n');
  const gamma = path.join(old, 'clients', 'gamma');
  fs.mkdirSync(gamma, { recursive: true });
  w.sh(gamma, 'init', '-q', '-b', 'main');
  w.commit(gamma, 'g.txt', 'gamma\n');
  // Two plain folders; what an install makes again is not counted.
  write(path.join(old, 'old-docs', 'a.txt'), 'a'.repeat(120));
  write(path.join(old, 'old-docs', 'deep', 'b.txt'), 'b'.repeat(80));
  write(path.join(old, 'old-docs', 'node_modules', 'pkg', 'index.js'), 'x'.repeat(5000));
  write(path.join(old, 'photos', '2019', 'p.jpg'), 'p'.repeat(300));
  // A link out of it, to a folder with a repository and work of its own: never followed.
  const elsewhere = path.join(c.home, 'elsewhere');
  write(path.join(elsewhere, 'outside-file-name.txt'), 'out\n');
  w.sh(path.dirname(elsewhere), 'init', '-q', '-b', 'main', elsewhere);
  fs.symlinkSync(elsewhere, path.join(old, 'linked'));
  // Private folders, in two cases: a file and a repository inside, whose names would show if they were entered.
  write(path.join(old, 'no-ai', 'private-note-name.txt'), 'private\n');
  // On a disk that folds letter case (macOS) NO-AI is the folder no-ai itself: one private folder, not two.
  folds = fs.existsSync(path.join(old, 'NO-AI'));
  const loud = path.join(old, 'NO-AI', 'shout-repo');
  fs.mkdirSync(loud, { recursive: true });
  w.sh(loud, 'init', '-q', '-b', 'main');
  write(path.join(loud, 'shout-name.txt'), 'private\n');
});
after(() => w && w.cleanup());

test('--also: three repositories checked with local refs, two plain folders listed with sizes, no link followed, no private folder entered', async () => {
  const calls = [];
  const run = (argv, o) => (calls.push(argv), capture(argv, o));
  const r = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, also: [old], run, homeLook });
  const at = (rel) => `~/Desktop/workspace/${rel}`;
  const by = (kind, rel) => r.items.filter((i) => i.kind === kind && i.where === at(rel));

  assert.equal(by('work', 'alpha').length, 1, said(r));
  assert.equal(by('branch', 'beta').length, 1, said(r));
  assert.match(by('branch', 'beta')[0].what, /idea \(1 commit\) has no copy on the git server/);
  assert.equal(by('noserver', 'clients/gamma').length, 1, said(r));
  // The repository inside alpha's working tree: its own line, and checked once.
  assert.equal(by('noserver', 'alpha/tools/nested').length, 1, said(r));
  assert.equal(calls.filter((a) => a.includes(nested) && a.includes('--absolute-git-dir')).length, 1, 'the inner repository is checked once');
  assert.equal(by('folder', 'old-docs')[0]?.size, 200, said(r));
  assert.equal(by('folder', 'photos')[0]?.size, 300, said(r));
  assert.match(by('folder', 'photos')[0].what, /in no git: 1 file/);
  // The private folders are named as folders only; nothing inside them.
  assert.equal(by('folder', 'no-ai').length, 1, said(r));
  assert.equal(by('folder', 'NO-AI').length, folds ? 0 : 1, said(r));
  assert.equal(r.items.length, folds ? 7 : 8, said(r));
  const text = said(r);
  for (const hidden of ['private-note-name', 'shout-name', 'shout-repo', 'outside-file-name', 'elsewhere', 'linked']) assert.ok(!text.includes(hidden), `${hidden} shows: ${text}`);
  // A folder outside the workspace: no server is asked, and nothing of it is pushed by the one press.
  assert.deepEqual(calls.filter((a) => a.includes('ls-remote') || a.includes('fetch')), []);
  assert.deepEqual(r.items.filter((i) => i.pushable), []);
  assert.deepEqual(r.notChecked, [], said(r));
  assert.equal(r.nothingOnlyHere, false);
});

test('a folder marked outside, in --also or in the workspace, is named once and not counted', async () => {
  write(path.join(c.ws, 'stray', 'kept.txt'), 'kept\n');
  const plain = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, also: [old], homeLook });
  assert.ok(plain.items.some((i) => i.where === '~/Workspace/stray' && i.kind === 'folder' && i.size === 5), said(plain));
  const marks = { keep: [], ignore: [], outside: ['~/Desktop/workspace/photos', '~/Desktop/workspace/clients', '~/Workspace/stray'], testData: [], label: 'alpha' };
  const seen = [];
  const r = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, also: [old], marks, homeLook: async (o) => (seen.push(o.marks), homeLook()) });
  assert.deepEqual(r.outside.map((o) => o.where).sort(), ['~/Desktop/workspace/clients', '~/Desktop/workspace/photos', '~/Workspace/stray']);
  for (const o of r.outside) assert.equal(o.why, BY_YOUR_WORD);
  assert.ok(!r.items.some((i) => /photos|clients|stray/.test(i.where)), said(r));
  assert.equal(r.items.length, plain.items.length - 3, said(r));
  assert.deepEqual(seen, [marks], 'the home part gets the same marks');
  fs.rmSync(path.join(c.ws, 'stray'), { recursive: true, force: true });
});

test('a walk that does not finish within its budget is named as not checked: at least its size, not measured further', async () => {
  const big = path.join(c.home, 'big');
  for (let i = 0; i < 200; i++) write(path.join(big, `d${i % 10}`, `f${i}.txt`), 'z'.repeat(10));
  const r = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, also: [big], budget: { entries: 50, ms: 30_000 }, homeLook });
  assert.equal(r.notChecked.length, 1, said(r));
  assert.equal(r.notChecked[0].where, '~/big');
  assert.match(r.notChecked[0].why, /^at least \d+(\.\d)? (B|KB), not measured further$/);
  assert.deepEqual(r.items, [], said(r));
  assert.equal(r.nothingOnlyHere, false, 'what was not looked at is never safe');
  fs.rmSync(big, { recursive: true, force: true });
});

test('what the home part finds is merged: an item, an ask or a folder not checked each means something is only here', async () => {
  const one = { id: 'key:~/.ssh/id_ed25519', kind: 'key', where: '~/.ssh/id_ed25519', what: 'a private key', size: 400, todo: 'keep it', command: '', pushable: false };
  const ask = { id: 'dotfolder:~/.toolx', kind: 'dotfolder', where: '~/.toolx', size: 4096, question: 'keep or ignore?' };
  const cases = [[{ items: [one] }, 'items'], [{ asks: [ask] }, 'asks'], [{ notChecked: [{ where: '~/.big', why: 'at least 1 GB, not measured further' }] }, 'notChecked']];
  for (const [part, key] of cases) {
    const r = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, homeLook: async () => ({ items: [], asks: [], outside: [], notChecked: [], ...part }) });
    assert.deepEqual(r[key], part[key]);
    assert.equal(r.nothingOnlyHere, false, key);
  }
  const out = await leaveCheck({ dir: c.ws, projects: c.projects, home: c.home, homeLook: async () => ({ items: [], asks: [], outside: [{ where: '~/.toolx', why: BY_YOUR_WORD }], notChecked: [] }) });
  assert.deepEqual(out.outside, [{ where: '~/.toolx', why: BY_YOUR_WORD }]);
  assert.equal(out.nothingOnlyHere, true, 'a folder left out by the owner\'s word is not counted');
});
