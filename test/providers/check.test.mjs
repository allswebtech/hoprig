// "Check this provider" (src/providers/check.mjs) against a stand-in endpoint of the made-up gateway "Relay": the count
// it says is the count it sends, each request is one word with max_tokens 1, a refused fallback name and a refused
// picture get their mend lines, and nothing kept or returned holds the key, a token or an e-mail address.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { checkPlan, checkable, cleanSaid, firstCheck, gapsOf, lastCheck, mends, runCheck } from '../../src/providers/check.mjs';
import { TOOL_VERSION, isSmall, toolNames } from '../../src/providers/names.mjs';
import { mapSettings, sessionMap } from '../../src/providers/sessionmap.mjs';
import { sandbox } from '../server/helpers.mjs';

// Folders of its own: the check reads the owner's modelOverrides, and another test file that runs at the same time
// writes them into the runner's shared folders.
const box = sandbox('providers-check');
test.after(() => box.cleanup());
// The Claude Code these checks play: one that takes the map. Without it the check reads the version of the coding tool
// installed on the computer's own PATH, and a contributor without Claude Code, or with an older one, sees no MODELS mend.
const played = { version: TOOL_VERSION };

const KEY = 'sk-ant-api03-MADEUPKEY0000000000000000';

/** A stand-in: serves the names in `served`, refuses the others as an ambiguous name, and refuses pictures. */
async function relay(t, { served = new Set(), pictures = false, status = 400 } = {}) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const b = JSON.parse(raw || '{}');
      const image = JSON.stringify(b.messages).includes('"type":"image"');
      asked.push({ url: req.url, model: b.model, max: b.max_tokens, image, key: req.headers['x-api-key'] || null, words: JSON.stringify(b.messages).length });
      const leak = ` (key ${KEY}, account alex.relay@example.com, Authorization: Bearer tok-MADEUP-123456)`;
      if (image && !pictures) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Image input is not supported for model ${b.model}${leak}` } }));
      if (served.has(b.model)) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'H' }] }));
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Ambiguous model '${b.model}': it matches more than one model of this gateway${leak}` } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { asked, url: `http://127.0.0.1:${srv.address().port}` };
}

const profile = (url, extra = {}) => ({ name: 'relay-a', kind: 'api', models: '', env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: KEY }, ...extra });

test('the count said before the press is the count sent, each one word with max_tokens 1', async (t) => {
  const r = await relay(t, { served: new Set(toolNames()), pictures: true });
  const p = profile(r.url);
  const plan = checkPlan(p, played);
  assert.equal(plan.count, toolNames().length + 1);
  const res = await runCheck(p, played);
  assert.equal(r.asked.length, plan.count);
  assert.equal(res.count, plan.count);
  assert.ok(r.asked.every((a) => a.max === 1 && a.url === '/v1/messages' && a.key === KEY));
  assert.equal(r.asked.filter((a) => a.image).length, 1);
  assert.ok(res.rows.every((x) => x.verdict === 'served') && res.picture.verdict === 'served');
  assert.deepEqual(gapsOf(res), []);
});

test('a refused fallback name gets a combo line and a MODELS line that names a served model; a refused picture its combo', async (t) => {
  // The night of the ambiguous name: the newest opus is served, the one it falls back to is not.
  const served = new Set(toolNames().filter((n) => n !== 'claude-opus-5'));
  const r = await relay(t, { served });
  const res = await runCheck(profile(r.url), played);
  const gap = res.rows.find((x) => x.sends === 'claude-opus-5');
  assert.equal(gap.verdict, 'refused');
  assert.equal(gap.why, 'what claude-opus-5-5 falls back to');
  assert.match(gap.said, /^Ambiguous model 'claude-opus-5'/);
  assert.equal(gap.mend.combo, 'Add a combo named "claude-opus-5" at the gateway');
  assert.equal(gap.mend.models, 'MODELS=claude-opus-5=claude-opus-5-5');
  assert.equal(res.picture.verdict, 'refused');
  assert.equal(res.picture.mend.line, 'At the gateway, let claude-opus-5-5 take pictures, or send its pictures to a model that does');
  assert.doesNotMatch(res.picture.mend.line, /combo named "claude-opus-5-5"/, 'no combo named like a model the gateway serves');
  assert.deepEqual(gapsOf(res).map((g) => g.name), ['claude-opus-5', 'claude-opus-5-5']);
  // The mend keeps the profile's own rules after the new one.
  const mapped = await runCheck(profile(r.url, { models: 'relay-x=relay-y' }), played);
  assert.equal(mapped.rows.find((x) => x.sends === 'claude-opus-5').mend.models, 'MODELS=claude-opus-5=claude-opus-5-5,relay-x=relay-y');
});

