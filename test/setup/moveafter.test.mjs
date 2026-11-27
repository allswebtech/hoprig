// What the move says about the public link and what to do once afterwards (src/setup/moveafter.mjs), from made-up
// settings and records: a Temporary link's new address is said, a Custom link's kept address too; root's link is said
// to stop only before root's dashboard stops; bypass needs its switch; Tia on a provider billed by use needs a cap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const A = await import('../../src/setup/moveafter.mjs');

const cfgDir = path.join(s.tmp, 'cfg');
const stDir = path.join(s.tmp, 'st');
const write = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};

test("a Temporary link's new address is said; a Custom link's kept address too; nothing when the link is off", () => {
  write(path.join(cfgDir, 'config.json'), JSON.stringify({ publicLink: { on: true, kind: 'temporary' } }));
  write(path.join(stDir, 'addons/link.json'), JSON.stringify({ url: 'https://old-made-up.trycloudflare.com', connected: true }));
  const before = A.linkOf(cfgDir, stDir);
  assert.deepEqual(before, { on: true, kind: 'temporary', url: 'https://old-made-up.trycloudflare.com', connected: true });
  assert.match(A.linkWarning(before), /stops in a moment, and with it this Temporary link's address/);
  const after = { on: true, kind: 'temporary', url: 'https://new-made-up.trycloudflare.com', connected: true };
  assert.match(A.linkLines(before, after)[0], /at a NEW address: https:\/\/new-made-up\.trycloudflare\.com \(it was https:\/\/old-made-up/);
  assert.match(A.linkLines(before, { ...after, connected: false })[0], /has not come up as the user yet/);
  const custom = { on: true, kind: 'custom', url: 'https://dash.example.com', connected: true };
  assert.match(A.linkLines(custom, custom)[0], /at the same address: https:\/\/dash\.example\.com/);
  assert.match(A.linkWarning(custom), /keeps its address/);
  assert.deepEqual(A.linkLines({ on: false }, null), []);
  assert.equal(A.linkWarning({ on: false }), null);
});

test('things to do once: the bypass switch, and a daily cap for Tia on a provider billed by use', () => {
  write(path.join(cfgDir, 'config.json'), JSON.stringify({ sessionDefaults: { permissionMode: 'bypassPermissions' }, assistant: { enabled: true, runsOn: 'api' } }));
  write(path.join(cfgDir, 'profiles/api.env'), 'ANTHROPIC_API_KEY=made-up\n');
  const lines = A.onceLines(cfgDir);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /turn it on once in Settings → New sessions/);
  assert.match(lines[1], /Tia thinks on api, a provider billed by use, and has no daily limit for paid use/);
  assert.doesNotMatch(lines.join('\n'), /made-up/);
  write(path.join(cfgDir, 'config.json'), JSON.stringify({ allowBypass: true, sessionDefaults: { permissionMode: 'bypassPermissions' }, assistant: { enabled: true, runsOn: 'api', dailyCapUsd: 5 } }));
  assert.deepEqual(A.onceLines(cfgDir), []);
});

test("root's old system-wide Hoprig is said as left alone", () => {
  const line = A.systemWideLine({ name: 'hoprig' }, { exists: (p) => p === '/usr/lib/node_modules/hoprig' });
  assert.match(line, /Root still has the old system-wide Hoprig \(\/usr\/lib\/node_modules\/hoprig\)\. It is left alone and is not the one in use/);
  assert.equal(A.systemWideLine({ name: 'hoprig' }, { exists: () => false }), null);
});
