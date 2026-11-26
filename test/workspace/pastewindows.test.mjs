// On Windows every move or removal Hoprig prints for the owner to paste is a PowerShell line (src/setup/system.mjs
// showFileCommand, showLinkRemoveCommand): cmd has no mv or rm -rf, and PowerShell's rm takes no -rf. Each place is
// handed 'win32' here, on any system; the lines Linux and macOS print are pasted into sh in pastecommands.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const W = 'win32';
const w = gitWorld('ws-pastewin');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const ps = (p) => `'${p.replace(/'/g, "''")}'`;

test('workspace set: moving the old folder is Move-Item', async () => {
  const { setPlaces } = await import('../../src/workspace/places.mjs');
  const from = path.join(w.root, 'old projects');
  fs.mkdirSync(from, { recursive: true });
  const to = path.join(w.root, "al'ex projects");
  const r = setPlaces({ projects: to }, { save: () => {}, load: () => ({ projectsDir: from }), remember: () => {}, platform: W });
  assert.deepEqual(r.moves, [`Move-Item -LiteralPath ${ps(from)} -Destination ${ps(to)}`]);
});

test('restore with a brain in the way: Move-Item in the refusal', async () => {
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const ws = path.join(w.root, 'ws-in-the-way');
  fs.mkdirSync(path.join(ws, 'ai_brain'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'ai_brain', 'notes.md'), 'mine');
  const e = await restoreWorkspace('https://github.com/alex/brain.git', { ui: makeUi({ interactive: false, write: () => {} }), dir: ws, platform: W }).catch((x) => x);
  const brain = path.join(ws, 'ai_brain');
  assert.ok(e.message.includes(`Move it aside first (Move-Item -LiteralPath ${ps(brain)} -Destination ${ps(`${brain}.old`)}) and run restore again.`), e.message);
});

test('a provider file named like a command: renamed with Move-Item', async () => {
  const { profilesCheck } = await import('../../src/setup/checks.mjs');
  const { profilesDir } = await import('../../src/paths.mjs');
  const fix = profilesCheck([], ['codex'], W).fix;
  assert.equal(fix, `Move-Item -LiteralPath ${ps(path.join(profilesDir(), 'codex.env'))} -Destination ${ps(path.join(profilesDir(), 'codex-provider.env'))}`);
});

test('a memory link that points elsewhere: the link alone is removed, then linked again', async () => {
  const { planMemoryPairs } = await import('../../src/pcsetup/workspace.mjs');
  const { projectSlug } = await import('../../src/sessions.mjs');
  const base = path.join(w.root, 'claude');
  const launch = path.join(w.root, 'launch');
  const link = path.join(base, 'projects', projectSlug(launch), 'memory');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(w.root, 'elsewhere'), link);
  const [p] = planMemoryPairs([{ launch, memory: path.join(w.root, 'mem') }], { base, fix: 'hoprig project link x', platform: W });
  assert.equal(p.action, 'conflict');
  assert.equal(p.fix, `(Get-Item -LiteralPath ${ps(link)} -Force).Delete(); if ($?) { hoprig project link x }`);
});

test('drop: a folder it could not delete is removed by the walk that removes links as links (read-only files too); a link is removed alone', async () => {
  const { deleteCommand } = await import('../../src/workspace/dropacts.mjs');
  const { showFileCommand } = await import('../../src/setup/system.mjs');
  const dir = path.join(w.root, 'shop.dropped');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(deleteCommand(dir, W), showFileCommand('rm -rf', [dir], W));
  assert.ok(deleteCommand(dir, W).endsWith(`} ${ps(dir)}`));
  const link = path.join(w.root, 'shop.link');
  fs.symlinkSync(dir, link);
  assert.equal(deleteCommand(link, W), `(Get-Item -LiteralPath ${ps(link)} -Force).Delete()`);
});

test('a project here under another name: the map status says the same Move-Item as restore', async () => {
  const M = await import('../../src/workspace/map.mjs');
  const { mvCommand } = await import('../../src/pcsetup/getproject.mjs');
  w.clone(w.bare('brain'), path.join(A.ws, 'ai_brain'));
  M.writeMap({ version: 2, brain: { url: w.url('brain') }, projects: [{ name: 'shop', url: w.url('shop'), repos: [] }], others: [] }, A.ws);
  w.clone(w.bare('shop'), path.join(A.projects, 'shop-old'));
  const st = await M.mapStatus({ dir: A.ws, projects: A.projects, platform: W });
  const e = st.entries.find((x) => x.label === 'shop');
  assert.equal(e.fix, `it is here as shop-old: ${mvCommand(A.projects, 'shop-old', 'shop', W)}`);
  assert.match(e.fix, /: Move-Item -LiteralPath '/);
});

test('a group command not found by its name, the line to add: for the PowerShell profile on Windows, the shell start file elsewhere', async () => {
  const { pathAdvice } = await import('../../src/workspace/grouptool.mjs');
  assert.equal(pathAdvice("C:\\Users\\al'ex\\bin", W), "add this line to your PowerShell profile ($PROFILE) (Hoprig does not edit it):  $env:Path = 'C:\\Users\\al''ex\\bin;' + $env:Path");
  assert.equal(pathAdvice('/home/alex/.local/bin', 'linux'), 'add this line to your shell\'s start file (Hoprig does not edit it):  export PATH="/home/alex/.local/bin:$PATH"');
});
