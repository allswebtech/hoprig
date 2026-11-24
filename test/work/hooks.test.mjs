// Webhook deliveries (src/work/hooks.mjs) with local receivers: one token's tasks only, the events done, result ready
// and needs you, a signed small body (no answer unless "send the answer too"), no redirect followed, the address
// checked again at each try and connected to as checked, three tries then given up in Activity with the status only,
// a time limit, and nothing at all while there is no webhook.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-hooks');
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { writeRun, newRunId, writerId } = await import('../../src/work/runs.mjs');
const access = await import('../../src/work/access.mjs');
const { workHooks, deliverOnce, signature } = await import('../../src/work/hooks.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const activity = () => {
  try {
    return fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'automation.log'), 'utf8');
  } catch {
    return '';
  }
};

/** A receiver on this computer: answers each request with `answer(req, body)` → [status, headers?, body?]. */
async function receiver(answer = () => [200], host = '127.0.0.1') {
  const got = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      got.push({ headers: req.headers, body, url: req.url });
      const [status, headers = {}, out = ''] = answer(req, body, got.length);
      if (status === 0) return; // never answer
      res.writeHead(status, headers);
      res.end(out);
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  return { got, url: `http://${host}:${srv.address().port}/in`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}
const until = async (what, fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function finishRun(item, state, answer) {
  const r = {
    v: 1, id: newRunId(new Date()), item: item.id, title: item.title, writer: writerId(), by: 'owner', startedAt: new Date(Date.now() + 1000).toISOString(),
    endedAt: new Date(Date.now() + 2000).toISOString(), project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null,
    session: null, conversation: null, message: null, brief: 'x', state, reason: state === 'done' ? null : 'it stopped', answer, commits: [], changed: [], more: 0, was: 'open', statusError: null,
  };
  writeRun(place(), r);
  return r.id;
}
const hooksOf = (o = {}) => workHooks({ place, log: () => {}, waits: [0, 30, 60], lookEvery: 60_000, ...o });

test('nothing runs while there is no webhook: no timer, no read, no delivery', async () => {
  const h = hooksOf();
  const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  h.start();
  assert.equal(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, before, 'no timer');
  h.close();
});

test('only the token\'s own tasks: done, result ready (answer only when asked) and needs you, signed', async () => {
  const rx = await receiver();
  const a = access.createWorkToken('Alpha app');
  const b = access.createWorkToken('Beta app');
  const plain = access.addWebhook({ token: a.id, url: rx.url, events: ['done', 'result', 'needs-you'], ownNetwork: true });
  const withAnswer = access.addWebhook({ token: a.id, url: `${rx.url}?answer=1`, events: ['result'], ownNetwork: true, answer: true });
  const h = hooksOf();
  try {
    const mine = (await store().addFrom({ title: 'Alpha task' }, { token: a.id, name: 'Alpha app' })).item;
    const theirs = (await store().addFrom({ title: 'Beta secret title' }, { token: b.id, name: 'Beta app' })).item;
    const owners = (await store().add({ title: 'Owner secret title' })).item;
    h.start(); // the first look only takes note
    assert.equal(rx.got.length, 0);
    finishRun(mine, 'done', 'The answer of the session');
    finishRun(theirs, 'done', 'not for alpha');
    finishRun(owners, 'done', 'not for alpha');
    h.look();
    await h.idle();
    assert.equal(rx.got.length, 2, 'result to both webhooks of the token');
    const p = rx.got.find((x) => x.url === '/in');
    const w = rx.got.find((x) => x.url === '/in?answer=1');
    const body = JSON.parse(p.body);
    assert.deepEqual(Object.keys(body).sort(), ['event', 'run', 'task', 'time']);
    assert.equal(body.event, 'result');
    assert.deepEqual(body.task, { id: mine.id, title: 'Alpha task', status: 'open' });
    assert.equal('answer' in body, false, 'no answer unless asked');
    assert.equal(JSON.parse(w.body).answer, 'The answer of the session');
    for (const r of [p, w]) {
      const secret = r === p ? plain.secret : withAnswer.secret;
      const ts = r.headers['x-hoprig-timestamp'];
      assert.match(ts, /^\d{10}$/);
      assert.equal(r.headers['x-hoprig-signature'], signature(secret, ts, r.body));
      const want = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${r.body}`).digest('hex')}`;
      assert.equal(r.headers['x-hoprig-signature'], want);
    }
    for (const r of rx.got) assert.equal(/secret title|not for alpha/.test(r.body), false, 'no other task leaves');
    rx.got.length = 0;
    await store().status({ id: mine.id, at: mine.at }, 'waiting');
    h.look();
    await h.idle();
    assert.deepEqual(rx.got.map((x) => JSON.parse(x.body).event), ['needs-you']);
    rx.got.length = 0;
    finishRun(mine, 'failed', '');
    h.look();
    await h.idle();
    assert.deepEqual(rx.got.map((x) => JSON.parse(x.body).event), ['needs-you'], 'a run that stopped for the owner');
    rx.got.length = 0;
    const cur = store().list().items.find((x) => x.id === mine.id);
    await store().status({ id: mine.id, at: cur.at }, 'done');
    h.look();
    await h.idle();
    assert.deepEqual(rx.got.map((x) => JSON.parse(x.body).event), ['done']);
  } finally {
    h.close();
    access.revokeWorkToken(a.id);
    access.revokeWorkToken(b.id);
    await rx.close();
  }
});

test('three tries, then given up and said in Activity with its status only; no redirect is followed', async () => {
  const elsewhere = await receiver();
  const rx = await receiver((req, body, n) => (n === 1 ? [302, { Location: elsewhere.url }] : [500, {}, 'secret error words']));
  const a = access.createWorkToken('Failing app');
  const { secret } = access.addWebhook({ token: a.id, url: rx.url, events: ['result'], ownNetwork: true });
  const h = hooksOf();
  try {
    const it = (await store().addFrom({ title: 'Failing task' }, { token: a.id, name: 'Failing app' })).item;
    h.start();
    finishRun(it, 'done', 'an answer that must not be logged');
    h.look();
    await h.idle();
    assert.equal(rx.got.length, 3, 'three tries');
    assert.equal(elsewhere.got.length, 0, 'the redirect was not followed');
    const log = activity();
    assert.match(log, /given up after 3 tries.*status 500/);
    for (const s of [secret, a.token, 'an answer that must not be logged', 'secret error words', rx.got[0].body]) assert.equal(log.includes(s), false);
  } finally {
    h.close();
    access.revokeWorkToken(a.id);
    await rx.close();
    await elsewhere.close();
  }
});

test('a receiver that never answers is given up after the time limit; an address not marked as my own network is refused', async () => {
  const rx = await receiver(() => [0]);
  try {
    const t0 = Date.now();
    const r = await deliverOnce({ url: rx.url, ownNetwork: true, secret: 'a'.repeat(64) }, '{}', { timeoutMs: 300 });
    assert.deepEqual(r, { ok: false, status: null });
    assert.ok(Date.now() - t0 < 3000);
    const t1 = Date.now();
    const lost = await Promise.race([
      deliverOnce({ url: 'https://hooks.example.com/in', secret: 'a'.repeat(64) }, '{}', { lookup: () => new Promise(() => {}), timeoutMs: 300 }),
      new Promise((r) => setTimeout(() => r('still waiting after 2 s'), 2000).unref()),
    ]);
    assert.deepEqual(lost, { ok: false, status: null }, 'a name lookup that never answers is inside the time limit');
    assert.ok(Date.now() - t1 < 2000);
    const refused = await deliverOnce({ url: rx.url, ownNetwork: false, secret: 'a'.repeat(64) }, '{}');
    assert.equal(refused.refused, true);
  } finally {
    await rx.close();
  }
});

// The receiver listens on 127.0.0.3, which only the stand-in name lookup gives: a connection that looked the name up
// again itself (the system's answer for localhost is 127.0.0.1 or ::1) would not reach it. 127/8 is all loopback on Linux.
test('the connection goes to the one address checked, whatever the name answers later; every answer of the name is checked', { skip: process.platform !== 'linux' && 'only Linux answers on all of 127/8' }, async () => {
  const rx = await receiver(() => [200], '127.0.0.3');
  try {
    const port = new URL(rx.url).port;
    let asked = 0;
    const lookup = async () => (asked++ === 0 ? [{ address: '127.0.0.3', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]);
    const r = await deliverOnce({ url: `http://localhost:${port}/in`, ownNetwork: true, secret: 'b'.repeat(64) }, '{"x":1}', { lookup });
    assert.equal(r.ok, true);
    assert.equal(asked, 1, 'the name is resolved once');
    assert.equal(rx.got[0].headers.host, `localhost:${port}`);
    const mixed = await deliverOnce({ url: 'https://hooks.example.com/in', secret: 'b'.repeat(64) }, '{}', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }] });
    assert.equal(mixed.refused, true);
  } finally {
    await rx.close();
  }
});

