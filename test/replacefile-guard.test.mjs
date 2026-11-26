// A file replaced by a rename over its name goes through src/replacefile.mjs, so that on Windows a reader holding the
// name that moment (a second dashboard, a command, a hook) is waited for instead of answering EPERM. Every other rename
// under src/ MOVES something (a folder into place, a file aside, a lock taken over under its own rules) and is named
// here, per file with its count and why: a new rename anywhere fails this test until it goes through replaceFile or is
// named. (A grep cannot see a rename hidden behind a helper of a file's own; the helper's tests cover what it does.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'src/replacefile.mjs';

/** The lines of `text` that rename: fs.renameSync (also a named import of it), fs.rename, fs.promises.rename, fsp.rename. */
export function renameLines(text) {
  const bare = new Set();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)) {
    for (const part of m[1].split(',')) {
      const n = /^\s*(rename(?:Sync)?)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (n) bare.add(n[2] || n[1]);
    }
  }
  const re = new RegExp(`\\brenameSync\\b|\\b(?:fs|fsp|promises)\\.rename\\b${bare.size ? `|(^|[^.\\w$])(?:${[...bare].join('|')})\\(` : ''}`);
  return text.split('\n').map((l, i) => [l.replace(/\s\/\/\s.*$/, ''), i + 1])
    .filter(([l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*import\b/.test(l) && re.test(l))
    .map(([, n]) => n);
}

// file → [how many renames, why each is a move and not a replace]
const MOVES = {
  'src/runfile.mjs': [1, 'a stale lock taken over under its takeover lock: a refusal is "not taken", and the wait loop tries again until its end'],
  'src/operator/look.mjs': [3, 'its lock: a stale one renamed aside and a fresh one put back (a refusal is "another holds it"); a broken record set aside'],
  'src/operator/record.mjs': [3, 'its lock: a stale one renamed aside and a fresh one put back (a refusal is "another holds it"); a broken record set aside'],
  'src/operator/decide-store.mjs': [3, 'its lock: a stale one renamed aside and a fresh one put back (a refusal is "another holds it"); a broken record set aside'],
  'src/skillhub/store.mjs': [6, 'skill folders: moved into place, the old one aside into a staging folder, and back on undo (moveDir: rename, else a copy)'],
  'src/machines/keys.mjs': [1, 'a computer that got a new name: its key and host keys move with it'],
  'src/field/settings.mjs': [1, 'a broken record of sent reports set aside as .broken before a fresh one is written'],
  'src/setup/movemark.mjs': [1, 'a part of the move that changed since is set aside beside it (handed in by the tests)'],
  'src/assistant/audit.mjs': [1, 'the audit log turned over to .1 when it is too big'],
  'src/automation/store.mjs': [1, 'a broken store set aside as .broken'],
  'src/chat/trash.mjs': [1, 'the trash: a conversation\'s files moved in and out (src/chat/deletes.mjs)'],
  'src/editor/archive.mjs': [1, 'an unpacked folder moved into its new place'],
  'src/editor/files.mjs': [1, 'Rename in the editor: a file or folder moved to a new name that must not be there'],
  'src/editor/manage.mjs': [1, 'Move in the editor: an entry moved to a new name that must not be there (else a copy across disks)'],
  'src/mission/boxtool.mjs': [3, 'the audit log moved aside under a name of this process\'s own and to .1; a guard taken away under its own name'],
  'src/pcsetup/devinstall.mjs': [2, 'a kit unpacked in a temporary folder, moved one level down, then into its free place in one rename'],
  'src/pcsetup/rules.mjs': [1, 'the edited working rules moved from the old place to the new'],
  'src/pcsetup/workspace.mjs': [1, 'a memory folder kept aside as a backup before the link'],
  'src/workspace/link.mjs': [3, 'a coding tool\'s file or folder kept aside as a backup before the link, and put back when no link can be made'],
  'src/workspace/inside.mjs': [1, 'renameIn: a move inside the workspace, checked there'],
  // Mended by another change for Windows (locks and their records): not looked at here.
  'src/assistant/spend.mjs': [1, 'not looked at here: the spending lock and its record, mended on their own'],
  'src/pcsetup/leftovers.mjs': [2, 'not looked at here: the locks of hoprig get, mended on their own'],
  // The Work folder: not looked at here.
  'src/work/access.mjs': [2, 'not looked at here (src/work)'],
  'src/work/alone.mjs': [1, 'not looked at here (src/work)'],
  'src/work/alonegit.mjs': [1, 'not looked at here (src/work)'],
  'src/work/dofeature.mjs': [1, 'not looked at here (src/work)'],
  'src/work/journal.mjs': [2, 'not looked at here (src/work)'],
  'src/work/lock.mjs': [1, 'not looked at here (src/work)'],
  'src/work/proposals.mjs': [1, 'not looked at here (src/work)'],
  'src/work/runs.mjs': [1, 'not looked at here (src/work)'],
  'src/work/schedfeature.mjs': [1, 'not looked at here (src/work)'],
  'src/work/sessionlog.mjs': [1, 'not looked at here (src/work)'],
  'src/work/store.mjs': [1, 'not looked at here (src/work)'],
  'src/work/tell.mjs': [1, 'not looked at here (src/work)'],
  'src/work/tellwire.mjs': [1, 'not looked at here (src/work)'],
};
// src/wall.mjs: not looked at here; it renames nothing today, and a rename there fails this test as anywhere else.

function sources() {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const full = path.join(e.parentPath ?? e.path, e.name);
    out.push([path.relative(ROOT, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]);
  }
  return out;
}

test('a file is replaced through src/replacefile.mjs; every other rename under src/ is a move named here with why', () => {
  const found = {};
  for (const [rel, text] of sources()) {
    if (rel === HELPER) continue;
    const hits = renameLines(text);
    if (hits.length) found[rel] = hits;
  }
  for (const [rel, lines] of Object.entries(found)) {
    assert.ok(MOVES[rel], `${rel} renames at line ${lines.join(', ')}: a temporary file renamed over a name goes through replaceFile (src/replacefile.mjs); a move is named here with why`);
    assert.equal(lines.length, MOVES[rel][0], `${rel}: ${lines.length} renames (lines ${lines.join(', ')}), ${MOVES[rel][0]} named (${MOVES[rel][1]})`);
  }
  for (const rel of Object.keys(MOVES)) assert.ok(found[rel], `${rel} renames nothing any more: take it off the list`);
});

test('the busy codes and their patience are held once, in src/replacefile.mjs', () => {
  const twins = sources().filter(([rel, text]) => rel !== HELPER && /function\s+patiently\b/.test(text)).map(([rel]) => rel);
  assert.deepEqual(twins, []);
});

test('the grep sees what it must: a rename in any of its forms is caught, a replaceFile is not', () => {
  const lines = (s) => renameLines(`import fs from 'node:fs';\n${s}`).length;
  assert.equal(lines('  fs.renameSync(tmp, file);'), 1);
  assert.equal(lines('  await fs.promises.rename(tmp, file);'), 1, 'the promise form');
  assert.equal(lines('  await fsp.rename(tmp, file);'), 1);
  assert.equal(lines('  fs.rename(tmp, file, cb);'), 1, 'the callback form');
  assert.equal(lines('export function moveDir(from, to, { rename = fs.renameSync } = {}) {'), 1, 'handed on as a default');
  assert.equal(renameLines("import { renameSync as mv } from 'node:fs';\n  mv(tmp, file);").length, 1, 'an aliased named import');
  assert.equal(renameLines("import { rename } from 'node:fs/promises';\n  await rename(tmp, file);").length, 1, 'a named import of the promise form');
  assert.equal(lines('  replaceFile(tmp, file);'), 0, 'the helper');
  assert.equal(lines('  await backend.rename(name, next);'), 0, 'a rename of something that is no file');
  assert.equal(lines('  // fs.renameSync(tmp, file) would answer EPERM on Windows'), 0, 'a comment');
});
