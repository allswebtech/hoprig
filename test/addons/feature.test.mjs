// Settings → Add-ons on the server: list with state, actions as background jobs with live output, one job at a
// time per add-on, and "set up as an account" as a terminal session (the key never goes through the page).
import assert from 'node:assert/strict';
import os from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import { addonsFeature } from '../../src/addons/feature.mjs';

function fakeAddon() {
  const a = {
    id: 'gw', title: 'Gateway', summary: 'A gateway.', homepage: 'https://example.invalid',
    state: { installed: false, version: null, running: false, url: 'http://localhost:1' },
    release: null,
    async status() { return { ...a.state }; },
    async install({ onLine }) {
      onLine('fetching…');
      await new Promise((r) => (a.release = r));
      onLine('installed');
      a.state.installed = true;
      return { ok: true };
    },
    async update({ onLine }) { onLine('up to date'); return { ok: true }; },
    async start() { a.state.running = true; return { ok: true, url: a.state.url }; },
    async stop() { a.state.running = false; return { ok: true }; },
  };
  return a;
}

function harness() {
  const created = [];
  const sctx = {
    readJson: async (req) => { for await (const _ of req) { /* drain */ } return {}; },
    backend: { list: async () => [{ session: 'setup-gw' }], create: async (o) => { created.push(o); return { name: o.name }; } },
    deck: { launcher: () => ['node', '/app/bin/hoprig.mjs'] },
    config: () => ({ server: { roots: [os.tmpdir()] } }),
  };
  const addon = fakeAddon();
  const f = addonsFeature(sctx, { addons: [addon] });
  const call = async (method, p) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Readable.from([]), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  return { f, addon, call, created };
}

const settle = () => new Promise((r) => setImmediate(r));

test('add-ons: state, an install with live output, one job at a time', async () => {
  const { addon, call } = harness();
  let list = (await call('GET', '/api/addons')).addons;
  assert.deepEqual(list.map((a) => [a.id, a.installed, a.running, a.job]), [['gw', false, false, null]]);
  assert.deepEqual(await call('POST', '/api/addons/gw/install'), { started: true });
  await settle();
  await assert.rejects(call('POST', '/api/addons/gw/update'), (e) => e.status === 409 && /busy/.test(e.message));
  let job = await call('GET', '/api/addons/gw/job?from=0');
  assert.deepEqual([job.running, job.lines], [true, ['fetching…']]);
  addon.release();
  await settle();
  await settle();
  job = await call('GET', `/api/addons/gw/job?from=${job.next}`);
  assert.deepEqual([job.running, job.lines, job.result.ok], [false, ['installed'], true]);
  await call('POST', '/api/addons/gw/start');
  await settle();
  list = (await call('GET', '/api/addons')).addons;
  assert.equal(list[0].running, true);
  await call('POST', '/api/addons/gw/stop');
  await settle();
  assert.equal((await call('GET', '/api/addons')).addons[0].running, false);
});

test('add-ons: unknown add-on or action; no terminal route (a provider is made on the Providers page)', async () => {
  const { call, created } = harness();
  await assert.rejects(call('POST', '/api/addons/nope/start'), (e) => e.status === 404);
  await assert.rejects(call('GET', '/api/addons/nope/job'), (e) => e.status === 404);
  await assert.rejects(call('POST', '/api/addons/gw/uninstall'), /no route/);
  await assert.rejects(call('POST', '/api/addons/gw/setup'), /no route/);
  assert.deepEqual(created, []);
});

test('add-ons: a failing action is reported, not thrown', async () => {
  const { addon, call } = harness();
  addon.start = async () => ({ ok: false, error: 'it is not installed' });
  await call('POST', '/api/addons/gw/start');
  await settle();
  const job = await call('GET', '/api/addons/gw/job');
  assert.deepEqual([job.result.ok, job.result.error, job.lines], [false, 'it is not installed', ['it is not installed']]);
});