/** The environment without any proxy variable of its own (the test sets the ones it means). */
const withoutProxy = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(https?_proxy|no_proxy|all_proxy)$/i.test(k)));

test('proxy variables of the environment are not used', async () => {
  const proxy = await receiver();
  const rx = await receiver();
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'deliver-once.mjs'), rx.url], {
      env: { ...withoutProxy(process.env), NODE_USE_ENV_PROXY: '1', HTTP_PROXY: new URL(proxy.url).origin, HTTPS_PROXY: new URL(proxy.url).origin, http_proxy: new URL(proxy.url).origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errText = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (errText += c));
    await new Promise((r) => child.on('close', r));
    assert.ok(out, `the child printed nothing: ${errText.slice(0, 600)}`);
    assert.equal(JSON.parse(out).ok, true, out);
    assert.equal(proxy.got.length, 0, 'nothing went through the proxy');
    assert.equal(rx.got.length, 1);
  } finally {
    await proxy.close();
    await rx.close();
  }
});

test('a webhook made while another token has one hears nothing of what happened before it was made', async () => {
  const rx = await receiver();
  const a = access.createWorkToken('First app');
  const b = access.createWorkToken('Second app');
  access.addWebhook({ token: a.id, url: `${rx.url}?a`, events: ['done', 'result', 'needs-you'], ownNetwork: true });
  const h = hooksOf();
  try {
    const old = (await store().addFrom({ title: 'Second old task' }, { token: b.id, name: 'Second app' })).item;
    finishRun(old, 'done', 'old answer from last week');
    const cur = store().list().items.find((x) => x.id === old.id);
    await store().status({ id: old.id, at: cur.at }, 'done');
    h.start(); // looks with the first token's webhook only
    await h.idle();
    access.addWebhook({ token: b.id, url: `${rx.url}?b`, events: ['done', 'result', 'needs-you'], ownNetwork: true, answer: true });
    h.poke(); // what the route does after a webhook is made
    await h.idle();
    assert.deepEqual(rx.got.map((x) => x.body), [], 'nothing changed: nothing is sent');
    const now = store().list().items.find((x) => x.id === old.id);
    await store().status({ id: old.id, at: now.at }, 'waiting');
    h.look();
    await h.idle();
    assert.deepEqual(rx.got.map((x) => [x.url, JSON.parse(x.body).event]), [['/in?b', 'needs-you']], 'what changes after it was made is sent');
  } finally {
    h.close();
    access.revokeWorkToken(a.id);
    access.revokeWorkToken(b.id);
    await rx.close();
  }
});

