// The gateway Hoprig ships today is named in ONE place of the product: its entry in src/addons/gateways.mjs. Pages,
// commands, routes, variables and comments elsewhere say "a gateway" or take its title from the definition, so it can
// be replaced by another gateway without touching them. Docs that describe it to a user, the tests and their fixtures
// may name it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The name in any case or spelling: "TRouteAI", "trouteai", "t-route ai", "T_ROUTE_AI".
const NAME = /t[\s._-]*route[\s._-]*a[\s._-]*i/i;
// The files that may hold it, and where in them.
const ALLOWED = { 'src/addons/gateways.mjs': 'its entry in SHIPPED' };

function files(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith('.webp') && !e.name.endsWith('.png'))
    .map((e) => path.relative(ROOT, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));
}

test('src/, bin/ and web/ name the shipped gateway only in its table entry', () => {
  const found = ['src', 'bin', 'web'].flatMap(files).filter((f) => NAME.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(found, Object.keys(ALLOWED));
  // In that file, only between the start of SHIPPED and its end.
  const src = fs.readFileSync(path.join(ROOT, 'src/addons/gateways.mjs'), 'utf8');
  const start = src.indexOf('export const SHIPPED = [');
  const end = src.indexOf('\n];\n', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(src.slice(0, start) + src.slice(end), NAME);
});

test('the check itself finds every spelling', () => {
  for (const s of ['TRouteAI', 'trouteai', 'TROUTEAI', 't-route-ai', 'T_Route_AI', 't route ai']) assert.match(s, NAME);
  assert.doesNotMatch('the router of the gateway', NAME);
});