test('no key, token or e-mail address is kept, returned or written', async (t) => {
  const r = await relay(t);
  const res = await runCheck(profile(r.url), played);
  const kept = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'providers', 'checks.json'), 'utf8');
  for (const text of [JSON.stringify(res), kept, JSON.stringify(lastCheck('relay-a'))]) {
    assert.doesNotMatch(text, /MADEUPKEY|sk-ant-api03|alex\.relay|example\.com|tok-MADEUP/);
  }
  assert.equal(lastCheck('relay-a').at, res.at);
  assert.equal(cleanSaid('the key my-own-key-1234 was refused', ['my-own-key-1234']), 'the key *** was refused');
  // A cut start of the key, and the name of the account the key belongs to.
  const tok = 'relay-made-up-token';
  assert.equal(cleanSaid('bad key relay-made-up-tok… (prefix relay-made)', [tok]), 'bad key ***… (prefix relay-made)');
  assert.equal(cleanSaid('Account "relay-team-alex" (owner alex.relay@example.com) is at its limit', [tok]), 'Account "***" (owner ***) is at its limit');
  assert.equal(cleanSaid('org: acme-shop has no access; user=alex2', [tok]), 'org: *** has no access; user=***');
  assert.equal(cleanSaid("Ambiguous model 'claude-opus-5'", [tok]), "Ambiguous model 'claude-opus-5'", 'a model name is left as it is');
  assert.equal(cleanSaid('user message is empty', [tok]), 'user message is empty', 'plain words are left as they are');
});

test('a limit or an error says nothing about a name: it is not a gap', async (t) => {
  const r = await relay(t, { status: 429 });
  const res = await runCheck(profile(r.url), played);
  assert.ok(res.rows.every((x) => x.verdict === 'untold' && !x.mend));
  assert.deepEqual(gapsOf(res).filter((g) => !g.picture), []);
});

