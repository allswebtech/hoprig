// His chosen subscription is at its limit while another subscription he has can answer now: the line says which one
// can, the readiness has a code of its own ("chosen-limited", not "every subscription is at its limit"), so the banner
// keeps its way to Settings, and her notice offers "Use <the free one>". Nothing moves to a provider billed by use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import * as feature from '../../src/assistant/feature.mjs';

const HOUR = 3600_000;
const sub = (name, extra = {}) => ({ name, label: `Plan ${name}`, kind: 'subscription', tools: ['claude'], ...extra });

test('the line names the subscription that can answer now, and only when there is one', () => {
  const now = Date.now();
  const acc = { profiles: [sub('max'), sub('team')] };
  const said = feature.chosenLimitedLine({ name: 'max', until: now + 2 * HOUR }, acc, now, { free: 'team' });
  assert.match(said, /^Plan max, which Tia runs on, has reached its limit, so she cannot answer now\. It can be used again at \d\d:\d\d( on \w{3},? \d{1,2} \w{3})?\. Plan team can answer now\. Tia does not move to a paid provider by herself\.$/);
  assert.doesNotMatch(feature.chosenLimitedLine({ name: 'max', until: now + HOUR }, acc, now), /can answer now/);
});

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('on the dashboard: a code of its own, the free one offered, her engine not started', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-in is POSIX' }, async (t) => {
  const box = sandbox('tia-chosen-offer');
  const mark = path.join(box.root, 'engine-started');
  const engine = path.join(box.root, 'engine.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'started\\n');\nprocess.exit(1);\n`);
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { markLimited } = await import('../../src/autoswitch.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ ...loadConfig(), usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, runsOn: 'max' } });
  writeProfile('max', { label: 'Plan max', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-1' } });
  writeProfile('team', { label: 'Plan team', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up-2' } });
  writeProfile('api', { label: 'Key', env: { ANTHROPIC_API_KEY: 'sk-made-up' } });
  markLimited('max', { until: Date.now() + 2 * HOUR });
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false, dashboardFile: false, assistant: { engine: { command: { command: process.execPath, args: [engine] }, resolveEnv: async () => ({ ...process.env }) } } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  app.features.find((f) => f.name === 'assistant').setAddress(base);
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const login = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const o = (await request(base, 'GET', '/api/assistant', { headers: { Cookie: login } })).json;
  assert.equal(o.ready.ok, false);
  assert.equal(o.ready.code, 'chosen-limited', `the code ${o.ready.code} says every subscription is at its limit`);
  assert.deepEqual(o.ready.offer, { name: 'team', label: 'Plan team' });
  assert.match(o.ready.problem, /Plan team can answer now\./);
  const r = await request(base, 'POST', '/api/assistant/chat', { body: { text: 'What runs now?' }, headers: { Cookie: login } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let notice = null;
  for (let i = 0; i < 60 && !notice; i++) {
    await new Promise((res) => setTimeout(res, 100));
    notice = (await request(base, 'GET', `/api/assistant/chat/${r.json.conversation}?from=0`, { headers: { Cookie: login } })).json.events.find((e) => e.kind === 'notice');
  }
  assert.ok(notice, 'no notice came');
  assert.equal(notice.code, 'chosen-limited');
  assert.equal(notice.origin, 'owner');
  assert.deepEqual(notice.use, { name: 'team', label: 'Plan team' });
  assert.equal(fs.existsSync(mark), false, 'her engine started');
});

// The page: the banner keeps its way to Settings for this code; the notice draws "Use Plan team" and no paid-use link.
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], on: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.on[k] = fn;
  }
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}

test('the page: a Settings link in the banner, "Use Plan team" in the notice, nothing about paid use', async () => {
  globalThis.Node ??= FakeNode;
  globalThis.document ??= {
    createElement: (t) => new FakeElement(t),
    createElementNS: (ns, t) => new FakeElement(t),
    createTextNode: (t) => ({ text: t }),
    getElementById: () => null,
    addEventListener: () => {},
    visibilityState: 'visible',
  };
  assert.ok(fs.existsSync(path.join(WEB, 'tia.js')));
  const tia = await import('../../web/tia.js');
  assert.equal(tia.bannerLink({ ok: false, code: 'chosen-limited', problem: 'x' }).attrs.href, '#/settings/tia');
  assert.equal(tia.bannerLink({ ok: false, code: 'subs-limited', problem: 'x' }), null);
  const words = (el) => (el && typeof el === 'object' ? [el.text || '', el.attrs?.['aria-label'] || '', ...(el.children || []).flatMap(words)] : [String(el ?? '')]);
  const all = (el) => [el, ...(el.children || []).flatMap((c) => (c instanceof FakeElement ? all(c) : []))];
  const v = tia.noticeView({ kind: 'notice', code: 'chosen-limited', origin: 'owner', text: 'Plan max has reached its limit.', use: { name: 'team', label: 'Plan team' } }, { resend: () => {} });
  const els = all(v);
  assert.ok(els.some((e) => e.tag === 'button' && /\btia-notice-use\b/.test(e.className)), 'no "Use Plan team" button');
  assert.ok(words(v).join(' ').includes('Use Plan team'));
  assert.doesNotMatch(words(v).join(' '), /paid use/, 'a link about paid use where nothing is paid');
  assert.ok(els.some((e) => e.tag === 'a' && e.attrs.href === '#/settings/tia'), 'no way to Settings');
});
