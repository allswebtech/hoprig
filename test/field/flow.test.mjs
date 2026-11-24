// Field reports after they are made (src/field): the owner's choice about sending, the send itself through the
// product's pinned delivery, the developers' inbox, a session's way round, the "went wrong twice" line and the copy
// folder. Made-up names only; receivers on this computer's own addresses with a certificate made for the test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';
import { makeCert } from '../machines/certs.mjs';

const t = tempWork('field-flow');
test.after(() => t.cleanup());
const { makeReport, listReports, reportsDir } = await import('../../src/field/report.mjs');
const settings = await import('../../src/field/settings.mjs');
const { sendReports, waitingReports, dontSend, afterReport } = await import('../../src/field/send.mjs');
const { readInbox, inboxText } = await import('../../src/field/inbox.mjs');
const { makeWayRound, waitingWayRounds, freshWayRound, checkLines, WAITING_MAX } = await import('../../src/field/wayround.mjs');
const learn = await import('../../src/field/learn.mjs');
const { twiceLines } = learn;
const { copyReport } = await import('../../src/field/copy.mjs');
const { fieldFeature } = await import('../../src/field/feature.mjs');
const { listDrafts, install, undo, discard } = await import('../../src/skillhub/learned.mjs');
const { main: fieldMain } = await import('../../src/field/cli.mjs');

const NAME = 'reports.example.com';
const root = makeCert({ cn: 'Test Field Authority', ca: true });
const linuxOnly = { skip: process.platform !== 'linux' && 'only Linux answers on all of 127/8' };
const lookup = async () => [{ address: '127.0.0.6', family: 4 }];

/** An https receiver that writes down every request; `answer(n)` → [status, headers]. */
async function receiver(answer = () => [200, {}]) {
  const leaf = makeCert({ cn: NAME, issuer: root, dns: [NAME] });
  const got = [];
  const srv = https.createServer({ key: leaf.keyPem, cert: leaf.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, body, headers: req.headers });
      const [status, headers] = answer(got.length);
      res.writeHead(status, headers);
      res.end('ok');
    });
  });
  srv.on('tlsClientError', () => {});
  await new Promise((r) => srv.listen(0, '127.0.0.6', r));
  return { got, url: `https://${NAME}:${srv.address().port}/in`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

const clearAll = () => {
  fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'field'), { recursive: true, force: true });
  fs.rmSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true, force: true });
};
const T0 = Date.parse('2026-03-01T10:00:00Z');
const report = (kind, cls, at, steps = [{ id: 'clone', end: cls === 'none' ? 'ok' : 'failed' }]) =>
  makeReport({ kind, steps, error: cls === 'none' ? null : cls, startedAt: at - 4000, endedAt: at, version: '0.3.3', system: { os: 'linux', arch: 'x64', node: '22.11.0' } });

// ---------- the owner's choice ----------

test('the address is empty by default: nothing is asked and nothing is sent', async () => {
  clearAll();
  const s = settings.readFieldSettings();
  assert.equal(s.sendTo, '');
  assert.equal(s.choice, null);
  assert.equal(settings.sendChoice(s), 'never');
  const r = report('get', 'network', Date.now());
  assert.deepEqual(await sendReports([r.id], { lookup, ca: root.cert }), []);
  assert.deepEqual(await afterReport(r, { lookup, ca: root.cert }), []);
  assert.throws(() => settings.writeFieldSettings({ choice: 'always' }), /set the address first/);
});

test('only an https address; a new address asks again; a hand edit that is not a setting reads as its default', () => {
  clearAll();
  assert.throws(() => settings.writeFieldSettings({ sendTo: 'http://reports.example.com/in' }), /https/);
  assert.throws(() => settings.writeFieldSettings({ sendTo: 'https://alex:pw@reports.example.com/in' }), /user name/);
  assert.throws(() => settings.writeFieldSettings({ sendTo: 'https://reports.example.com', extra: 1 }), /no setting/);
  settings.writeFieldSettings({ sendTo: 'https://reports.example.com/in' });
  assert.equal(settings.sendChoice(), 'never', 'an address and no choice yet: never');
  settings.writeFieldSettings({ choice: 'always' });
  assert.equal(settings.sendChoice(), 'always');
  settings.writeFieldSettings({ sendTo: 'https://other.example.com/in' });
  assert.equal(settings.readFieldSettings().choice, null, '"always" was said for the other address');
  assert.equal(settings.sendChoice(), 'never');
  // config.json edited by hand: plain http, a choice with no time.
  const cfgFile = path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ fieldReports: { sendTo: 'http://reports.example.com/in', choice: 'always', choiceAt: '2026-01-01T00:00:00Z' } }));
  assert.equal(settings.sendChoice(), 'never');
  fs.writeFileSync(cfgFile, JSON.stringify({ fieldReports: { sendTo: 'https://reports.example.com/in', choice: 'always' } }));
  assert.equal(settings.sendChoice(), 'never', 'a choice without its time is no choice');
});