test('a sign-in profile is never checked, and the first round runs only for a gateway', async (t) => {
  const r = await relay(t, { served: new Set(toolNames()), pictures: true });
  for (const p of [
    { name: 'sub', kind: 'login', env: {} },
    { name: 'max', kind: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-made-up-000000000000' } },
    { name: 'oa', kind: 'openai', env: { OPENAI_API_KEY: 'made-up-openai-key', OPENAI_BASE_URL: r.url } },
  ]) {
    assert.equal(checkable(p), false, p.name);
    assert.equal(checkPlan(p).count, 0);
    await assert.rejects(runCheck(p), /sign-in has none/);
    assert.equal(firstCheck(p), null);
  }
  // A key straight to the provider's own API is checked on a press, but not by itself.
  assert.equal(firstCheck({ name: 'direct', kind: 'api', env: { ANTHROPIC_API_KEY: KEY } }), null);
  assert.deepEqual(r.asked, []);
  await firstCheck(profile(r.url));
  assert.equal(r.asked.length, toolNames().length + 1);
});

test('an answer is read at most 64 KiB deep, and a served one not at all', async () => {
  // A stand-in fetch whose bodies are 8 MB each, made on demand: what the check pulls of them is counted.
  const pulled = [];
  const fetchImpl = async (url, o) => {
    const model = JSON.parse(o.body).model;
    const ok = model !== 'claude-opus-5';
    const row = { model, bytes: 0, cancelled: false };
    pulled.push(row);
    const chunk = new TextEncoder().encode(ok ? 'x'.repeat(65536) : `{"error":{"type":"invalid_request_error","message":"Ambiguous model '${model}' ${'y'.repeat(65000)}`);
    let left = 128;
    const body = new ReadableStream({
      pull(c) {
        if (left-- <= 0) return c.close();
        row.bytes += chunk.length;
        c.enqueue(chunk);
      },
      cancel() { row.cancelled = true; },
    }, { highWaterMark: 0 });
    return new Response(body, { status: ok ? 200 : 400 });
  };
  const res = await runCheck(profile('http://127.0.0.1:9'), { ...played, fetchImpl });
  assert.equal(res.rows.find((x) => x.sends === 'claude-opus-5').verdict, 'refused');
  const refused = pulled.find((x) => x.model === 'claude-opus-5');
  assert.ok(refused.bytes <= 2 * 65536, `read ${refused.bytes} bytes of an 8 MB body`);
  assert.ok(refused.cancelled, 'the rest is dropped');
  for (const x of pulled.filter((y) => y.model !== 'claude-opus-5')) assert.ok(x.bytes <= 65536 && x.cancelled, `${x.model}: ${x.bytes}`);
});

test('a refusal whose words do not name the model is not a gap, and the same answer to all is one endpoint problem', async (t) => {
  // A stand-in that wants more than max_tokens 1 for every name, and one at a base address with a wrong path.
  for (const [status, body, type] of [
    [400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be at least 16 for this gateway' } }), 'application/json'],
    [404, 'Not Found', 'text/plain'],
  ]) {
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(status, { 'content-type': type }).end(body)); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    const res = await runCheck(profile(`http://127.0.0.1:${srv.address().port}`), played);
    assert.ok(res.rows.every((x) => x.verdict === 'untold' && !x.mend), JSON.stringify(res.rows[0]));
    assert.equal(res.picture.verdict, 'untold');
    assert.deepEqual(gapsOf(res), []);
    assert.equal(res.endpoint.status, status);
    assert.match(res.endpoint.said, /max_tokens|Not Found/);
  }
  // One name refused with words that do not name the model, the others served: told with its words, no mend.
  const served = new Set(toolNames().filter((n) => n !== 'claude-sonnet-5'));
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = JSON.parse(raw).model;
      if (served.has(m)) return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too short for this route' } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const res = await runCheck(profile(`http://127.0.0.1:${srv.address().port}`), played);
  const row = res.rows.find((x) => x.sends === 'claude-sonnet-5');
  assert.deepEqual([row.verdict, row.said, row.mend], ['untold', 'prompt is too short for this route', undefined]);
  assert.equal(res.endpoint, null);
  // Claude's API names an unknown model this way: that is a gap.
  const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = JSON.parse(raw).model;
      if (m !== 'claude-opus-4-7') return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${m}` } }));
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  t.after(() => api.close());
  const direct = await runCheck(profile(`http://127.0.0.1:${api.address().port}`), played);
  assert.equal(direct.rows.find((x) => x.sends === 'claude-opus-4-7').verdict, 'refused');
});

test('the MODELS mend sends every name the tool falls back to away from the refused model, and says when the model is another kind', () => {
  // A profile whose opus rule leads to a model the gateway does not serve; only relay-large is served.
  const p = { name: 'relay-a', kind: 'api', models: 'claude-opus-*=relay-mid,claude-sonnet-*=relay-large', mapSessions: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/r', ANTHROPIC_API_KEY: KEY } };
  const rows = checkPlan(p, { version: TOOL_VERSION }).names.map((r) => ({ ...r, verdict: r.sends === 'relay-mid' ? 'refused' : r.sends === 'relay-large' ? 'served' : 'untold' }));
  mends(p, rows, null);
  const gap = rows.find((r) => r.sends === 'relay-mid');
  assert.equal(gap.mend.models, 'MODELS=claude-opus-*=relay-large,claude-sonnet-*=relay-large');
  assert.match(gap.mend.line, /relay-large is not an opus model/);
  // With the line applied, nothing a session sends reaches relay-mid any more.
  const mended = { ...p, models: gap.mend.models.slice('MODELS='.length) };
  const after = checkPlan(mended, { version: TOOL_VERSION }).names;
  assert.ok(!after.some((r) => r.sends === 'relay-mid'), after.map((r) => r.sends).join(' '));
  // No rule leads there: each name that sends the refused model gets a rule of its own, in front.
  const bare = { ...p, models: 'relay-x=relay-y' };
  const r2 = checkPlan(bare, { version: TOOL_VERSION }).names.map((r) => ({ ...r, verdict: r.sends === 'claude-opus-4-8' ? 'refused' : 'served' }));
  mends(bare, r2, null);
  assert.equal(r2.find((r) => r.sends === 'claude-opus-4-8').mend.models, 'MODELS=claude-opus-4-8=claude-opus-5-5,relay-x=relay-y');
  // Only the profile's own model variable sends it: MODELS does not rename that one, so no MODELS line.
  const own = { ...p, models: '', env: { ...p.env, ANTHROPIC_MODEL: 'relay-old' } };
  const r3 = checkPlan(own, { version: TOOL_VERSION }).names.map((r) => ({ ...r, verdict: r.sends === 'relay-old' ? 'refused' : 'served' }));
  mends(own, r3, null);
  assert.equal(r3.find((r) => r.sends === 'relay-old').mend.models, null);
});

test('no MODELS line where the installed Claude Code takes no map: it would change nothing for a session', async (t) => {
  const r = await relay(t, { served: new Set(toolNames().filter((n) => n !== 'claude-opus-5')), pictures: true });
  for (const version of [null, '2.1.300']) {
    const res = await runCheck(profile(r.url, { models: 'claude-opus-5=claude-opus-5-5' }), { version });
    const gap = res.rows.find((x) => x.sends === 'claude-opus-5');
    assert.equal(gap.verdict, 'refused', 'that Claude Code sends the name as it is');
    assert.equal(gap.mend.models, null, String(version));
    assert.equal(gap.mend.line, 'Add a combo named "claude-opus-5" at the gateway');
  }
  const now = await runCheck(profile(r.url), { version: TOOL_VERSION });
  assert.equal(now.rows.find((x) => x.sends === 'claude-opus-5').mend.models, 'MODELS=claude-opus-5=claude-opus-5-5');
});

test("with no MODELS, a name the owner's own settings map is asked as his settings send it", async (t) => {
  // The profile's own Claude Code folder, whose settings rename claude-opus-5 (made-up gateway names).
  const dir = path.join(box.root, 'own-claude-plain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelOverrides: { 'claude-opus-5': 'relay-old' } }));
  const r = await relay(t, { served: new Set(toolNames()), pictures: true });
  const env = { ANTHROPIC_BASE_URL: r.url, ANTHROPIC_API_KEY: KEY, CLAUDE_CONFIG_DIR: dir };
  const plain = profile(r.url, { env });
  const row = (plan) => plan.names.find((x) => x.also.includes('claude-opus-5'));
  assert.equal(row(checkPlan(plain, { version: TOOL_VERSION })).sends, 'relay-old', 'a plain session reads his settings file');
  // A key paid per use whose only rule is the bare "*=": no map of the profile's own, his entry all the same.
  const paid = profile(r.url, { models: '*=claude-opus-5-5', env: { ...env, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_MODEL: 'claude-opus-5-5' } });
  assert.equal(row(checkPlan(paid, { version: TOOL_VERSION })).sends, 'relay-old');
  // An older Claude Code: not known to take modelOverrides, so the name is asked as it is.
  assert.equal(row(checkPlan(plain, { version: '2.1.300' })).sends, 'claude-opus-5');
  // The round asks relay-old, which the gateway does not serve: a gap, not "served".
  const res = await runCheck(plain, { version: TOOL_VERSION });
  assert.ok(r.asked.some((a) => a.model === 'relay-old'));
  assert.equal(res.rows.find((x) => x.sends === 'relay-old').verdict, 'refused');
});

test("a name the owner's own settings send gets no MODELS line: his entry wins, so the line would change nothing", async (t) => {
  const dir = path.join(box.root, 'own-claude-mapped');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelOverrides: { 'claude-opus-5': 'relay-old' } }));
  const r = await relay(t, { served: new Set([...toolNames(), 'relay-large']), pictures: true });
  const p = profile(r.url, { models: 'claude-sonnet-5=relay-large', mapSessions: true, env: { ANTHROPIC_BASE_URL: r.url, ANTHROPIC_API_KEY: KEY, CLAUDE_CONFIG_DIR: dir } });
  // A session of this profile sends claude-opus-5 as relay-old, whatever the profile's MODELS say about it.
  assert.equal(mapSettings(sessionMap(p), TOOL_VERSION).modelOverrides['claude-opus-5'], 'relay-old');
  const res = await runCheck(p, { version: TOOL_VERSION });
  const gap = res.rows.find((x) => x.sends === 'relay-old');
  assert.equal(gap.verdict, 'refused');
  assert.equal(gap.mend.models, null, 'no line that "Use this" would write to no effect');
  assert.match(gap.mend.yours, /claude-opus-5 is sent as relay-old by your own Claude Code settings/);
  assert.match(gap.mend.line, /^Add a combo named "relay-old" at the gateway, or change claude-opus-5 in your own Claude Code settings/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), JSON.stringify({ modelOverrides: { 'claude-opus-5': 'relay-old' } }), 'his file is only read');
  // A profile rule that also leads there is still mended by a line: only the owner's own names are left out of it.
  const both = { ...p, models: 'claude-opus-4-8=relay-old,claude-sonnet-5=relay-large' };
  const res2 = await runCheck(both, { version: TOOL_VERSION });
  assert.equal(res2.rows.find((x) => x.sends === 'relay-old').mend.models, 'MODELS=claude-opus-4-8=claude-opus-5-5,claude-sonnet-5=relay-large');
});

