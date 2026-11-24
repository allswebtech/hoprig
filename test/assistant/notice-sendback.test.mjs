// After the Save under the daily limit he was sent to from her notice, one button takes him back to her chat and sends
// his message again (web/tia.js backOf, capLinkFor, sendBack). The chat route sends a notice's message again ONCE
// (`again`: the notice's number): two pages that press at the same moment send it once, and a later press says so.
// Her provider is billed by use with no limit set, so every turn ends in a notice and no model is ever called.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a notice\'s message is sent again once, also when two pages press at the same moment', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-in is POSIX' }, async (t) => {
  const box = sandbox('tia-sendback');
  const mark = path.join(box.root, 'engine-started');
  const engine = path.join(box.root, 'engine.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'started\\n');\nprocess.exit(1);\n`);
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'work', accounts: ['api'], runsOn: 'api', dailyCapUsd: null } });
  writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false, dashboardFile: false, assistant: { engine: { command: { command: process.execPath, args: [engine] }, resolveEnv: async () => ({ ...process.env }) } } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  app.features.find((f) => f.name === 'assistant').setAddress(base);
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const post = (body) => request(base, 'POST', '/api/assistant/chat', { body, headers: { Cookie: cookie } });
  const events = async (id) => (await request(base, 'GET', `/api/assistant/chat/${id}?from=0`, { headers: { Cookie: cookie } })).json.events;
  const notices = async (id, n) => {
    for (let i = 0; i < 60; i++) {
      const e = (await events(id)).filter((x) => x.kind === 'notice');
      if (e.length >= n) return e;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('no notice came');
  };

  const first = await post({ text: 'What runs now?' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const id = first.json.conversation;
  const [n] = await notices(id, 1);
  assert.equal(n.code, 'paid-no-cap');
  assert.equal(n.origin, 'owner');

  // Two pages press at the same moment: one sends, the other is told it was sent already.
  const both = await Promise.all([post({ conversation: id, again: n.i }), post({ conversation: id, again: n.i })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.json)));
  assert.equal(both.find((r) => r.status === 409).json.code, 'sent-already');
  await notices(id, 2);
  const owner = (await events(id)).filter((x) => x.kind === 'owner');
  assert.deepEqual(owner.map((x) => x.text), ['What runs now?', 'What runs now?'], 'his message is sent again once, as he wrote it');
  // A later press of the same notice sends nothing.
  const late = await post({ conversation: id, again: n.i });
  assert.equal(late.status, 409);
  assert.equal((await events(id)).filter((x) => x.kind === 'owner').length, 2);
  // Only a notice of his own message, in this conversation.
  assert.equal((await post({ conversation: id, again: 9999 })).status, 404);
  assert.equal((await post({ conversation: id, again: -1 })).status, 400);
  assert.equal(fs.existsSync(mark), false, 'her engine started: a request would have reached the provider');
});

test('the page: the cap link names the notice, the Save offers the way back, one press sends once and opens her chat', async () => {
  class FakeNode {}
  class FakeElement extends FakeNode {
    constructor(tag) {
      super();
      Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    addEventListener() {}
    append(...x) {
      this.children.push(...x);
    }
    replaceChildren(...x) {
      this.children = x;
    }
  }
  globalThis.Node ??= FakeNode;
  globalThis.document ??= {
    createElement: (tg) => new FakeElement(tg),
    createElementNS: (ns, tg) => new FakeElement(tg),
    createTextNode: (x) => ({ text: x }),
    getElementById: () => null,
    addEventListener: () => {},
    visibilityState: 'visible',
  };
  const tia = await import('../../web/tia.js');
  assert.equal(typeof tia.backOf, 'function', 'the Save has no way back to her chat');
  assert.equal(tia.capLinkFor('t1abc.4'), '#/settings/tia?show=tia-daily-cap&back=t1abc.4');
  assert.equal(tia.capLinkFor(null), tia.CAP_LINK);
  assert.equal(tia.capLinkFor('../x'), tia.CAP_LINK, 'only the plain shape is put into an address');
  assert.equal(tia.capSaveWanted(tia.capLinkFor('t1abc.4')), true, 'the field still shows its own Save');
  assert.deepEqual(tia.backOf('#/settings/tia?show=tia-daily-cap&back=t1abc.4'), { conversation: 't1abc', again: 4 });
  assert.equal(tia.backOf('#/settings/tia?show=tia-daily-cap'), null);
  assert.equal(tia.backOf('#/settings/tia?back=<x>.1'), null);
  const seen = [];
  const said = await tia.sendBack({ conversation: 't1abc', again: 4 }, { post: async (b) => seen.push(['post', b]), open: (to) => seen.push(['open', to]), remember: (c) => seen.push(['remember', c]) });
  assert.equal(said, null);
  assert.deepEqual(seen, [['post', { conversation: 't1abc', again: 4 }], ['remember', 't1abc'], ['open', '#/tia']]);
  // Sent already (another page): her chat opens all the same, with the server's sentence; nothing is sent twice.
  const twice = [];
  const err = Object.assign(new Error('This message was sent again already'), { code: 'sent-already' });
  assert.equal(await tia.sendBack({ conversation: 't1abc', again: 4 }, { post: async () => { throw err; }, open: (to) => twice.push(to), remember: () => {} }), 'This message was sent again already');
  assert.deepEqual(twice, ['#/tia']);
  // Another error: nothing opens, he can press again.
  await assert.rejects(tia.sendBack({ conversation: 't1abc', again: 4 }, { post: async () => { throw new Error('offline'); }, open: () => assert.fail('opened'), remember: () => {} }));
  // The notice his message brought links to the field with its number.
  const v = tia.noticeView({ kind: 'notice', code: 'paid-no-cap', text: 'x', origin: 'owner' }, { back: 't1abc.4' });
  const all = (el) => [el, ...(el.children || []).flatMap((c) => (c && c.tag ? all(c) : []))];
  assert.ok(all(v).some((el) => el.tag === 'a' && el.attrs.href === '#/settings/tia?show=tia-daily-cap&back=t1abc.4'));
});
