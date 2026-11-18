// A gateway of the owner's own is a program Hoprig will run: no tool of Tia's can add, change or remove one. Her door
// refuses the routes that do (however they are spelled, on any computer), her settings route has no "gateways", no
// route she may use matches them, a linked hub's machine token cannot reach them, and nothing in her code writes
// that part of the configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALLOW, NEVER, checkRoute } from '../../src/assistant/door.mjs';
import { tokenMayReach } from '../../src/machines/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const refused = (fn) => assert.throws(fn, (e) => e.status === 403 && e.code === 'tia-route');
const ctx = { config: () => ({ sessionDefaults: {} }) };
const ROUTES = ['/api/gateways/defined/add', '/api/gateways/defined/remove'];

test('her door refuses the routes that add or remove a gateway, in every spelling and on every computer', () => {
  for (const p of [...ROUTES, '/api/gateways/%64efined/add', '/api/gateways/defined/%61dd', '/m/laptop/api/gateways/defined/add', '/api/gateways/defined', '/api/gateways/defined/x']) {
    refused(() => checkRoute('POST', p, { definition: { id: 'relay' }, confirmed: true }, ctx));
  }
  for (const p of ROUTES) for (const r of ALLOW) assert.equal(r.re.test(p), false, `${r.path} must not match ${p}`);
  // On NEVER too: refused even if a later mistake put a matching route in ALLOW.
  for (const p of ROUTES) assert.ok(NEVER.some((re) => re.test(p)), `${p} is on NEVER`);
});

test('her settings route cannot write gateways, and a machine token cannot reach the routes', () => {
  refused(() => checkRoute('POST', '/api/settings', { gateways: { defined: [{ id: 'relay' }] } }, ctx));
  refused(() => checkRoute('POST', '/api/settings', { server: { gateways: [] } }, ctx));
  for (const p of ROUTES) assert.equal(tokenMayReach(p), false, p);
});

test('nothing in her code writes the configuration\'s gateways or uses what adds one', () => {
  const dir = path.join(ROOT, 'src', 'assistant');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/saveConfig\(\s*\{\s*([A-Za-z_$]+)/g)) assert.equal(m[1], 'assistant', `${f} writes "${m[1]}"`);
    // The door names the routes only to refuse them (the first test).
    if (f !== 'door.mjs') assert.doesNotMatch(src, /addDefinition|removeDefinition|addons\/gateways\.mjs|gatewaycli|gateways\/defined/, f);
  }
});
