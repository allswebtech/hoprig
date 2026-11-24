// "Tia runs on: Automatic" (the saved value null): the first subscription that can answer now, in the order of his
// providers; one at its limit is passed over. Auto mode's order only when he has no subscription at all. Every
// subscription at its limit: none, and one plain line with the time the first is usable again; never a provider billed
// by use by herself. His own choice is kept as it is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { resolveTia } from '../../src/assistant/tia.mjs';
import * as feature from '../../src/assistant/feature.mjs';
import { sandbox } from '../server/helpers.mjs';

const HOUR = 3600_000;
// Looked up on the module, so each case below fails on its own rule when the line is missing.
const subsLimitedLine = (...a) => {
  assert.equal(typeof feature.subsLimitedLine, 'function', 'there is no line for every subscription at its limit');
  return feature.subsLimitedLine(...a);
};
const sub = (name, extra = {}) => ({ name, label: `Plan ${name}`, kind: 'subscription', tools: ['claude'], ...extra });
const api = { name: 'api', label: 'Key', kind: 'api', paid: true, tools: ['claude'] };
const acc = (profiles, auto = { enabled: true, order: ['api', 'one', 'two'] }) => ({ profiles, autoSwitch: auto });

test('one subscription that can answer: she runs on it, not on Auto mode, also when Auto mode is on', () => {
  const t = resolveTia({ enabled: true }, acc([api, sub('one')]));
  assert.equal(t.runsOn, 'one');
  assert.equal(t.subsLimited, null);
});

test('several subscriptions: the first that can answer, in the order of his providers', () => {
  const t = resolveTia({}, acc([sub('alpha', { kind: 'login' }), sub('beta')]));
  assert.equal(t.runsOn, 'alpha');
});

test('the first at its limit: the next one (a limit mark, or a full plan window not reset yet)', () => {
  const now = Date.now();
  assert.equal(resolveTia({}, acc([sub('one', { limited: { until: now + HOUR } }), sub('two')])).runsOn, 'two');
  assert.equal(resolveTia({}, acc([sub('one', { usage: { fiveHour: { pct: 100, resetsAt: now + HOUR } } }), sub('two')])).runsOn, 'two');
  // A limit that has passed already does not count.
  assert.equal(resolveTia({}, acc([sub('one', { limited: { until: now - 1000 } }), sub('two')])).runsOn, 'one');
});

test('every subscription at its limit: none, with the first time one is back; never Auto mode or a paid key', () => {
  const now = Date.now();
  const at = now + 2 * HOUR;
  const t = resolveTia({}, acc([api, sub('one', { limited: { until: now + 5 * HOUR } }), sub('two', { usage: { week: { pct: 100, resetsAt: at } } })]));
  assert.equal(t.runsOn, null);
  // other: Auto mode is his by default, so the line offers the way to choose it himself (she never takes it).
  assert.deepEqual(t.subsLimited, { names: ['one', 'two'], first: 'two', until: at, other: true });
  const line = subsLimitedLine(t.subsLimited, acc([api, sub('one'), sub('two')]), now);
  // Every one by name, and the one that is back first named with its time (not "the first").
  assert.match(line, /^Plan one and Plan two have reached their limit, so Tia cannot answer now\. Plan two can be used again at \d\d:\d\d/);
  assert.match(line, /Tia does not move to a paid provider by herself\.$/);
  assert.doesNotMatch(line, /billed by use|more\)|The first/);
  const three = subsLimitedLine({ names: ['one', 'two', 'three'], first: 'three', until: at }, acc([sub('one'), sub('two'), sub('three')]), now);
  assert.match(three, /^Plan one, Plan two and Plan three have reached their limit, .* Plan three can be used again at /);
  // No time known: the line says so plainly.
  const none = resolveTia({}, acc([sub('one', { limited: { until: null } })]));
  assert.deepEqual(none.subsLimited, { names: ['one'], first: null, until: null, other: true });
  assert.match(subsLimitedLine(none.subsLimited, acc([sub('one')]), now), /^Plan one has reached its limit, .* Hoprig does not know yet when one can be used again\./);
});

test('no subscription at all: Auto mode as today (behind the cap), else the first she may use that serves Claude Code', () => {
  assert.equal(resolveTia({}, acc([api])).runsOn, 'auto');
  assert.equal(resolveTia({ accounts: ['api'] }, acc([api], { enabled: false, order: [] })).runsOn, 'api');
  assert.equal(resolveTia({}, acc([api])).subsLimited, null);
});

