// No test file has a top-level `await import(...)` after its first test. On Node 22.11 the tests that stand after
// such a late import of a file module are never registered, and the runner still says every result arrived, so a
// file runs fewer tests on the oldest Node we support than on the newest, unseen. The import (and any read that
// needs it) goes above the first test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The test files under `dir`, as paths from the root (never a folder named no-ai, never node_modules). */
function testFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'no-ai' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(rel));
    else if (/\.test\.m?js$/.test(e.name)) out.push(rel);
  }
  return out;
}

// A test (test, it, describe, suite, with .skip/.only/.todo), never a hook (before, after, beforeEach, afterEach).
const FIRST_TEST = /^(?:test|it|describe|suite)(?:\.(?!before|after)\w+)?\(/;
// The module named in quotes, as this file's own code names one. The text of a child script a test writes into a
// template string names its module through `${...}` (test/pcsetup/getlock.test.mjs), and is not this file's code.
const TOP_AWAIT_IMPORT = /^(?:(?:const|let|var)\b[^=]*=\s*)?(?:\(\s*)?await\s+import\(\s*['"]/;

/**
 * The top-level lines of `text` with an `await import(` that stand after its first test: [{ line, text }]. A
 * top-level line is one at the start of a line (no indentation), as the files of this suite are written.
 */
export function lateImports(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => FIRST_TEST.test(l));
  if (first < 0) return [];
  const late = [];
  for (let i = first + 1; i < lines.length; i += 1) if (TOP_AWAIT_IMPORT.test(lines[i])) late.push({ line: i + 1, text: lines[i].trim() });
  return late;
}

test('the scan finds a late import and passes one above the first test', () => {
  const early = "const { a } = await import('../src/a.mjs');\ntest('x', () => {});\n";
  const late = "test('x', () => {});\nconst { a } = await import('../src/a.mjs');\ntest('y', () => {});\n";
  const bare = "test('x', () => {});\nawait import('../src/a.mjs');\n";
  const inner = "test('x', async () => {\n  const { a } = await import('../src/a.mjs');\n});\n";
  assert.deepEqual(lateImports(early), []);
  assert.deepEqual(lateImports(late), [{ line: 2, text: "const { a } = await import('../src/a.mjs');" }]);
  assert.equal(lateImports(bare).length, 1);
  assert.deepEqual(lateImports(inner), [], 'an import inside a test is not top level');
  const hook = "test.after(() => {});\nconst { a } = await import('../src/a.mjs');\ntest('x', () => {});\n";
  assert.deepEqual(lateImports(hook), [], 'a hook is not the first test');
  const child = "test('x', () => {});\nfs.writeFileSync(f, `\nconst { a } = await import(${JSON.stringify(p)});\n`);\n";
  assert.deepEqual(lateImports(child), [], 'the text of a child script in a template string is not this file\'s code');
});

test('no test file has a top-level await import after its first test (Node 22.11 never registers the tests after it)', () => {
  const found = [];
  for (const f of testFiles('test')) {
    for (const l of lateImports(fs.readFileSync(path.join(ROOT, f), 'utf8'))) found.push(`${f}:${l.line} ${l.text}`);
  }
  assert.deepEqual(found, [], `a top-level await import after the first test: on Node 22.11 the tests after it are never registered and the runner still says every result arrived; move it above the first test:\n${found.join('\n')}`);
});