test('"always" given for one address is no choice when only the address is changed on disk', () => {
  clearAll();
  settings.writeFieldSettings({ sendTo: 'https://reports.example.com/in' });
  settings.writeFieldSettings({ choice: 'always' });
  assert.equal(settings.sendChoice(), 'always');
  const cfgFile = path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.fieldReports.sendTo = 'https://other.example.com/other'; // a hand edit, or a config copied from another computer
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const s = settings.readFieldSettings();
  assert.equal(s.sendTo, 'https://other.example.com/other');
  assert.equal(s.choice, null, 'asked again for the new address');
  assert.equal(settings.sendChoice(s), 'never');
});

test('an address set but no choice made, or "never": no report is sent and the receiver is never asked', linuxOnly, async () => {
  clearAll();
  const rx = await receiver();
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true });
    const r = report('get', 'network', Date.now());
    assert.deepEqual(await sendReports([r.id], { lookup, ca: root.cert }), []);
    assert.deepEqual(await afterReport(r, { lookup, ca: root.cert }), []);
    settings.writeFieldSettings({ choice: 'never' });
    const r2 = report('get', 'network', Date.now());
    assert.deepEqual(await sendReports([r.id, r2.id], { lookup, ca: root.cert }), []);
    assert.deepEqual(rx.got, [], 'the receiver was asked');
  } finally {
    await rx.close();
  }
});

test('"ask each time": what waits is the report file itself, and Send sends exactly those bytes', linuxOnly, async () => {
  clearAll();
  const rx = await receiver();
  try {
    const before = report('get', 'network', Date.now() - 60_000); // made before the choice: never asked about
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'ask' }, { now: () => Date.now() - 30_000 });
    const r = report('drop', 'git-not-pushed', Date.now());
    const waiting = waitingReports();
    assert.deepEqual(waiting.map((x) => x.report.id), [r.id]);
    assert.notEqual(waiting[0].report.id, before.id);
    assert.deepEqual(await afterReport(r, { lookup, ca: root.cert }), [], '"ask" sends nothing by itself');
    assert.equal(rx.got.length, 0);
    const sent = await sendReports([r.id], { lookup, ca: root.cert });
    assert.deepEqual(sent, [{ id: r.id, ok: true, status: 200 }]);
    assert.equal(rx.got.length, 1);
    assert.equal(rx.got[0].body, waiting[0].text, 'byte for byte what was shown');
    assert.equal(rx.got[0].body, fs.readFileSync(path.join(reportsDir(), waiting[0].name), 'utf8'));
    assert.equal(rx.got[0].headers['user-agent'], 'Hoprig-Field-Report');
    assert.deepEqual(waitingReports(), [], 'answered: it waits no more');
    const r2 = report('drop', 'git-not-pushed', Date.now());
    dontSend(r2.id);
    assert.deepEqual(waitingReports(), []);
    assert.equal(settings.readFieldState().answered[r2.id], 'not-sent');
  } finally {
    await rx.close();
  }
});

test('a report that ended before his choice in the same second is never asked about or sent', linuxOnly, async () => {
  clearAll();
  const rx = await receiver();
  try {
    const sec = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    const early = report('get', 'network', sec + 50); // ended 50 ms into the second, before the press
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'ask' }, { now: () => sec + 708 });
    const late = report('get', 'network', sec + 1050); // the next second: after the choice
    assert.deepEqual(waitingReports().map((x) => x.report.id), [late.id]);
    settings.writeFieldSettings({ choice: 'always' }, { now: () => sec + 708 });
    const f = fieldFeature({ caller: () => 'page', readJson: async () => ({}) }, { lookup, ca: root.cert });
    const sent = await f.tick();
    assert.deepEqual(sent.map((x) => x.id), [late.id]);
    assert.deepEqual(await sendReports([early.id], { lookup, ca: root.cert }), []);
    assert.equal(rx.got.length, 1);
    assert.ok(!rx.got.some((g) => g.body.includes(early.id)), 'the report made before the choice never went');
  } finally {
    await rx.close();
  }
});