test('no subscription and no provider she may use: none, and readiness says where to tick one', () => {
  // The default list holds Auto mode (when on) and the subscriptions, no API provider: the key is not hers.
  const off = resolveTia({}, acc([api], { enabled: false, order: [] }));
  assert.equal(off.runsOn, null, 'a provider he did not allow is never Automatic\'s pick');
  assert.equal(off.noneAllowed, true);
  // Auto mode on but unticked: not taken either.
  const unticked = resolveTia({ accounts: [] }, acc([api]));
  assert.equal(unticked.runsOn, null);
  assert.equal(unticked.noneAllowed, true);
  // One she may use: taken, nothing to say.
  assert.equal(resolveTia({ accounts: ['api'] }, acc([api], { enabled: false, order: [] })).noneAllowed, false);
  // No provider at all: the older sentence ("Add a provider").
  assert.equal(resolveTia({}, acc([], { enabled: false, order: [] })).noneAllowed, false);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'assistant', 'feature.mjs'), 'utf8');
  assert.match(src, /if \(!tia\.runsOn && tia\.noneAllowed\) return \{ ok: false, code: 'none-allowed', problem: `None of the providers \$\{ASSISTANT_NAME\} may use can run her\. Tick one under Settings → \$\{ASSISTANT_NAME\} → "Providers she may use"/);
});

test('his own choice wins: a provider, or Auto mode chosen on purpose, is kept as it is', () => {
  const now = Date.now();
  assert.equal(resolveTia({ runsOn: 'api' }, acc([api, sub('one')])).runsOn, 'api');
  assert.equal(resolveTia({ runsOn: 'auto' }, acc([api, sub('one')])).runsOn, 'auto');
  const limited = acc([sub('one', { limited: { until: now + HOUR } }), sub('two')]);
  assert.equal(resolveTia({ runsOn: 'one' }, limited).runsOn, 'one', 'his choice is not moved by Automatic');
  assert.equal(resolveTia({ runsOn: 'one' }, limited).subsLimited, null);
});

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

test('out of the box with a subscription and Auto mode holding a paid key: she answers, with no hold and no notice', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-in is POSIX' }, async (t) => {
  const box = sandbox('tia-automatic');
  const mark = path.join(box.root, 'engine-started');
  const engine = path.join(box.root, 'engine.mjs');
  // A stand-in of the coding tool: notes that it started, answers one line and ends the turn.
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'started\\n');\nlet b='';process.stdin.on('data',(c)=>{b+=c;if(b.includes('\\n')){process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Here I am.'}]}})+'\\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Here I am.',total_cost_usd:0.01,session_id:'s1'})+'\\n');process.exit(0);}});\n`);
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { spendFile } = await import('../../src/assistant/spend.mjs');
  // Her settings as they are out of the box (only turned on): no cap, Automatic.
  saveConfig({ ...loadConfig(), usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, autoSwitch: { enabled: true, order: ['api', 'one'], payPerUse: true }, assistant: { enabled: true } });
  writeProfile('api', { label: 'Key', env: { ANTHROPIC_API_KEY: 'sk-made-up' } });
  writeProfile('one', { label: 'Plan one', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up' } });
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
  const o = (await request(base, 'GET', '/api/assistant', { headers: { Cookie: cookie } })).json;
  assert.equal(o.ready.ok, true, JSON.stringify(o.ready));
  assert.equal(o.ready.runsOn, 'one');
  assert.equal(o.ready.paid, false);
  // Settings → Tia names what Automatic picked now.
  const v = (await request(base, 'GET', '/api/assistant/settings', { headers: { Cookie: cookie } })).json;
  assert.equal(v.automatic && v.automatic.runsOn, 'one', JSON.stringify(v.automatic));
  const r = await request(base, 'POST', '/api/assistant/chat', { body: { text: 'What runs now?' }, headers: { Cookie: cookie } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let events = [];
  for (let i = 0; i < 100 && !events.some((e) => e.kind === 'done' || e.kind === 'notice'); i++) {
    await new Promise((res) => setTimeout(res, 100));
    events = (await request(base, 'GET', `/api/assistant/chat/${r.json.conversation}?from=0`, { headers: { Cookie: cookie } })).json.events;
  }
  assert.equal(events.find((e) => e.kind === 'notice'), undefined, JSON.stringify(events));
  assert.ok(fs.existsSync(mark), 'her engine did not start');
  assert.equal(fs.existsSync(spendFile()) ? fs.readFileSync(spendFile(), 'utf8') : '', '', 'a hold was written for a turn on a subscription');
});
