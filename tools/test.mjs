#!/usr/bin/env node
// Runs the tests: every `*.test.mjs` under the given folders (default: `test`), and nothing else.
//
// Why not `node --test test/`: on Node 20 a folder argument means "run every .mjs in it", so the fixtures
// (stand-in servers that never exit) were started as tests and the run hung for ever. Newer Node versions only
// pick test-named files, and a glob needs Node 21 or a shell that expands it (not Windows). Listing the files
// here behaves the same on every supported Node version and system.
//
//   node tools/test.mjs                 all tests
//   node tools/test.mjs test/server     one area
//   node tools/test.mjs --test-only     arguments starting with "-" go to `node --test` unchanged

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
const places = args.filter((a) => !a.startsWith('-'));

/** Every `*.test.mjs` under `place` (a folder, or one file), sorted so a run is the same each time. */
function testFiles(place) {
  const full = resolve(root, place);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .filter((f) => !f.split(/[\\/]/).includes('node_modules'))
    .sort();
}

const files = (places.length ? places : ['test']).flatMap(testFiles);
if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}

// A test that hangs must fail, not hold the run for ever (a hung file once kept a CI job alive for 25 minutes).
// The slowest end-to-end test takes well under a minute; --test-timeout exists from Node 20.11.
const [major, minor] = process.versions.node.split('.').map(Number);
const limit = flags.some((f) => f.startsWith('--test-timeout')) || (major === 20 && minor < 11) ? [] : ['--test-timeout=180000'];

const child = spawn(process.execPath, ['--test', ...limit, ...flags, ...files], { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