test('a redirect is not followed, and a send that fails is kept and tried with the next one, three tries at most', linuxOnly, async () => {
  clearAll();
  let status = 302;
  const rx = await receiver(() => [status, status === 302 ? { Location: 'https://elsewhere.example.com/in' } : {}]);
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'always' }, { now: () => Date.now() - 1000 });
    const a = report('setup', 'terminal-module', Date.now());
    const r1 = await afterReport(a, { lookup, ca: root.cert });
    assert.deepEqual(r1, [{ id: a.id, ok: false, status: 302 }]);
    assert.equal(rx.got.length, 1, 'one request: the redirect is an answer, not followed');
    assert.equal(settings.readFieldState().kept[a.id], 1, 'kept for the next send');
    // Nothing tries it again by itself: no timer, no loop.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rx.got.length, 1);
    const b = report('setup', 'terminal-module', Date.now());
    const r2 = await afterReport(b, { lookup, ca: root.cert });
    assert.deepEqual(r2.map((x) => x.id), [a.id, b.id], 'the kept one goes first, with the next');
    assert.equal(rx.got.length, 3);
    const c = report('setup', 'terminal-module', Date.now());
    await afterReport(c, { lookup, ca: root.cert });
    assert.equal(settings.readFieldState().answered[a.id], 'given-up', 'three tries, then given up');
    status = 200;
    const d = report('setup', 'terminal-module', Date.now());
    const r4 = await afterReport(d, { lookup, ca: root.cert });
    assert.ok(!r4.some((x) => x.id === a.id), 'a given-up report is not tried a fourth time');
    assert.ok(r4.every((x) => x.ok));
    const log = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'automation.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.automation === 'field');
    assert.ok(log.some((e) => e.outcome === 'failed: status 302'));
    assert.ok(log.some((e) => e.outcome === 'ok'));
    for (const e of log) assert.ok(!JSON.stringify(e).includes(NAME), 'the address is never in Activity');
  } finally {
    await rx.close();
  }
});

test('"always" with a state folder that cannot be written: ticks post nothing more, and Activity says why', { skip: (process.platform !== 'linux' && 'only Linux answers on all of 127/8') || (process.getuid?.() === 0 && 'root writes into any folder') }, async () => {
  clearAll();
  const rx = await receiver();
  const fieldDir = path.join(process.env.HOPRIG_STATE_DIR, 'field');
  const feature = () => fieldFeature({ caller: () => 'page', readJson: async () => ({}) }, { lookup, ca: root.cert });
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'always' }, { now: () => Date.now() - 2000 });
    const f = feature();
    report('get', 'network', Date.now());
    for (let i = 0; i < 5; i++) await f.tick();
    assert.equal(rx.got.length, 1, 'one report, one POST');
    report('get', 'network', Date.now());
    fs.chmodSync(fieldDir, 0o500); // a stand-in for a full disk or a folder of another owner
    // As the dashboard's own tick calls it (start(): tick().catch): a throw is swallowed there, the next tick comes.
    for (let i = 0; i < 10; i++) await f.tick().catch(() => {});
    const f2 = feature(); // a restarted dashboard: nothing remembered in memory
    for (let i = 0; i < 3; i++) await f2.tick().catch(() => {});
    assert.equal(rx.got.length, 1, 'a try that cannot be noted is not posted');
    const log = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'automation.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.automation === 'field');
    assert.ok(log.some((e) => /could not note the try/.test(e.did)), 'said in Activity');
  } finally {
    fs.chmodSync(fieldDir, 0o700);
    await rx.close();
  }
});

test('"always": a report whose try could not be noted goes at the first tick after the folder can be written again, once', { skip: (process.platform !== 'linux' && 'only Linux answers on all of 127/8') || (process.getuid?.() === 0 && 'root writes into any folder') }, async () => {
  clearAll();
  const rx = await receiver();
  const fieldDir = path.join(process.env.HOPRIG_STATE_DIR, 'field');
  const logFile = path.join(process.env.HOPRIG_STATE_DIR, 'automation.log');
  const unnoted = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /could not note the try/.test(l)).length : 0);
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'always' }, { now: () => Date.now() - 2000 });
    const f = fieldFeature({ caller: () => 'page', readJson: async () => ({}) }, { lookup, ca: root.cert });
    report('get', 'network', Date.now());
    await f.tick();
    assert.equal(rx.got.length, 1);
    const b = report('drop', 'refused', Date.now(), [{ id: 'remove', end: 'failed' }]);
    const before = unnoted();
    fs.chmodSync(fieldDir, 0o500); // a stand-in for a full disk or a folder of another owner
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.tick(), []);
    assert.equal(rx.got.length, 1, 'nothing posted while the try cannot be noted');
    assert.equal(unnoted() - before, 1, 'said once in Activity, not at every tick');
    fs.chmodSync(fieldDir, 0o700);
    // The same dashboard, no restart: the next tick sends it, and the one after sends nothing more.
    assert.deepEqual((await f.tick()).map((x) => [x.id, x.ok]), [[b.id, true]]);
    assert.deepEqual(await f.tick(), []);
    assert.equal(rx.got.length, 2, 'exactly one POST for it');
    assert.equal(settings.readFieldState().answered[b.id], 'sent');
  } finally {
    fs.chmodSync(fieldDir, 0o700);
    await rx.close();
  }
});

