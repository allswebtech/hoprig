// The workspace as a step of the guided setups, and its doctor line: a new computer is asked once (default yes)
// and gets the tree; a computer that has any of it is only reported to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome } from './helpers.mjs';

const t = tempHome('ws-step');
test.after(() => t.cleanup());
const { runWorkspaceStep } = await import('../../src/workspace/step.mjs');
const { workspaceLine, workspaceStatus } = await import('../../src/workspace/layout.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');

const ui = (o) => {
  let text = '';
  return { get text() { return text; }, ui: makeUi({ interactive: false, write: (s) => (text += s), ...o }) };
};

test('dry run: says what it would create, creates nothing; the doctor line says "not set up yet"', async () => {
  const u = ui({ dryRun: true });
  await runWorkspaceStep(u);
  assert.match(u.text, /Creates ~[\\/]Workspace with ai_brain\//);
  assert.match(u.text, /development\/, git\/, database\/postgresql\/, database\/mysql\/ \(only you can open it\) and backups\/; nothing else is changed\./);
  assert.equal(fs.existsSync(t.ws), false);
  assert.deepEqual(workspaceLine(workspaceStatus()), { status: 'info', detail: `${path.join('~', 'Workspace')} not set up yet`, fix: 'hoprig workspace setup' });
});

test('a new computer with --yes: created; run again: only reported', async () => {
  const u = ui({ yes: true });
  assert.deepEqual(await runWorkspaceStep(u), { ok: true, changed: true });
  assert.ok(fs.existsSync(path.join(t.ws, 'ai_brain', 'BRAIN.md')));
  const again = ui({ yes: true });
  assert.deepEqual(await runWorkspaceStep(again), { ok: true, changed: false });
  assert.doesNotMatch(again.text, /Create the workspace/);
  assert.match(again.text, /~[\\/]Workspace · brain \(git\) · 0 projects/);
  assert.equal(workspaceLine(workspaceStatus()).status, 'ok');
});

test('a computer with part of the tree: nothing is asked or created', async () => {
  fs.rmSync(path.join(t.ws, 'backups'), { recursive: true });
  const u = ui({ yes: true });
  assert.deepEqual(await runWorkspaceStep(u), { ok: true, changed: false });
  assert.match(u.text, /missing backups/);
  assert.equal(fs.existsSync(path.join(t.ws, 'backups')), false);
});
