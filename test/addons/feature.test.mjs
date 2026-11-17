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
