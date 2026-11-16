// Codex and OpenCode on Setup: a row each (fine, or an optional extra with Install), the install as a job in the
// page that turns the tool on, a recipe that names them, and `pc setup --recipe` installing them. Stand-in tools:
// nothing is downloaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsetup-tools-'));
Object.assign(process.env, { HOME: path.join(tmp, 'home'), HOPRIG_CONFIG_DIR: path.join(tmp, 'cfg'), HOPRIG_STATE_DIR: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
fs.mkdirSync(process.env.HOME, { recursive: true });
const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
const { codingToolChecks, GROUPS } = await import('../../src/pcsetup/status.mjs');
const { makeRecipe, validateRecipe } = await import('../../src/pcsetup/recipe.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
const { withTool } = await import('../../src/codetools/index.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Stand-in descriptors with the shape src/codetools gives them. */
function fakeTools({ ok = true } = {}) {
  const have = new Map();
  const mk = (id, name, pin) => ({
    id, name, pin, managed: true,
    installedVersion: () => have.get(id) || null,
    async install({ onLine = () => {} } = {}) {
      onLine(`installing ${name} ${pin}`);
      if (ok) have.set(id, pin);
      return { ok, version: ok ? pin : null, output: '' };
    },
  });
  const list = [mk('codex', 'Codex', '0.169.0'), mk('opencode', 'OpenCode', '2.3.0')];
  let cfg = {};
  return {
    have, list, cfg: () => cfg,
    module: { findTool: (id) => list.find((t) => t.id === id) || null, turnOn: (id, o = {}) => (o.save || ((p) => (cfg = { ...cfg, ...p })))({ codingTools: withTool((o.config || (() => cfg))(), id, true) }) },
  };
}

test('Setup rows: fine when installed, an optional extra with Install when not', async () => {
  const t = fakeTools();
  t.have.set('codex', '0.169.0');
  const rows = await codingToolChecks(t.list);
  assert.equal(GROUPS.codetools, 'Coding tools');
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.action || null, r.tool || null]), [['tool.codex', 'ok', null, null], ['tool.opencode', 'info', 'tool-install', 'opencode']]);
  assert.equal(rows[0].detail, "0.169.0 (Hoprig's tools folder)");
  assert.equal(rows[1].fix, 'hoprig tools install opencode');
});

test('POST /api/pcsetup/tool: a job in the page, the tool turned on; strict input', async () => {
  const t = fakeTools();
  let cfg = { codingTools: ['claude'] };
  const sctx = { readJson: async (req) => req.body || {}, config: () => cfg, saveConfig: (p) => (cfg = { ...cfg, ...p }) };
  const f = pcsetupFeature(sctx, { codingTools: t.module, projectsDir: () => path.join(tmp, 'projects') });
  const call = async (method, p, body) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  await assert.rejects(call('POST', '/api/pcsetup/tool', { id: 'claude' }), (e) => e.status === 400, 'Claude Code is installed by its own installer');
  await assert.rejects(call('POST', '/api/pcsetup/tool', { id: '../../x' }), (e) => e.status === 400);
  assert.deepEqual(await call('POST', '/api/pcsetup/tool', { id: 'opencode' }), { started: true });
  let j;
  for (let i = 0; i < 50 && (j = await call('GET', '/api/pcsetup/job?from=0')).running; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(j.kind, 'tool');
  assert.deepEqual(j.result, { ok: true, error: null, data: { tool: 'opencode', version: '2.3.0' } });
  assert.deepEqual(j.lines, ['installing OpenCode 2.3.0']);
  assert.deepEqual(cfg.codingTools, ['claude', 'opencode'], 'installing turns it on');
  await assert.rejects(call('POST', '/api/pcsetup/tool', { id: 'opencode' }), (e) => e.status === 409 && /Settings → Updates/.test(e.message));
});

test('a recipe names the coding tools Hoprig installs, and nothing else', () => {
  const r = makeRecipe({ kits: ['basics'], codingTools: ['codex', 'codex'] });
  assert.deepEqual(r.codingTools, ['codex']);
  assert.deepEqual(validateRecipe(r), { ok: true, recipe: { hoprigRecipe: 1, kits: ['basics'], codingTools: ['codex'] } });
  const bad = validateRecipe({ hoprigRecipe: 1, kits: [], codingTools: ['claude', 'rm -rf /'] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /"claude" is not a coding tool a recipe installs/);
  assert.equal(validateRecipe({ hoprigRecipe: 1, kits: [], codingTools: 'codex' }).ok, false);
});

test('pc setup with a recipe installs its coding tools after the kits, turns them on, and says what to retry', async () => {
  const sys = await sysFacts({ platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, has: () => true, exists: () => false,
    run: async (argv) => ({ ok: true, code: 0, stdout: `${argv[0]} 99.9.9`, stderr: '' }) });
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const t = fakeTools();
  const r = await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['codex', 'opencode'] }, sys, runner: async () => ({ ok: true }), codingTools: t.module });
  assert.equal(r.ok, true, out.join(''));
  assert.deepEqual([...t.have.keys()], ['codex', 'opencode']);
  assert.deepEqual(t.cfg().codingTools, ['claude', 'codex', 'opencode']);
  out.length = 0;
  const again = await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['codex'] }, sys, runner: async () => ({ ok: true }), codingTools: t.module });
  assert.equal(again.changed, false);
  assert.match(out.join(''), /Nothing to do/);
  const broken = fakeTools({ ok: false });
  out.length = 0;
  const failed = await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['codex'] }, sys, runner: async () => ({ ok: true }), codingTools: broken.module });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.missing, ['codingTools.codex']);
  assert.match(out.join(''), /retry:.*hoprig tools install codex/);
});
