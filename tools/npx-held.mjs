#!/usr/bin/env node
// Every package the built site tells people to run with npx is on npm: .github/workflows/site.yml runs this before it
// deploys.
//
//   node tools/npx-held.mjs <built site folder>
//
// Why: the site and its llms.txt are read by people and by AI tools, and `npx <name>` runs whatever package holds that
// name, without a question in a shell that has no terminal. A name that nobody holds yet (a package of ours that has
// not had its first publish) can be taken by anyone, and every reader would run their code. So a page that names an
// npx command whose package is not on npm is not deployed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*/.source;

/** The package names after "npx" (and its -y / --yes) in a text, each once. */
export function npxNames(text) {
  const names = new Set();
  for (const m of String(text).matchAll(new RegExp(`\\bnpx\\s+(?:(?:-y|--yes)\\s+)?(${NAME})`, 'g'))) names.add(m[1].replace(/[._~-]+$/, ''));
  return [...names].sort();
}

/** The names that npm does not know: `view` answers whether one is there (injected by the test). */
export function notHeld(names, view = npmHas) {
  return names.filter((n) => !view(n));
}

function npmHas(name) {
  const r = spawnSync('npm', ['view', name, 'name'], { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
  if (r.status === 0 && r.stdout.trim() === name) return true;
  if (/E404|404 Not Found/.test(r.stderr || '')) return false;
  throw new Error(`npm view ${name} did not answer (${(r.stderr || r.error?.message || '').trim().split('\n')[0]})`);
}

function textsIn(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(html|md|txt)$/.test(e.name))
    .map((e) => fs.readFileSync(path.join(e.parentPath ?? e.path, e.name), 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dir = process.argv[2];
    if (!dir) throw new Error('usage: node tools/npx-held.mjs <built site folder>');
    const names = npxNames(textsIn(dir).join('\n'));
    const missing = notHeld(names);
    if (missing.length) {
      console.error(`The site tells readers to run ${missing.map((n) => `npx ${n}`).join(', ')}, but npm has no such package: anyone could take the name. Publish it first (RELEASING.md), then deploy again.`);
      process.exitCode = 1;
    } else console.log(`Every npx command the site names is on npm: ${names.join(', ') || '(none)'}.`);
  } catch (e) {
    console.error(`npx-held: ${e.message}`);
    process.exitCode = 1;
  }
}
