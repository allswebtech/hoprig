// Auto per project on real dashboards (createServer, each in a process of its own, on one state folder of this test's
// temporary home): Auto is switched on through both at the same moment, so both look for a ready task at once. The
// task is taken once, by one mission, said once in Work → Activity. No provider is allowed, so no session starts; the
// coding tool is a stand-in that only notes that it was called (it never is).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { missionHome } from './helpers.mjs';

const DASH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dash.mjs');
const t = missionHome('mission-autodash');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { listMissions } = await import('../../src/mission/file.mjs');
const { stateDir } = await import('../../src/paths.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const toolLog = path.join(t.root, 'coding-tool.log');
const tool = path.join(t.root, 'coding-tool');
fs.writeFileSync(tool, `#!/bin/sh\necho "called $*" >> "${toolLog}"\nexit 99\n`, { mode: 0o755 });
const cfg = {
  server: { passwordHash: await hashPassword('pw'), roots: [t.home] },
  claudeBin: tool,
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, auto: false } }, capUsd: 5, providers: [], atOnce: 2 },
};
saveConfig(cfg);

const started = [];
test.after(() => {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});
/** A dashboard in a process of its own, signed in. → { child, settings(patch), end() } */
async function dashboard() {
  const child = spawn(process.execPath, [DASH], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  started.push(child);
  const first = await new Promise((resolve, reject) => {
    readline.createInterface({ input: child.stdout }).once('line', resolve);
    child.once('exit', (c) => reject(new Error(`the dashboard ended with ${c}`)));
  });
  const { port } = JSON.parse(first);
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'signed in');
  const settings = async (patch) => {
    const r = await fetch(`${origin}/api/work/missions/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(patch) });
    return { status: r.status, body: await r.json() };
  };
  const end = () => new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once('exit', r);
    child.kill('SIGTERM');
  });
  return { child, settings, end };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const autos = () => listMissions(resolvePlace(cfg)).missions.filter((m) => m.auto);
const autoLines = () => {
  try {
    return fs.readFileSync(path.join(stateDir(), 'automation.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.automation === 'Tia (Auto)');
  } catch {
    return [];
  }
};

test('two dashboards in two processes, Auto switched on through both at once: a ready task is taken once', { timeout: 90_000 }, async () => {
  const store = workStore(resolvePlace(cfg), { projects: projectNames() });
  const id = (await store.add({ title: 'A ready note for two', project: 'shop', by: 'writer', note: 'Files: note.md' })).item.id;
  const a = await dashboard();
  const b = await dashboard();
  try {
    await sleep(1500); // both have made their first look (Auto off: nothing)
    assert.deepEqual(autos(), [], 'Auto off: nothing started');
    const on = { projects: { shop: { on: true, auto: true } } };
    const [ra, rb] = await Promise.all([a.settings(on), b.settings(on)]);
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    for (let i = 0; i < 100 && !autos().length; i++) await sleep(100);
    await sleep(3000); // time for a second mission, if one were made
    const ms = autos();
    assert.equal(ms.length, 1, JSON.stringify(ms.map((m) => m.id)));
    assert.deepEqual(ms[0].tasks.map((x) => x.id), [id]);
    assert.ok(ms[0].line[0].words.startsWith('Started by Tia (Auto)'), ms[0].line[0].words);
    assert.equal(autoLines().length, 1, 'one line in Work → Activity');
    assert.equal(autoLines()[0].did, 'Tia (Auto) started "A ready note for two" in shop');
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
  assert.equal(fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8') : '', '', 'the coding tool was never started');
  assert.equal(t.trapped(), '');
});