test('every name refused with words that name the model: each one is a gap with its mend, not one endpoint problem', async (t) => {
  // A gateway that knows only its own combo names and says so in the same words for every other name.
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (JSON.parse(raw).model === 'relay-large') return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'The model does not exist' } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const res = await runCheck(profile(`http://127.0.0.1:${srv.address().port}`), { version: TOOL_VERSION });
  assert.equal(res.endpoint, null);
  assert.ok(res.rows.every((x) => x.verdict === 'refused' && x.said === 'The model does not exist'), JSON.stringify(res.rows[0]));
  assert.ok(res.rows.every((x) => x.mend.combo === `Add a combo named "${x.sends}" at the gateway`));
  assert.equal(gapsOf(res).filter((g) => !g.picture).length, toolNames().length);
});

test("an owner's entry for a small-model name sends nothing (the tool does not rename it): the MODELS mend stays, and no sentence blames his settings", async (t) => {
  const dir = path.join(box.root, 'own-claude-haiku');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ modelOverrides: { 'claude-haiku-4-5': 'relay-small' } }));
  const r = await relay(t, { served: new Set(toolNames().filter((n) => !isSmall(n))), pictures: true });
  const p = profile(r.url, { env: { ANTHROPIC_BASE_URL: r.url, ANTHROPIC_API_KEY: KEY, CLAUDE_CONFIG_DIR: dir } });
  const res = await runCheck(p, { version: TOOL_VERSION });
  const gap = res.rows.find((x) => x.sends === 'claude-haiku-4-5');
  assert.equal(gap.verdict, 'refused');
  assert.match(gap.mend.models || '', /^MODELS=.*claude-haiku-4-5=/);
  assert.equal(gap.mend.yours, undefined);
  assert.doesNotMatch(gap.mend.line, /your own Claude Code settings/);
});