test('a webhook removed, or its token revoked, gets no more tries of what was queued for it', async () => {
  const rx = await receiver(() => [500]);
  const a = access.createWorkToken('Gone app');
  access.addWebhook({ token: a.id, url: rx.url, events: ['done'], ownNetwork: true });
  const h = hooksOf({ waits: [0, 400, 800] });
  try {
    const it = (await store().addFrom({ title: 'Gone task' }, { token: a.id, name: 'Gone app' })).item;
    h.start();
    const cur = store().list().items.find((x) => x.id === it.id);
    await store().status({ id: it.id, at: cur.at }, 'done');
    h.look();
    await until('the first try', () => rx.got.length === 1);
    access.revokeWorkToken(a.id); // what the Revoke route does: the token and its webhooks go, then a poke
    h.poke();
    const t0 = Date.now();
    await h.idle();
    assert.ok(Date.now() - t0 < 300, 'the waiting tries end at once');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(rx.got.length, 1, 'no try after the revoke');
  } finally {
    h.close();
    await rx.close();
  }
});

test('a look reads each run file once, not once per watched task, and looks never run back to back', async () => {
  const a = access.createWorkToken('Busy app');
  access.addWebhook({ token: a.id, url: 'http://127.0.0.1:9/in', events: ['result'], ownNetwork: true });
  const h = hooksOf();
  const realRead = fs.readFileSync;
  let reads = 0;
  try {
    for (let i = 0; i < 20; i++) await store().addFrom({ title: `Busy task ${i}` }, { token: a.id, name: 'Busy app' });
    const other = (await store().add({ title: 'Owner task with many runs' })).item;
    for (let i = 0; i < 60; i++) finishRun(other, 'failed', '');
    fs.readFileSync = function (f, ...rest) {
      if (String(f).includes(`${path.sep}runs${path.sep}`)) reads++;
      return realRead.call(this, f, ...rest);
    };
    const files = fs.readdirSync(path.join(place().folder, 'runs')).filter((n) => n.endsWith('.json')).length;
    h.look();
    assert.ok(reads <= files, `the first look read ${reads} run files for ${files} runs and 20 watched tasks`);
    reads = 0;
    h.look();
    assert.equal(reads, 0, 'a run file that did not change is not read again');
  } finally {
    fs.readFileSync = realRead;
    h.close();
    access.revokeWorkToken(a.id);
  }
  // A look slower than the wait between looks: the next one still waits its full time after it.
  const b = access.createWorkToken('Slow look app');
  access.addWebhook({ token: b.id, url: 'http://127.0.0.1:9/in', events: ['result'], ownNetwork: true });
  const times = [];
  const slow = workHooks({
    log: () => {}, waits: [0], lookEvery: 30,
    place: () => {
      const start = Date.now();
      while (Date.now() - start < 60) { /* a look that takes 60 ms */ }
      times.push([start, Date.now()]);
      return place();
    },
  });
  try {
    slow.start();
    await until('five looks', () => times.length >= 5, 5000);
    for (let i = 1; i < times.length; i++) assert.ok(times[i][0] - times[i - 1][1] >= 25, `look ${i} began ${times[i][0] - times[i - 1][1]} ms after the one before ended`);
  } finally {
    slow.close();
    access.revokeWorkToken(b.id);
  }
});