test('"always" with a state file that cannot be read: nothing is sent again, the file is put aside, and it is said once', linuxOnly, async () => {
  clearAll();
  const rx = await receiver();
  const stateFile = path.join(process.env.HOPRIG_STATE_DIR, 'field', 'state.json');
  const logFile = path.join(process.env.HOPRIG_STATE_DIR, 'automation.log');
  const said = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /record of what was sent could not be read/.test(l)).length : 0);
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'always' }, { now: () => Date.now() - 2000 });
    const f = fieldFeature({ caller: () => 'page', readJson: async () => ({}) }, { lookup, ca: root.cert });
    report('get', 'network', Date.now());
    report('drop', 'refused', Date.now(), [{ id: 'remove', end: 'failed' }]);
    await f.tick();
    assert.equal(rx.got.length, 2, 'two reports, two POSTs');
    const before = said();
    fs.writeFileSync(stateFile, '{"answ'); // a hand edit or a disk error
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.tick(), []);
    assert.equal(rx.got.length, 2, 'nothing sent again');
    assert.equal(said() - before, 1, 'said once in Activity');
    assert.equal(fs.readFileSync(`${stateFile}.broken`, 'utf8'), '{"answ', 'the broken file is put aside as it was');
    // A report made after that goes, once.
    const c = report('get', 'network', Date.now() + 1000);
    assert.deepEqual((await f.tick()).map((x) => [x.id, x.ok]), [[c.id, true]]);
    assert.deepEqual(await f.tick(), []);
    assert.equal(rx.got.length, 3);
  } finally {
    await rx.close();
  }
});

test('a state file that cannot be read nor put aside: nothing is sent, nothing is written over it, and it is said once', { skip: (process.platform !== 'linux' && 'only Linux answers on all of 127/8') || (process.getuid?.() === 0 && 'root writes into any folder') }, async () => {
  clearAll();
  const rx = await receiver();
  const fieldDir = path.join(process.env.HOPRIG_STATE_DIR, 'field');
  const stateFile = path.join(fieldDir, 'state.json');
  const logFile = path.join(process.env.HOPRIG_STATE_DIR, 'automation.log');
  const said = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /could not be read or put aside/.test(l)).length : 0);
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: true, choice: 'always' }, { now: () => Date.now() - 2000 });
    const f = fieldFeature({ caller: () => 'page', readJson: async () => ({}) }, { lookup, ca: root.cert });
    report('get', 'network', Date.now());
    fs.writeFileSync(stateFile, '{"answ');
    fs.chmodSync(fieldDir, 0o500);
    const before = said();
    for (let i = 0; i < 3; i++) assert.deepEqual(await f.tick().catch(() => []), []);
    assert.equal(rx.got.length, 0, 'nothing sent while what was sent is not known');
    assert.equal(said() - before, 1, 'said once');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"answ', 'never written over');
    assert.equal(settings.readFieldState().broken, true);
  } finally {
    fs.chmodSync(fieldDir, 0o700);
    await rx.close();
  }
});

test('the pinned delivery never throws, also when the request cannot be built', async () => {
  const { postPinned } = await import('../../src/work/hooks.mjs');
  // A header value with a line break makes the request throw before it exists.
  const r = await postPinned(`https://${NAME}:8288/in`, 'x', { ownNetwork: true, lookup, userAgent: 'a\nb' });
  assert.deepEqual(r, { ok: false, status: null });
});

test('an address of this computer is refused unless it is marked as on his own network', linuxOnly, async () => {
  clearAll();
  const rx = await receiver();
  try {
    settings.writeFieldSettings({ sendTo: rx.url, ownNetwork: false, choice: 'always' }, { now: () => Date.now() - 1000 });
    const r = report('kit', 'install-failed', Date.now());
    const out = await afterReport(r, { lookup, ca: root.cert });
    assert.deepEqual(out, [{ id: r.id, ok: false, status: null }]);
    assert.equal(rx.got.length, 0, 'no connection was made');
  } finally {
    await rx.close();
  }
});

// ---------- the inbox ----------