test('add-ons: an add-on\'s own actions run as a job with the body; a question comes back as `confirm`', async () => {
  const { addon, call } = harness();
  const seen = [];
  addon.actions = {
    'ask-first': async (body, { onLine }) => {
      seen.push(body);
      onLine('looking');
      return body.confirmed ? { ok: true, url: 'https://x.example.com' } : { ok: false, confirm: 'It has no sign-in page of its own.' };
    },
  };
  // The body is what the page sent (readJson in this harness answers {}).
  assert.deepEqual(await call('POST', '/api/addons/gw/do/ask-first'), { started: true });
  await settle();
  let job = await call('GET', '/api/addons/gw/job');
  assert.deepEqual([job.result.ok, job.result.confirm, job.lines], [false, 'It has no sign-in page of its own.', ['looking']]);
  await assert.rejects(call('POST', '/api/addons/gw/do/nope'), (e) => e.status === 404);
  await assert.rejects(call('POST', '/api/addons/gw/do/constructor'), (e) => e.status === 404, 'only its own actions, not inherited names');
  await assert.rejects(call('POST', '/api/addons/gw/do/BAD_NAME'), /no route/);
  assert.deepEqual(seen, [{}]);
  delete addon.actions;
  await assert.rejects(call('POST', '/api/addons/gw/do/ask-first'), (e) => e.status === 404);
  job = await call('GET', '/api/addons/gw/job');
  assert.equal(job.running, false);
});

test('add-ons: attach() when the dashboard starts, detach() when it stops; one that throws does not stop the others', async () => {
  const { addon, f } = harness();
  const log = [];
  addon.attach = () => log.push('attach');
  addon.detach = async () => log.push('detach');
  f.start();
  await settle();
  await f.close();
  assert.deepEqual(log, ['attach', 'detach']);
  addon.attach = () => { throw new Error('boom'); };
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    f.start();
    await settle();
  } finally {
    console.error = orig;
  }
  assert.deepEqual(errors, ['add-on gw: boom']);
});

test('add-ons: an add-on is named by its own plain spelling only (an encoded one is no add-on)', async () => {
  const { addon, call } = harness();
  for (const p of ['/api/addons/g%77/start', '/api/addons/%67w/start', '/api/addons/g%2577/start']) await assert.rejects(call('POST', p), (e) => e.status === 404, p);
  await assert.rejects(call('GET', '/api/addons/g%77/job'), (e) => e.status === 404);
  await settle();
  assert.equal(addon.state.running, false, 'nothing was started');
});

test('add-ons: one whose parts build a helper carries that line and its install command to the page (its Install confirmation)', async () => {
  const { addon, call } = harness();
  addon.builds = 'Two of its parts (alpha, beta) build a helper program each on this computer while it installs.';
  addon.installHint = () => 'npm install -g --allow-scripts=alpha,beta --loglevel=error example-gw';
  const [a] = (await call('GET', '/api/addons')).addons;
  assert.equal(a.builds, addon.builds);
  assert.equal(a.installCommand, 'npm install -g --allow-scripts=alpha,beta --loglevel=error example-gw');
  // One that builds nothing carries neither: the page installs it without a question, as before.
  delete addon.builds;
  const [b] = (await call('GET', '/api/addons')).addons;
  assert.equal('builds' in b, false);
  assert.equal('installCommand' in b, false);
});

