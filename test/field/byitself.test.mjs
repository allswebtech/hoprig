// What field reports do by themselves (docs/FIELD-REPORTS.md): after an update with reports present and an address
// set but no choice made, and on a fresh install with the address empty, a real start of the dashboard and three ticks
// send nothing, ask nothing but the one question, learn nothing and change nothing of the field folders or the
// settings. A receiver that is asked anything fails the test. Made-up names only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { makeCert } from '../machines/certs.mjs';

const box = sandbox('field-alone');
test.after(() => box.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { makeReport } = await import('../../src/field/report.mjs');

const NAME = 'reports.example.com';
const root = makeCert({ cn: 'Test Field Authority', ca: true });
const linuxOnly = { skip: process.platform !== 'linux' && 'only Linux answers on all of 127/8' };

/** Every file under `dir` → its sha256 (a link by its target). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) out[path.relative(box.root, p)] = `link:${fs.readlinkSync(p)}`;
      else if (e.isFile()) out[path.relative(box.root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

async function strictReceiver() {
  const leaf = makeCert({ cn: NAME, issuer: root, dns: [NAME] });
  const asked = [];
  const srv = https.createServer({ key: leaf.keyPem, cert: leaf.cert }, (req, res) => {
    asked.push(req.url);
    res.writeHead(500);
    res.end();
  });
  srv.on('tlsClientError', () => {});
  await new Promise((r) => srv.listen(0, '127.0.0.7', r));
  // A connection at all counts as asked (a send that failed before its body).
  srv.on('secureConnection', () => asked.push('(connection)'));
  return { asked, url: `https://${NAME}:${srv.address().port}/in`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

async function startAndTick(net) {
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, field: net });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 3; i++) await app.watcher.tick();
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const setCookie = login.headers.get('set-cookie');
    if (!setCookie) assert.fail(`the login gave no cookie: ${login.status} ${await login.text()}`);
    const cookie = setCookie.split(';')[0];
    const view = await (await fetch(`${origin}/api/field`, { headers: { Cookie: cookie } })).json();
    await app.watcher.tick();
    return view;
  } finally {
    await app.close();
  }
}

const fieldSettingsOnDisk = () => JSON.parse(fs.readFileSync(path.join(box.config, 'config.json'), 'utf8')).fieldReports;

const reportsOf = () => {
  const t0 = Date.now() - 3600_000;
  for (let i = 0; i < 4; i++) makeReport({ kind: 'get', steps: [{ id: 'clone', end: 'failed' }], error: 'git-auth', startedAt: t0 + i * 1000, endedAt: t0 + i * 1000 + 2000 });
};

test('after an update: reports present, the address set, no choice made: three ticks send, learn and change nothing', linuxOnly, async () => {
  const rx = await strictReceiver();
  try {
    // An older version's settings with the address added by hand: no choice, no time of one.
    saveConfig({ server: { passwordHash: await hashPassword('pw') }, fieldReports: { sendTo: rx.url, ownNetwork: true } });
    reportsOf();
    const before = snapshot(box.root);
    const settingsBefore = fieldSettingsOnDisk();
    const view = await startAndTick({ lookup: async () => [{ address: '127.0.0.7', family: 4 }], ca: root.cert });
    const after = snapshot(box.root);
    assert.deepEqual(rx.asked, [], 'the receiver was asked');
    assert.equal(view.choice, 'never');
    assert.equal(view.question, true, 'he is asked once, on the page');
    assert.deepEqual(view.waiting, [], 'nothing waits to be sent before he chose "ask each time"');
    assert.equal(view.reports.length, 4);
    const moved = changed(before, after);
    const field = moved.filter((k) => k.split(path.sep).includes('field') || k.includes(`${path.sep}learned${path.sep}`));
    assert.deepEqual(field, [], `the field reports' or learned drafts' files changed: ${field.join(', ')}`);
    // The login writes its own password check into config.json (src/server/strength.mjs): only his field settings count.
    assert.deepEqual(fieldSettingsOnDisk(), settingsBefore, 'the field settings changed');
    const log = path.join(box.state, 'automation.log');
    assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('"automation":"field"'), 'an Activity line of field');
  } finally {
    await rx.close();
  }
});

test('a fresh install: the address is empty, so nothing is asked, sent or learned, and reports are only made', async () => {
  fs.rmSync(path.join(box.state, 'field'), { recursive: true, force: true });
  // Its own dashboard password: the test before it, which set one, runs only on Linux.
  saveConfig({ server: { passwordHash: await hashPassword('pw') }, fieldReports: undefined });
  const cfg = JSON.parse(fs.readFileSync(path.join(box.config, 'config.json'), 'utf8'));
  assert.equal(cfg.fieldReports, undefined);
  reportsOf();
  const before = snapshot(box.root);
  const view = await startAndTick({});
  const after = snapshot(box.root);
  assert.equal(view.settings.sendTo, '');
  assert.equal(view.choice, 'never');
  assert.equal(view.question, false);
  assert.deepEqual(view.waiting, []);
  assert.equal(view.twice.length, 1, 'the twice-wrong line is shown on Home, only shown');
  const field = changed(before, after).filter((k) => k.split(path.sep).includes('field') || k.includes(`${path.sep}learned${path.sep}`));
  assert.deepEqual(field, []);
});
