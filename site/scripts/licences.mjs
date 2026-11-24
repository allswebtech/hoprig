#!/usr/bin/env node
// Every package in site/package-lock.json is under a licence this Apache-2.0 repository may ship with.
//
//   node site/scripts/licences.mjs [lock]
//
// The lock records each package's licence as npm read it from the package. A package with no licence there, or with
// one outside ALLOWED, fails the check by name. An SPDX expression is read plainly: "A OR B" passes when one side
// passes, "A AND B" only when both do. Exported for test/site/site.test.mjs, which runs it on the real lock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Permissive licences that ask for no more than a notice. Copyleft (GPL, LGPL, MPL, EPL) and "no licence" are not here.
// CC-BY-4.0 is the data licence of caniuse-lite (browser support tables Next reads at build time).
export const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'CC-BY-4.0', 'Python-2.0', 'Unlicense']);

/** True when an SPDX expression (or a plain name) is allowed. */
export function allowed(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  const e = expr.trim().replace(/^\((.*)\)$/, '$1');
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some(allowed);
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every(allowed);
  return ALLOWED.has(e);
}

/** The packages of a lock whose licence is missing or not allowed: [{ name, licence }]. */
export function refused(lock) {
  const out = [];
  for (const [where, p] of Object.entries(lock.packages || {})) {
    if (!where || p.link) continue; // the site itself; a link's target is an entry of its own, checked there
    const name = where.replace(/^.*node_modules\//, '');
    if (!allowed(p.license)) out.push({ name, licence: p.license ?? null });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || fileURLToPath(new URL('../package-lock.json', import.meta.url));
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = refused(lock);
  const count = Object.keys(lock.packages || {}).length - 1;
  if (bad.length) {
    for (const b of bad) console.error(`not allowed: ${b.name} (${b.licence ?? 'no licence in the lock'})`);
    process.exit(1);
  }
  console.log(`every package of the lock (${count}) is under an allowed licence`);
}