test('the inbox joins reports of the same signature, by how often, and never reads what is not exactly a report', () => {
  clearAll();
  const inbox = path.join(t.root, 'inbox');
  fs.mkdirSync(path.join(inbox, 'sub'), { recursive: true });
  const put = (r, name = `${r.id}.json`) => fs.writeFileSync(path.join(inbox, name), fs.readFileSync(path.join(reportsDir(), fs.readdirSync(reportsDir()).find((n) => n.includes(r.id)))));
  const gets = [];
  for (let i = 0; i < 3; i++) gets.push(report('get', 'git-auth', T0 + i * 1000));
  for (const r of gets) put(r);
  // The same trouble on another patch version of the same minor joins it.
  put(makeReport({ kind: 'get', steps: [{ id: 'clone', end: 'failed', stepIns: 1 }], error: 'git-auth', version: '0.3.4', system: { os: 'linux', arch: 'x64', node: '22.1.0' }, endedAt: T0 + 9000 }));
  put(report('drop', 'git-not-pushed', T0 + 5000));
  put(report('start', 'none', T0 + 6000, [{ id: 'launch', end: 'ok' }]));
  const edited = fs.readFileSync(path.join(inbox, `${gets[0].id}.json`), 'utf8').replace('"get"', '"get /home/alex"');
  assert.match(edited, /get \/home\/alex/, 'the edit changed the copy');
  fs.writeFileSync(path.join(inbox, 'edited.json'), edited);
  fs.writeFileSync(path.join(inbox, 'big.json'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(inbox, 'sub', 'deep.json'), fs.readFileSync(path.join(inbox, `${gets[1].id}.json`)));
  fs.symlinkSync(path.join(inbox, 'sub', 'deep.json'), path.join(inbox, 'link.json'));
  const got = readInbox(inbox);
  assert.equal(got.read, 6);
  assert.equal(got.notRead, 3, 'the edited one, the big one, the link');
  assert.equal(got.groups[0].count, 4);
  assert.deepEqual(got.groups[0].signature, { version: '0.3', system: 'linux', kind: 'get', class: 'git-auth' });
  assert.deepEqual(got.groups[0].failedSteps, { clone: 4 });
  assert.deepEqual(got.groups[0].stepIns, { clone: 1 });
  const text = inboxText(got);
  assert.match(text, /6 reports read, 3 files not read/);
  assert.match(text, /4×\s+get\s+git-auth/);
  assert.ok(!text.includes('/home/alex') && !text.includes('xxxx'));
});

test('the inbox joins the same trouble across Node versions and processors, and counts them inside the group', () => {
  clearAll();
  const inbox = path.join(t.root, 'inbox-systems');
  fs.mkdirSync(inbox, { recursive: true });
  const put = (o) => {
    const r = makeReport({ version: '0.3.3', endedAt: T0, ...o });
    fs.copyFileSync(path.join(reportsDir(), fs.readdirSync(reportsDir()).find((n) => n.includes(r.id))), path.join(inbox, `${r.id}.json`));
  };
  for (const node of ['22.1.0', '24.1.0', '26.0.0']) {
    for (const arch of ['x64', 'arm64']) put({ kind: 'get', steps: [{ id: 'clone', end: 'failed' }], error: 'program-failed', system: { os: 'linux', arch, node } });
  }
  // Where Node is the cause, it stays in the signature.
  put({ kind: 'setup', steps: [{ id: 'pty', end: 'failed' }], error: 'terminal-module', system: { os: 'linux', arch: 'x64', node: '22.1.0' } });
  put({ kind: 'setup', steps: [{ id: 'pty', end: 'failed' }], error: 'terminal-module', system: { os: 'linux', arch: 'x64', node: '26.0.0' } });
  const got = readInbox(inbox);
  assert.equal(got.groups.length, 3);
  assert.equal(got.groups[0].count, 6, 'one group for the same trouble on six kinds of computer');
  assert.deepEqual(got.groups[0].nodes, { node22: 2, node24: 2, node26: 2 });
  assert.deepEqual({ ...got.groups[0].arches }, { x64: 3, arm64: 3 });
  assert.deepEqual(got.groups.slice(1).map((g) => g.signature.system).sort(), ['linux-node22', 'linux-node26']);
  assert.match(inboxText(got), /6×\s+get\s+program-failed\s+\(0\.3, linux\)\n.*\n\s+on: node22 ×2, node24 ×2, node26 ×2; arm64 ×3, x64 ×3/);
});

// ---------- a session's way round ----------

function gitBrain() {
  fs.rmSync(t.brain, { recursive: true, force: true });
  fs.mkdirSync(path.join(t.brain, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(t.brain, 'README.md'), '# brain\n');
  t.git(t.brain, 'init', '-q', '-b', 'main');
  t.git(t.brain, 'add', '-A');
  t.git(t.brain, 'commit', '-q', '-m', 'Start');
}

test('a way round is a draft in Skills → Learned, installed only by the owner\'s press, with Undo, and never a report', async () => {
  clearAll();
  gitBrain();
  for (const d of listDrafts()) fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'skillhub', 'learned', 'drafts', d.id), { recursive: true, force: true });
  const reportsBefore = listReports().reports.length;
  const d = makeWayRound('hoprig get stopped at the clone: the sign-in to GitHub had run out', 'signing in again with gh auth login, then hoprig get once more', { brain: t.brain });
  assert.equal(d.state, 'ready');
  assert.equal(d.kind, 'new');
  assert.equal(d.name, 'ways-round');
  assert.deepEqual(d.tests, [], 'no model was asked: no test requests');
  assert.equal(d.risky, false, JSON.stringify(d.riskyWhy));
  assert.ok(!fs.existsSync(path.join(t.brain, 'skills', 'ways-round')), 'nothing is in the brain before Install');
  assert.equal(listReports().reports.length, reportsBefore, 'a way round makes no report');
  const r = await install(d.id, { brain: t.brain });
  const md = fs.readFileSync(path.join(t.brain, 'skills', 'ways-round', 'SKILL.md'), 'utf8');
  assert.match(md, /- Failed: hoprig get stopped at the clone/);
  assert.match(md, /- Worked: signing in again/);
  assert.match(t.git(t.brain, 'log', '-1', '--format=%s'), /Learned skill: ways-round/);
  // A second way round changes the same skill.
  const d2 = makeWayRound('the dashboard did not start: its port was taken', 'hoprig serve --port 7533', { brain: t.brain });
  assert.equal(d2.kind, 'patch');
  await install(d2.id, { brain: t.brain });
  const md2 = fs.readFileSync(path.join(t.brain, 'skills', 'ways-round', 'SKILL.md'), 'utf8');
  assert.match(md2, /port was taken/);
  assert.match(md2, /stopped at the clone/, 'the first lines stay');
  await undo(d2.id, { brain: t.brain });
  assert.doesNotMatch(fs.readFileSync(path.join(t.brain, 'skills', 'ways-round', 'SKILL.md'), 'utf8'), /port was taken/);
  assert.ok(r.commit);
});