test.after(() => t.cleanup());

/**
 * A token with a webhook ("send the answer too") and a task of it that is done, with a done run, all before the first
 * look. → { said, close }: said() looks once and returns what was sent ("event" or "event answer").
 */
async function toldOnce(title) {
  const rx = await receiver();
  const a = access.createWorkToken(`${title} app`);
  access.addWebhook({ token: a.id, url: rx.url, events: ['done', 'result', 'needs-you'], ownNetwork: true, answer: true });
  const h = hooksOf({ waits: [0] });
  const item = (await store().addFrom({ title }, { token: a.id, name: `${title} app` })).item;
  finishRun(item, 'done', 'old answer from last week');
  await store().status({ id: item.id, at: store().list().items.find((x) => x.id === item.id).at }, 'done');
  h.start();
  await h.idle();
  const said = async () => {
    h.look();
    await h.idle();
    return rx.got.splice(0).map((x) => { const b = JSON.parse(x.body); return b.answer ? `${b.event} ${b.answer}` : b.event; });
  };
  assert.deepEqual(await said(), [], 'the first look only takes note, and the next one sees nothing new');
  return { item, token: a, said, close: async () => (h.close(), access.revokeWorkToken(a.id), rx.close()) };
}

test('a task out of the Work file for one look, then back as it was, is not told again', async () => {
  const w = await toldOnce('Replay task gone');
  try {
    const file = place().file;
    const full = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{\n  "items": []\n}\n'); // a removal undone later, a revert
    assert.deepEqual(await w.said(), []);
    fs.writeFileSync(file, full);
    assert.deepEqual(await w.said(), [], 'nothing changed: nothing is sent');
    finishRun(w.item, 'done', 'a new answer');
    assert.deepEqual(await w.said(), ['result a new answer'], 'what happens after is told');
    assert.deepEqual(await w.said(), [], 'once');
  } finally {
    await w.close();
  }
});