test('with the switch off the check asks the names a session really sends, and a MODELS mend says it needs the switch', async () => {
  const { SWITCH_WORDS, withSwitch } = await import('../../src/providers/check.mjs');
  const p = profile('http://127.0.0.1:9/r', { models: 'claude-opus-*=relay-large' });
  const off = checkPlan(p, { version: TOOL_VERSION });
  assert.ok(off.names.some((r) => r.sends === 'claude-opus-5-5') && !off.names.some((r) => r.sends === 'relay-large'), 'plain names');
  assert.ok(checkPlan({ ...p, mapSessions: true }, { version: TOOL_VERSION }).names.some((r) => r.sends === 'relay-large'), 'renamed with the switch on');
  const mend = { combo: 'Add a combo named "claude-opus-5" at the gateway', models: 'MODELS=claude-opus-5=claude-opus-5-5' };
  mend.line = `${mend.combo}, or set ${mend.models}`;
  const result = { rows: [{ verdict: 'refused', sends: 'claude-opus-5', asks: 'claude-opus-5', mend }] };
  assert.equal(gapsOf(result, { on: false })[0].mend, `${mend.combo}, or set ${mend.models} ${SWITCH_WORDS}`);
  assert.equal(gapsOf(result, { on: true })[0].mend, mend.line);
  assert.equal(withSwitch({ combo: 'x', models: null, line: 'x' }, false), 'x', 'a combo alone needs no switch');
});

test('the combo mend is a press (Make the combo) only for the TRouteAI Hoprig manages; its sentence stays for others', async (t) => {
  const served = new Set(toolNames().filter((n) => n !== 'claude-opus-5'));
  const r = await relay(t, { served });
  const mine = await runCheck(profile(r.url, { prerun: 'hoprig addons start trouteai' }), played);
  const gap = mine.rows.find((x) => x.sends === 'claude-opus-5');
  assert.deepEqual(gap.mend.make, { gateway: 'trouteai', name: 'claude-opus-5' }, 'the press names the gateway and the combo');
  assert.equal(gap.mend.combo, 'Add a combo named "claude-opus-5" at the gateway', 'the sentence stays for a place that cannot press');
  assert.equal(mine.picture.mend.make, undefined, 'no combo is made for the picture');
  const other = await runCheck(profile(r.url, { prerun: 'hoprig addons start relay' }), played);
  assert.equal(other.rows.find((x) => x.sends === 'claude-opus-5').mend.make, undefined);
  const plain = await runCheck(profile(r.url), played);
  assert.equal(plain.rows.find((x) => x.sends === 'claude-opus-5').mend.make, undefined);
});