test('a gateway\'s install and update are the owner\'s press, checked on the server; start and stop are as before', async () => {
  const done = [];
  const gw = { id: 'relay', title: 'Relay', gateway: { port: () => 9 }, status: async () => ({ installed: true, running: false }),
    install: async () => (done.push('install'), { ok: true }), update: async () => (done.push('update'), { ok: true }), start: async () => (done.push('start'), { ok: true }), stop: async () => (done.push('stop'), { ok: true }) };
  const make = (caller, card = null) => addonsFeature({ readJson: async (req) => req.body || {}, caller: () => caller, ownerCard: () => card, config: () => ({ server: { roots: [os.tmpdir()] } }) }, { addons: [gw], computer: () => 'box2' });
  const post = (f, action, body) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test(`/api/addons/relay/${action}`));
    return fn({ body, headers: {} }, re.exec(`/api/addons/relay/${action}`));
  };
  assert.equal((await make('page').routes.find(([m, r]) => m === 'GET' && r.test('/api/addons'))[2]({})).computer, 'box2', 'the page learns the name it sends');
  for (const action of ['install', 'update']) {
    for (const body of [{}, { confirm: 'box3' }]) await assert.rejects(post(make('page'), action, body), (e) => e.status === 400 && e.details.code === 'confirm', `${action} ${JSON.stringify(body)}`);
    await assert.rejects(post(make('self'), action, { confirm: 'box2' }), (e) => e.status === 403, `${action}: Tia on her own`);
    await assert.rejects(post(make('self', { tool: 'manage_computer', input: { action: 'addon', addon: 'relay', addon_action: action === 'install' ? 'update' : 'install' } }), action, { confirm: 'box2' }), (e) => e.status === 403, `${action}: a card for the other act`);
  }
  await settle();
  assert.deepEqual(done, [], 'nothing ran');
  const { gatewayBusy } = await import('../../src/addons/gatewayhost.mjs');
  const idle = async () => { for (let i = 0; i < 50 && gatewayBusy('relay'); i++) await settle(); };
  assert.deepEqual(await post(make('page'), 'install', { confirm: 'box2' }), { started: true });
  await idle();
  assert.deepEqual(await post(make('self', { tool: 'manage_computer', input: { action: 'addon', addon: 'relay', addon_action: 'update' } }), 'update', { confirm: 'box2' }), { started: true }, 'his confirmed card');
  await idle();
  for (const act of ['start', 'stop']) await assert.rejects(post(make('self'), act, {}), (e) => e.status === 403 && e.details.code === 'owner-only', `${act}: Tia on her own`);
  assert.deepEqual(await post(make('page'), 'start', {}), { started: true }, 'his own press of start needs no name');
  await idle();
  assert.deepEqual(await post(make('self', { tool: 'manage_computer', input: { action: 'addon', addon: 'relay', addon_action: 'start' } }), 'start', {}), { started: true }, 'his confirmed card');
  for (let i = 0; i < 20 && done.length < 4; i++) await settle();
  assert.deepEqual(done, ['install', 'update', 'start', 'start']);
});

test('a gateway\'s Remove is the owner\'s press naming the computer; a gateway with nothing to remove has no route; its answer is in the job', async () => {
  const done = [];
  const gw = { id: 'relay', title: 'Relay', gateway: { port: () => 9 }, status: async () => ({ installed: true, running: false }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
    remove: async ({ onLine }) => (done.push('remove'), onLine('It was removed. Its data was kept.'), { ok: true, said: 'It was removed. Its data was kept.' }) };
  const plain = { id: 'plain', title: 'Plain', gateway: { port: () => 9 }, status: async () => ({ installed: true, running: false }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) };
  const make = (caller, card = null) => addonsFeature({ readJson: async (req) => req.body || {}, caller: () => caller, ownerCard: () => card, config: () => ({ server: { roots: [os.tmpdir()] } }) }, { addons: [gw, plain], computer: () => 'box2' });
  const post = (f, id, action, body) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === 'POST' && r.test(`/api/addons/${id}/${action}`));
    return fn({ body, headers: {} }, re.exec(`/api/addons/${id}/${action}`));
  };
  for (const body of [{}, { confirm: 'box3' }]) await assert.rejects(post(make('page'), 'relay', 'remove', body), (e) => e.status === 400 && e.details.code === 'confirm', JSON.stringify(body));
  await assert.rejects(post(make('self'), 'relay', 'remove', { confirm: 'box2' }), (e) => e.status === 403, 'Tia on her own');
  await assert.rejects(post(make('page'), 'plain', 'remove', { confirm: 'box2' }), (e) => e.status === 404);
  assert.deepEqual(done, []);
  const f = make('page');
  assert.deepEqual(await post(f, 'relay', 'remove', { confirm: 'box2' }), { started: true });
  for (let i = 0; i < 20 && !done.length; i++) await settle();
  await settle();
  const [, re, job] = f.routes.find(([m, r]) => m === 'GET' && r.test('/api/addons/relay/job'));
  const j = await job({ headers: {} }, re.exec('/api/addons/relay/job'), new URLSearchParams());
  assert.deepEqual(j.lines, ['It was removed. Its data was kept.']);
  assert.equal(j.result.ok, true);
});
