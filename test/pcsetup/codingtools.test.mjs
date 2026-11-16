// The coding tools Hoprig installs (OpenCode) on Setup: a row each (fine, or an optional extra with Install), the
// install as a job in the page that turns the tool on, a recipe that names them, and `pc setup --recipe` installing
// them. Codex is not offered in this version: no row, no install, and a recipe that names it is read as if it did
// not. Stand-in tools: nothing is downloaded.
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
const { RECIPE_CODING_TOOLS, makeRecipe, validateRecipe } = await import('../../src/pcsetup/recipe.mjs');
const { runPcSetup } = await import('../../src/pcsetup/setup.mjs');
const { sysFacts } = await import('../../src/pcsetup/detect.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Stand-in descriptors with the shape src/codetools gives them. */
function fakeTools({ ok = true } = {}) {
  const have = new Map();
  const mk = (id, name, pin) => ({
    id, name, pin, managed: true, about: `${name}, a coding tool`, size: 'about 1 MB',
    installedVersion: () => have.get(id) || null,
    async install({ onLine = () => {} } = {}) {
      onLine(`installing ${name} ${pin}`);
      if (ok) have.set(id, pin);
      return { ok, version: ok ? pin : null, output: '' };
    },
  });
  const list = [mk('opencode', 'OpenCode', '2.3.0'), mk('other', 'Other', '1.0.0')];
  let cfg = {};
  return {
    have, list, cfg: () => cfg,
    // turnOn as the registry does it, with the stand-ins' ids as the offered ones.
    module: { findTool: (id) => list.find((t) => t.id === id) || null, turnOn: (id, o = {}) => (o.save || ((p) => (cfg = { ...cfg, ...p })))({ codingTools: [...new Set([...((o.config || (() => cfg))().codingTools || ['claude']), id])] }) },
  };
}

test('Setup rows: fine when installed, an optional extra with Install when not', async () => {
  const t = fakeTools();
  t.have.set('other', '1.0.0');
  const rows = await codingToolChecks(t.list);
  assert.equal(GROUPS.codetools, 'Coding tools');
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.action || null, r.tool || null]), [['tool.opencode', 'info', 'tool-install', 'opencode'], ['tool.other', 'ok', null, null]]);
  assert.equal(rows[1].detail, "1.0.0 (Hoprig's tools folder)");
  assert.equal(rows[0].fix, 'hoprig tools install opencode');
  // The real registry: OpenCode only (Codex is not offered), nothing installed in this test's own folders.
  const real = await codingToolChecks();
  assert.deepEqual(real.map((r) => [r.id, r.label || r.name || null]).map(([id]) => id), ['tool.opencode']);
  assert.doesNotMatch(JSON.stringify(real), /codex/i);
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
  await assert.rejects(call('POST', '/api/pcsetup/tool', { id: 'opencode', version: '0.0.1' }), (e) => e.status === 400 && /"version" is not a field/.test(e.message), 'unknown fields are refused, as the Updates routes do');
  assert.deepEqual(await call('POST', '/api/pcsetup/tool', { id: 'opencode' }), { started: true });
  let j;
  for (let i = 0; i < 50 && (j = await call('GET', '/api/pcsetup/job?from=0')).running; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(j.kind, 'tool');
  assert.deepEqual(j.result, { ok: true, error: null, data: { tool: 'opencode', name: 'OpenCode', version: '2.3.0' } });
  assert.deepEqual(j.data, { tool: 'opencode', name: 'OpenCode', version: '2.3.0' }, 'the page names the tool in the job\'s title');
  assert.deepEqual(j.lines, [
    'OpenCode 2.3.0: OpenCode, a coding tool. A download of about 1 MB, into Hoprig\'s own tools folder; this takes a minute or two.',
    'installing OpenCode 2.3.0',
    'OpenCode 2.3.0 is installed and turned on.',
  ]);
  assert.deepEqual(cfg.codingTools, ['claude', 'opencode'], 'installing turns it on');
  await assert.rejects(call('POST', '/api/pcsetup/tool', { id: 'opencode' }), (e) => e.status === 409 && /Settings → Updates/.test(e.message));
  // The real registry refuses Codex: it is not part of this version.
  const real = pcsetupFeature(sctx, { projectsDir: () => path.join(tmp, 'projects') });
  const route = real.routes.find(([m, re]) => m === 'POST' && re.test('/api/pcsetup/tool'))[2];
  await assert.rejects(route(Object.assign(Readable.from([]), { body: { id: 'codex' } }), [], new URLSearchParams()), (e) => e.status === 400);
  assert.deepEqual(cfg.codingTools, ['claude', 'opencode'], 'unchanged');
});

test('a recipe names the coding tools Hoprig installs, and nothing else; one that names Codex is read as if it did not', () => {
  assert.deepEqual(RECIPE_CODING_TOOLS, ['opencode']);
  const r = makeRecipe({ kits: ['basics'], codingTools: ['opencode', 'opencode'] });
  assert.deepEqual(r.codingTools, ['opencode']);
  assert.deepEqual(validateRecipe(r), { ok: true, recipe: { hoprigRecipe: 1, kits: ['basics'], codingTools: ['opencode'] } });
  const bad = validateRecipe({ hoprigRecipe: 1, kits: [], codingTools: ['claude', 'rm -rf /'] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /"claude" is not a coding tool a recipe installs \(opencode\)/);
  assert.equal(validateRecipe({ hoprigRecipe: 1, kits: [], codingTools: 'opencode' }).ok, false);
  assert.deepEqual(validateRecipe({ hoprigRecipe: 1, kits: [], codingTools: ['codex', 'opencode'] }), { ok: true, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['opencode'] } }, 'a recipe from a version that offered Codex');
});

test('pc setup with a recipe installs its coding tools after the kits, turns them on, and says what to retry', async () => {
  const sys = await sysFacts({ platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: '/tmp', home: process.env.HOME, has: () => true, exists: () => false,
    run: async (argv) => ({ ok: true, code: 0, stdout: `${argv[0]} 99.9.9`, stderr: '' }) });
  const out = [];
  const ui = makeUi({ yes: true, interactive: false, write: (s) => out.push(s) });
  const t = fakeTools();
  const r = await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['opencode', 'other'] }, sys, runner: async () => ({ ok: true }), codingTools: t.module });
  assert.equal(r.ok, true, out.join(''));
  assert.deepEqual([...t.have.keys()], ['opencode', 'other']);
  assert.deepEqual(t.cfg().codingTools, ['claude', 'opencode', 'other']);
  out.length = 0;
  const again = await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['opencode'] }, sys, runner: async () => ({ ok: true }), codingTools: t.module });
  assert.equal(again.changed, false);
  assert.match(out.join(''), /Nothing to do/);
  const broken = fakeTools({ ok: false });
  out.length = 0;
  const failed = await runPcSetup({ ui, recipe: { hoprigRecipe: 1, kits: [], codingTools: ['opencode'] }, sys, runner: async () => ({ ok: true }), codingTools: broken.module });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.missing, ['codingTools.opencode']);
  assert.match(out.join(''), /retry:.*hoprig tools install opencode/);
});
