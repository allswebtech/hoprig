// Rule: nothing of the needs runs by itself. In the real dashboard (createServer), in a workspace where shop needs
// kits/parts and docs (docs only in the map), the start and three upkeep ticks make no file call from
// src/workspace/needs.mjs, fetch no need and change nothing in the home. Only an asked thing reads them: here the
// new-session sheet's "Also open" (GET /api/folders/extras), once at the end, so the watch is shown to see them.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHELL_STANDINS } from '../seal.mjs';
import { needsWorld } from './needsfix.mjs';

const OURS = /src[\\/]workspace[\\/]needs\.mjs/;
const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'automation', 'fixtures', 'fake-claude.mjs');

/** Every file under `root` → a hash of its content (a link: where it points). */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

/** The file calls made while it is on whose stack holds needs.mjs. */
function watch() {
  const seen = [];
  let on = true;
  const orig = {};
  for (const k of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync', 'openSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'renameSync']) {
    orig[k] = fs[k];
    const wrapped = function (p, ...rest) {
      if (on && OURS.test(new Error().stack)) seen.push(`${k} ${typeof p === 'string' ? p : ''}`);
      return orig[k].call(this, p, ...rest);
    };
    Object.assign(wrapped, orig[k]);
    fs[k] = wrapped;
  }
  syncBuiltinESMExports();
  return {
    seen,
    pause: () => { on = false; },
    resume: () => { on = true; },
    stop: () => {
      Object.assign(fs, orig);
      syncBuiltinESMExports();
    },
  };
}

test('the start and three upkeep ticks read no need and fetch none; one asked request does read them', { timeout: 90_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const w = needsWorld('needs-byitself', { shopNeeds: ['kits/parts', 'docs'] });
  process.env.HOPRIG_WORKSPACE_DIR = w.ws;
  for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID']) delete process.env[k];
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const claudeBin = path.join(w.root, 'fake-claude'); // no extension: on Windows the runner starts a #! stand-in without one
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath.replaceAll('\\', '/')}' '${FAKE_CLAUDE.replaceAll('\\', '/')}' "$@"\n`, { mode: 0o755 });
  // Default settings: the automations as they come.
  saveConfig({ claudeBin, usage: false, server: { backend: 'pty', roots: [w.ws], passwordHash: await hashPassword('pw-for-tests') } });
  const before = snapshot(w.home);
  const seen = watch();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `needs-byitself-${process.pid}` });
  const { port } = await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500)); // what the start does by itself is done
  const auto = app.features.find((f) => f.name === 'automation').automation;
  for (let i = 0; i < 3; i++) await auto.tick();
  await new Promise((r) => setTimeout(r, 500));
  seen.pause();
  assert.deepEqual(seen.seen, [], 'no file call from the needs by itself');
  assert.ok(!fs.existsSync(path.join(w.projects, 'docs')), 'no need fetched');
  assert.deepEqual(changes(before, snapshot(w.home)).filter((f) => !f.startsWith('Workspace/ai_brain/computers/')), [], 'nothing in the home changed');

  // Asked: the sheet's "Also open". The watch sees the reading now, and still nothing is fetched or written.
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const asked = snapshot(w.home);
  seen.resume();
  const r = await fetch(`${base}/api/folders/extras?${new URLSearchParams({ path: w.shop })}`, { headers: { Origin: base, Cookie: cookie } });
  seen.pause();
  assert.equal(r.status, 200);
  assert.equal((await r.json()).project, 'shop');
  assert.ok(seen.seen.some((c) => /project\.json$/.test(c) || /^realpathSync /.test(c)), `the watch sees the reading when asked: ${seen.seen.slice(0, 4).join(' | ')}`);
  assert.deepEqual(seen.seen.filter((c) => /^(writeFileSync|mkdirSync|rmSync|renameSync) /.test(c)), [], 'nothing written when asked');
  assert.deepEqual(changes(asked, snapshot(w.home)), [], 'nothing in the home changed when asked');
});
