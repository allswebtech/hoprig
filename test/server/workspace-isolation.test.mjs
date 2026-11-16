// A dashboard looks after its workspace's map a second after it starts (src/automation/workspacesync.mjs): a test
// that starts one without a workspace of its own tidies and maps the real one, and commits in the real brain. So
// every helper that prepares a server gives it its own workspace folder, and every test that starts a server or
// a dashboard uses such a helper or names its own HOPRIG_WORKSPACE_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inside = (child, parent) => !path.relative(parent, child).startsWith('..') && !path.isAbsolute(path.relative(parent, child));

test('the server and setup helpers give their tests a workspace folder of their own', async () => {
  const saved = { ...process.env };
  try {
    const { sandbox } = await import('./helpers.mjs');
    const box = sandbox('ws-iso');
    assert.ok(process.env.HOPRIG_WORKSPACE_DIR && inside(process.env.HOPRIG_WORKSPACE_DIR, box.root), 'sandbox()');
    box.cleanup();
    const { scratch } = await import('../setup/helpers.mjs');
    const s = scratch();
    assert.ok(process.env.HOPRIG_WORKSPACE_DIR && inside(process.env.HOPRIG_WORKSPACE_DIR, s.tmp), 'scratch()');
    s.cleanup();
    // The workspace tests' home: no HOPRIG_WORKSPACE_DIR, so the workspace is the default one in that home.
    const { tempHome } = await import('../workspace/helpers.mjs');
    const t = tempHome('ws-iso');
    const { workspaceDir } = await import('../../src/workspace/layout.mjs');
    assert.ok(inside(workspaceDir({}), t.root), 'tempHome()');
    t.cleanup();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('every test that starts a server or a dashboard has a workspace of its own', () => {
  const files = fs.readdirSync(TEST, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
  const isolated = /\bsandbox\(|\bscratch\(|\btempHome\(|HOPRIG_WORKSPACE_DIR/;
  const inProcess = /import\s*\(?\s*['"][./]*src\/server\/server\.mjs['"]|from\s+['"][./]*src\/server\/server\.mjs['"]/;
  const spawned = /\bBIN\b[^\n]*'serve'/;
  const gaps = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(TEST, f);
    if (inProcess.test(text) && !isolated.test(text)) gaps.push(`${rel}: starts the server in-process`);
    // A spawned `serve` gets the env it is handed: it must name its workspace (a helper's env only counts when the
    // child's env is built from process.env).
    if (spawned.test(text) && !/HOPRIG_WORKSPACE_DIR/.test(text) && !(isolated.test(text) && /\.\.\.process\.env/.test(text))) gaps.push(`${rel}: spawns serve`);
  }
  assert.deepEqual(gaps, [], 'without HOPRIG_WORKSPACE_DIR (or the sandbox, scratch or tempHome helper) the real workspace is used');
});
