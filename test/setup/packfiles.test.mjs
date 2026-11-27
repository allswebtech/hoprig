// The package's file list holds every folder or file the code reads beside itself at run time. A folder missing from
// "files" works from a checkout and breaks in a packed install (roles/ was missing: a Team mission could not start).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALWAYS = new Set(['package.json']); // npm packs it whatever "files" says

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** The top-level names a source file reaches by climbing out of src/<folder>/ ('..', '..', 'x' or ../../x). */
function readBeside(file) {
  const text = fs.readFileSync(file, 'utf8');
  const depth = path.relative(ROOT, path.dirname(file)).split(path.sep).length; // src/x -> 2, bin -> 1
  const found = new Set();
  const re = /((?:(?:'\.\.'|"\.\.")\s*,\s*|\.\.\/)+)\s*['"]?([A-Za-z0-9_.-]+)/g;
  for (let m; (m = re.exec(text)); ) {
    const ups = (m[1].match(/\.\./g) || []).length;
    if (ups === depth && fs.existsSync(path.join(ROOT, m[2]))) found.add(m[2]);
  }
  return found;
}

test('every folder or file the code reads beside itself is in the package files', () => {
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
  const covered = (name) => ALWAYS.has(name) || files.some((f) => f === name || f.startsWith(`${name}/`));
  const read = new Map();
  for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]) {
    for (const n of readBeside(f)) if (!read.has(n)) read.set(n, path.relative(ROOT, f));
  }
  assert.ok(read.has('web') && read.has('templates') && read.has('skills') && read.has('roles'), `the scan sees what it must: ${[...read.keys()]}`);
  const missing = [...read].filter(([n]) => !covered(n)).map(([n, f]) => `${n} (read in ${f})`);
  assert.deepEqual(missing, [], 'read at run time, missing from package.json "files"');
});
