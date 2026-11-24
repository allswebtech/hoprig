// The AI brain's lock (src/work/lock.mjs) is taken by everything that writes the brain, not only by the upkeep: the
// page's Save it now and a label wait while the upkeep (or a save of the Work list) holds it and answer busy after
// a moment, and the command's label waits until it is free. Nothing lands between the steps of the map's rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { tempHome } from './helpers.mjs';

const t = tempHome('ws-brainlock');
test.after(() => t.cleanup());
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { takeRepoLock } = await import('../../src/work/lock.mjs');
const M = await import('../../src/workspace/map.mjs');

const brain = path.join(t.ws, 'ai_brain');
const git = (...a) => execFileSync('git', ['-C', brain, ...a], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.join(t.ws, 'projects'), { recursive: true });
fs.mkdirSync(brain, { recursive: true });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(brain, 'BRAIN.md'), '# brain\n');
git('add', '-A');
git('commit', '-q', '-m', 'Start');

test('Save it now and a label wait for the brain\'s lock and answer busy; the command\'s label waits until it is free', async () => {
  await M.updateMap({ dir: t.ws, projects: path.join(t.ws, 'projects') });
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = (p, body) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const head = git('rev-parse', 'HEAD');
    let release = await takeRepoLock(brain, { who: 'upkeep', wait: 0 });
    const saved = await post('/api/workspace/map/commit', {});
    assert.equal(saved.status, 409);
    assert.match((await saved.json()).error, /being synced/);
    assert.equal(git('rev-parse', 'HEAD'), head, 'nothing was committed while the upkeep held the brain');
    assert.equal((await post('/api/workspace/label', { label: 'box1' })).status, 409);
    assert.equal(fs.existsSync(path.join(brain, 'computers')), false, 'no label file was written either');
    release();
    assert.equal((await post('/api/workspace/map/commit', {})).status, 200);
    assert.notEqual(git('rev-parse', 'HEAD'), head);
    // The command waits for the lock, then gives the label.
    release = await takeRepoLock(brain, { who: 'upkeep', wait: 0 });
    const { main } = await import('../../src/workspace/cli.mjs');
    let done = false;
    const cmd = main(['label', 'box2', '--json']).then((code) => ((done = true), code));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(done, false, 'the label waits while the upkeep holds the brain');
    assert.equal((loadConfig().computer || {}).label, undefined);
    release();
    assert.equal(await cmd, 0);
    assert.equal(loadConfig().computer.label, 'box2');
  } finally {
    await app.close();
  }
});