test('a way round made on an older text of the skill is made again on the text there now before Install', async () => {
  clearAll();
  gitBrain();
  for (const d of listDrafts()) fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'skillhub', 'learned', 'drafts', d.id), { recursive: true, force: true });
  const a = makeWayRound('the kit for php failed: a package was missing', 'installing it with the system package manager first', { brain: t.brain });
  const b = makeWayRound('hoprig drop refused: a branch was not pushed', 'pushing the branch, then dropping again', { brain: t.brain });
  await install(a.id, { brain: t.brain });
  const id = freshWayRound(b.id, { brain: t.brain });
  assert.notEqual(id, b.id);
  await install(id, { brain: t.brain });
  const md = fs.readFileSync(path.join(t.brain, 'skills', 'ways-round', 'SKILL.md'), 'utf8');
  assert.match(md, /kit for php/);
  assert.match(md, /branch was not pushed/);
});

test('a way round with a path, an e-mail, user@host, a key or look-alike letters is refused; a fourth waiting one too', () => {
  clearAll();
  for (const d of listDrafts()) fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'skillhub', 'learned', 'drafts', d.id), { recursive: true, force: true });
  const bad = [
    ['the clone into /home/alex/Workspace/shop failed', 'cloning again'],
    ['it failed', 'mailing alex@example.org'],
    ['ssh to alex@box2 failed', 'using the dashboard'],
    ['it failed', 'with the key sk-ant-api03-Xq7VhK2mP9wL4tR8nB3cF6dJ1gS5yA0eZ set'],
    ['the рush failed', 'it worked'],
    // A path outside the listed roots, a drive with a forward slash, and a full-width @ that NFKC reads as "@".
    ['hop get failed in /data/zoltan/shop', 'ran it again'],
    ['hop get failed in D:/zoltan/shop', 'ran it again'],
    ['hop get failed for zoltan\uff20quasarbox', 'ran it again'],
    // A ':' right before the slash, a file address, a path with backslashes and no drive, and slashes NFKC keeps.
    ['hop get failed at:/data/zoltan/shop', 'ran it again'],
    ['hop get failed, see file:///data/zoltan/shop', 'ran it again'],
    ['hop get failed in \\data\\zoltan\\shop', 'ran it again'],
    ['hop get failed in \u2215data\u2215zoltan\u2215shop', 'ran it again'],
    ['hop get failed in \u29f8data\u29f8zoltan\u29f8shop', 'ran it again'],
    // Parts with letters beyond ASCII are parts all the same.
    ['hop get failed in /donn\u00e9es/zoltan', 'ran it again'],
    ['hop get failed in /\u00dcbung/zoltan/shop', 'ran it again'],
    ['hop get failed in \\\u00dcbung\\zoltan', 'ran it again'],
    ['hop get failed in /\u0434\u043e\u043c/\u0437\u043e\u043b', 'ran it again'],
    ['two\nlines', 'it worked'],
    ['', 'it worked'],
  ];
  for (const [f, w] of bad) assert.throws(() => makeWayRound(f, w, { brain: t.brain }), (e) => e.status === 422, `${f} / ${w}`);
  // An address, owner/name and a word with a slash are text, not a path.
  for (const f of ['see https://example.com/a/b', 'hoprig get example/shop failed', 'it works and/or not', 'docs/INSTALL.md says how', 'git clone https://git.example.com:8443/team/shop.git',
    // Two backslash escapes are what a person writes about line ends and patterns, not a folder.
    'the .env had \\r\\n line ends, so hop get failed', 'it printed \\n\\n and stopped', 'the regex \\d\\d failed to match', 'caf\u00e9/bar works']) assert.doesNotThrow(() => checkLines(f, 'ran it again'), f);
  for (let i = 0; i < WAITING_MAX; i++) makeWayRound(`the step number ${i + 1} failed`, 'running it again worked', { brain: t.brain });
  assert.equal(waitingWayRounds().length, WAITING_MAX);
  assert.throws(() => makeWayRound('one more failed', 'it worked', { brain: t.brain }), /3 ways round wait in Skills → Learned already/);
});

