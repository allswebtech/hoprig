// Drop of a task and the branch of its Do it runs (src/work/feature.mjs, POST /api/work/items/<id>/status): the owner's
// own drop removes a branch with no work of its own, a drop through Tia's door (her card does not say it) removes
// nothing. The Work feature on a temporary computer with a stand-in chat; nothing reaches a network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-dropbranch-door');
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { workFeature } = await import('../../src/work/feature.mjs');
const { readRun } = await import('../../src/work/runs.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');

t.repo(t.brain, { 'README.md': '# brain\n' });
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n' });
// The allowed folders hold the state folder, so a run gets a branch of its own.
const cfg = { server: { roots: [t.root] }, work: { ownerId: 'alex' } };
saveConfig(cfg);
writeProfile('sub', { label: 'Main' });

const chats = new Map();
const chat = {
  async open() {
    const id = crypto.randomUUID();
    chats.set(id, { busy: true, lastEnd: null, lastText: '', fns: [] });
    return { sent: true, id, messageId: crypto.randomUUID() };
  },
  peek(id) {
    const c = chats.get(id);
    return c ? { busy: c.busy, pending: false, lastEnd: c.lastEnd, lastText: c.lastText, conversationId: 'conv1' } : null;
  },
  follow(id, fn) {
    chats.get(id).fns.push(fn);
    return () => {};
  },
  turnEnd: () => null,
  end(id) {
    const c = chats.get(id);
    Object.assign(c, { busy: false, lastEnd: 'ok', lastText: 'Nothing to change.' });
    for (const f of c.fns) f(this.peek(id));
  },
};

// Who sends a request is the server's own word (server.mjs ctx.caller): 'self' is Tia's door, 'page' the owner.
let caller = 'page';
const body = new WeakMap();
const f = workFeature({
  config: () => cfg, defaultProvider: async () => 'sub', caller: () => caller, notify: () => {}, clientIp: () => '127.0.0.1',
  readJson: async (req) => body.get(req) || {},
}, { chat });
f.start();
test.after(async () => {
  await f.close();
  t.cleanup();
});

async function call(method, p, b, by = 'page', q = new URLSearchParams()) {
  const route = f.routes.find(([m, re]) => m === method && re.test(p));
  assert.ok(route, `${method} ${p}`);
  const req = Readable.from([]);
  Object.assign(req, { method, url: p, headers: { host: '127.0.0.1' } });
  body.set(req, b);
  caller = by;
  try {
    return await route[2](req, route[1].exec(p), q);
  } finally {
    caller = 'page';
  }
}
const atOf = async (id) => (await call('GET', '/api/work')).items.find((i) => i.id === id).at;
const hasBranch = (b) => t.git(shop, 'branch', '--list', b) !== '';
const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A task of shop whose Do it run ended on its own branch with no commit of its own. → its id */
async function ranOnBranch(title) {
  const id = (await call('POST', '/api/work/items', { title, project: 'shop' })).item.id;
  const plan = await call('GET', `/api/work/items/${id}/do`, undefined, 'page', new URLSearchParams({ at: String(await atOf(id)) }));
  const { run } = await call('POST', `/api/work/items/${id}/do`, { at: await atOf(id), seen: plan.brief });
  assert.equal(run.branch, `work/${id}`);
  chat.end(run.session);
  await until(`run ${run.id} to end`, () => {
    const r = readRun(resolvePlace(cfg), run.id);
    return r && r.state !== 'running';
  });
  assert.ok(hasBranch(`work/${id}`));
  return id;
}

test('a drop through Tia\'s door keeps the branch of its Do it runs; the owner\'s own drop removes it', async () => {
  const hers = await ranOnBranch('Look at the cart');
  const viaHer = await call('POST', `/api/work/items/${hers}/status`, { at: await atOf(hers), status: 'dropped' }, 'self');
  assert.equal(viaHer.item.status, 'dropped');
  assert.equal(viaHer.branch, undefined, 'nothing said of a branch: nothing was removed');
  assert.ok(hasBranch(`work/${hers}`), 'her drop removes no branch');

  const his = await ranOnBranch('Look at the styles');
  const own = await call('POST', `/api/work/items/${his}/status`, { at: await atOf(his), status: 'dropped' });
  assert.deepEqual(own.branch, { removed: true, branch: `work/${his}` });
  assert.equal(hasBranch(`work/${his}`), false);
});