test('the runs folder unreadable for one look, then back, tells no run again', async () => {
  const w = await toldOnce('Replay runs away');
  const runs = path.join(place().folder, 'runs');
  try {
    fs.renameSync(runs, `${runs}.away`);
    fs.symlinkSync(`${runs}.away`, runs); // Work leaves a runs folder that is a link alone
    assert.deepEqual(await w.said(), []);
    fs.unlinkSync(runs);
    fs.renameSync(`${runs}.away`, runs);
    assert.deepEqual(await w.said(), [], 'the runs back: nothing is sent');
  } finally {
    if (fs.lstatSync(runs, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(runs);
      fs.renameSync(`${runs}.away`, runs);
    }
    await w.close();
  }
});

test('Work moved to another project and back tells nothing again; a task added since counts from open', async () => {
  const w = await toldOnce('Replay place moved');
  const kiosk = path.join(t.projects, 'kiosk');
  if (!fs.existsSync(kiosk)) t.repo(kiosk, { 'README.md': '# kiosk\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
  try {
    cfg.work.project = 'kiosk';
    saveConfig(cfg);
    assert.deepEqual(await w.said(), []);
    cfg.work.project = 'shop';
    saveConfig(cfg);
    assert.deepEqual(await w.said(), [], 'Work back where it was: nothing is sent');
    const fresh = (await store().addFrom({ title: 'Replay task added later' }, { token: w.token.id, name: 'Replay app' })).item;
    await store().status({ id: fresh.id, at: store().list().items.find((x) => x.id === fresh.id).at }, 'done');
    assert.deepEqual(await w.said(), ['done'], 'a task added after the first look is told');
  } finally {
    cfg.work.project = 'shop';
    saveConfig(cfg);
    await w.close();
  }
});

/** The runs folder made unreadable (`how`: "link", a folder Work leaves alone, or "mode", no permission); → put it back. */
function runsAway(how) {
  const runs = path.join(place().folder, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  if (how === 'mode') {
    fs.chmodSync(runs, 0);
    return () => fs.chmodSync(runs, 0o755);
  }
  fs.renameSync(runs, `${runs}.away`);
  fs.symlinkSync(`${runs}.away`, runs);
  return () => {
    fs.unlinkSync(runs);
    fs.renameSync(`${runs}.away`, runs);
  };
}
const eventsOf = (rx) => rx.got.splice(0).map((x) => { const b = JSON.parse(x.body); return b.answer ? `${b.event} ${b.answer}` : b.event; });

for (const how of ['link', 'mode']) {
  test(`a runs folder that cannot be read from the start (${how}) does not silence a webhook: "done" is told, and Activity says so once without a path`, { skip: how === 'mode' && process.getuid?.() === 0 && 'root reads every folder' }, async () => {
    const rx = await receiver();
    const name = `Unreadable runs ${how} app`;
    const a = access.createWorkToken(name);
    access.addWebhook({ token: a.id, url: rx.url, events: ['done', 'result', 'needs-you'], ownNetwork: true });
    const back = runsAway(how);
    const before = activity();
    const h = hooksOf({ waits: [0] });
    try {
      h.start();
      await h.idle();
      const item = (await store().addFrom({ title: `Unreadable runs ${how}` }, { token: a.id, name })).item;
      h.look();
      await h.idle();
      await store().status({ id: item.id, at: store().list().items.find((x) => x.id === item.id).at }, 'done');
      h.look();
      await h.idle();
      assert.deepEqual(eventsOf(rx), ['done'], 'the task\'s own status does not wait for its runs');
      const said = activity().slice(before.length);
      assert.equal((said.match(/the runs folder of Work could not be read/g) || []).length, 1, said);
      assert.ok(!said.includes(place().folder) && !said.includes(t.root), `no path in Activity: ${said}`);
    } finally {
      back();
      h.close();
      access.revokeWorkToken(a.id);
      await rx.close();
    }
  });
}

test('a runs folder that becomes readable later: a run that ended before is not told; one that ends after is', async () => {
  const rx = await receiver();
  const a = access.createWorkToken('Runs later app');
  const item = (await store().addFrom({ title: 'Runs later' }, { token: a.id, name: 'Runs later app' })).item;
  finishRun(item, 'done', 'old answer'); // ended before anything looked
  access.addWebhook({ token: a.id, url: rx.url, events: ['done', 'result', 'needs-you'], ownNetwork: true, answer: true });
  let back = runsAway('link');
  const h = hooksOf({ waits: [0] });
  try {
    h.start();
    await h.idle();
    h.look();
    await h.idle();
    back();
    back = null;
    h.look();
    await h.idle();
    assert.deepEqual(eventsOf(rx), [], 'the run that ended before is put aside, not told as a result');
    finishRun(item, 'done', 'new answer');
    h.look();
    await h.idle();
    assert.deepEqual(eventsOf(rx), ['result new answer']);
  } finally {
    if (back) back();
    h.close();
    access.revokeWorkToken(a.id);
    await rx.close();
  }
});