test('the Home line\'s draft can be installed for every kind and class: none of the product\'s own words is risky', () => {
  clearAll();
  const { KNOWN, KIND_WORDS, knownFor } = learn;
  const drafts = path.join(process.env.HOPRIG_STATE_DIR, 'skillhub', 'learned', 'drafts');
  const risky = [];
  for (const cls of Object.keys(KNOWN)) {
    for (const kind of Object.keys(KIND_WORDS)) {
      const k = knownFor(kind, cls);
      fs.rmSync(drafts, { recursive: true, force: true });
      // Exactly the text the draft route builds (feature.mjs).
      const d = makeWayRound(`${KIND_WORDS[kind]} went wrong twice: ${k.words}.`, k.help, { trigger: 'field', brain: t.brain });
      if (d.risky) risky.push(`${kind}:${cls}`);
    }
  }
  fs.rmSync(drafts, { recursive: true, force: true });
  assert.deepEqual(risky, []);
});

test('hoprig field way-round: the command a session runs', async () => {
  clearAll();
  for (const d of listDrafts()) await discard(d.id, { brain: t.brain }).catch(() => {});
  const out = [];
  const err = [];
  const io = { write: (s) => out.push(s), error: (s) => err.push(s) };
  assert.equal(await fieldMain(['way-round', '--failed', 'hoprig get could not reach the server', '--worked', 'waiting a minute and running it again'], io), 0);
  assert.match(out.join(''), /wait as a draft in Skills → Learned/);
  assert.equal(await fieldMain(['way-round', '--failed', 'it failed at /home/alex', '--worked', 'x y z'], io), 2);
  assert.match(err.join(''), /path of a computer/);
  assert.equal(await fieldMain(['way-round', '--failed', 'only one'], io), 2);
});

// ---------- learning here ----------

test('a class that came up twice for the same kind is shown once; Dismiss hides it until it comes up again', () => {
  clearAll();
  report('get', 'git-auth', T0);
  assert.deepEqual(twiceLines(), [], 'once is not twice');
  report('drop', 'git-auth', T0 + 1000);
  assert.deepEqual(twiceLines(), [], 'another kind does not count');
  report('get', 'git-auth', T0 + 2000);
  const lines = twiceLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, 'get:git-auth');
  assert.equal(lines[0].count, 2);
  assert.match(lines[0].words, /git was not let into a repository/);
  assert.equal(lines[0].command, 'hoprig pc setup');
  settings.changeFieldState((s) => ({ ...s, dismissed: { ...s.dismissed, [lines[0].key]: lines[0].last } }));
  assert.deepEqual(twiceLines(), [], 'dismissed');
  report('get', 'git-auth', T0 + 3000);
  assert.equal(twiceLines().length, 1, 'it came up again after the dismiss');
});

test('a twice line gives the help of its own kind of work, and offers no draft where there is nothing to learn', async () => {
  clearAll();
  for (const d of listDrafts()) fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'skillhub', 'learned', 'drafts', d.id), { recursive: true, force: true });
  for (let i = 0; i < 2; i++) report('drop', 'not-found', T0 + i * 1000, [{ id: 'find', end: 'failed' }]);
  for (let i = 0; i < 2; i++) report('get', 'program-failed', T0 + 2000 + i * 1000);
  for (let i = 0; i < 2; i++) report('doctor', 'other', T0 + 4000 + i * 1000, [{ id: 'other', end: 'failed' }]);
  const by = Object.fromEntries(twiceLines().map((l) => [l.key, l]));
  assert.match(by['drop:not-found'].help, /hoprig workspace map.*hoprig workspace status/);
  assert.doesNotMatch(by['drop:not-found'].help, /doctor/);
  assert.match(by['get:program-failed'].help, /git could not clone it/);
  assert.doesNotMatch(by['get:program-failed'].help, /doctor/);
  assert.equal(by['drop:not-found'].draft, true);
  // git-auth comes from any https git server that asked for a sign-in, not only GitHub's.
  const auth = learn.knownFor('get', 'git-auth').help;
  assert.match(auth, /git server asked for a sign-in/);
  assert.doesNotMatch(auth, /^Sign in to GitHub/);
  assert.equal(by['doctor:other'].draft, false, 'a draft of "run hoprig doctor" teaches nothing');
  const f = fieldFeature({ caller: () => 'page', readJson: async () => ({}) });
  const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test('/api/field/twice/doctor:other/draft'));
  await assert.rejects(fn({ headers: {} }, '/api/field/twice/doctor:other/draft'.match(re)), (e) => e.status === 409);
  assert.equal(listDrafts().length, 0, 'no draft was made');
});

// ---------- the copy folder ----------

test('"also write each report into this folder": off by default; only the report file, never over another', () => {
  clearAll();
  const mine = path.join(t.root, 'notes', 'reports');
  fs.mkdirSync(mine, { recursive: true });
  report('doctor', 'terminal-module', T0);
  assert.deepEqual(fs.readdirSync(mine), [], 'off by default');
  assert.throws(() => settings.writeFieldSettings({ copyDir: 'notes/reports' }), /whole path/);
  assert.throws(() => settings.writeFieldSettings({ copyDir: path.join(t.root, 'missing') }), /not there/);
  settings.writeFieldSettings({ copyDir: mine });
  const r = report('doctor', 'terminal-module', T0 + 1000);
  const names = fs.readdirSync(mine);
  assert.equal(names.length, 1);
  assert.match(names[0], new RegExp(`${r.id}\\.json$`));
  assert.equal(fs.readFileSync(path.join(mine, names[0]), 'utf8'), fs.readFileSync(path.join(reportsDir(), names[0]), 'utf8'));
  fs.writeFileSync(path.join(mine, names[0]), 'his own text');
  assert.equal(copyReport(mine, r, 'other'), false);
  assert.equal(fs.readFileSync(path.join(mine, names[0]), 'utf8'), 'his own text', 'never over a file that is there');
  assert.deepEqual(fs.readdirSync(mine).filter((n) => n.endsWith('.tmp')), []);
});

// ---------- the routes: his own page only ----------

test('the routes answer the owner\'s page only, never Tia, a token or the server\'s own request', async () => {
  clearAll();
  const ctx = { caller: (req) => req.who, readJson: async () => ({}) };
  const f = fieldFeature(ctx);
  const route = (method, url) => f.routes.find(([m, re]) => m === method && re.test(url));
  const call = async (method, url, req) => {
    const [, re, fn] = route(method, url);
    return fn(req, url.match(re));
  };
  for (const req of [{ who: 'self', headers: {} }, { who: 'computer', headers: {} }, { who: 'page', headers: { authorization: 'Bearer tia_x' } }, { who: 'page', headers: { authorization: 'Bearer wk_x' } }]) {
    await assert.rejects(call('GET', '/api/field', req), (e) => e.status === 403);
    await assert.rejects(call('POST', '/api/field/settings', req), (e) => e.status === 403);
  }
  const v = await call('GET', '/api/field', { who: 'page', headers: {} });
  assert.equal(v.choice, 'never');
  assert.equal(v.question, false, 'no address: nothing is asked');
  assert.deepEqual(await f.tick(), [], 'the tick sends nothing without "always"');
});
