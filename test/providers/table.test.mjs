// The closed table that names every way a provider stops the work (src/providers/table.mjs). The inputs below
// are what Claude Code 2.1.328 wrote in its records against a gateway stand-in (see docs/PROVIDERS.md): the
// StopFailure hook's `error`, and the transcript line's apiErrorStatus/apiErrorType/stop_reason/text. Made-up
// names only; no key-shaped value appears here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NAMES, REASONS, classify } from '../../src/providers/table.mjs';

test('a usage limit is named `limit`, whatever account words the gateway adds', () => {
  for (const r of [
    { error: 'rate_limit', status: 429, type: 'rate_limit_error', text: "Request rejected (429) · This request would exceed your account's rate limit." },
    { error: 'rate_limit', status: 429, type: 'rate_limit_error', text: 'All accounts of this gateway are at their limit.' },
    { error: 'billing_error', text: 'Credit balance is too low.' },
  ]) {
    const c = classify(r);
    assert.equal(c.reason, 'limit', JSON.stringify(r));
    assert.equal(c.step, 'switch');
  }
});

test('a sign-in that is gone is named `auth` and its step is to sign in', () => {
  for (const r of [
    { error: 'authentication_failed', status: 401, type: 'authentication_error', text: 'Invalid API key · Fix external API key' },
    { status: 403, text: 'Forbidden' },
  ]) {
    const c = classify(r);
    assert.equal(c.reason, 'auth');
    assert.equal(c.step, 'signin');
  }
});

test('a model name the endpoint refuses (not found or ambiguous) is named `model`; its step makes the name known', () => {
  const notFound = classify({ error: 'model_not_found', status: 404, type: 'not_found_error', text: "There's an issue with the selected model (relay-small). It may not exist or you may not have access to it." });
  assert.equal(notFound.reason, 'model');
  assert.equal(notFound.step, 'name');
  // Ambiguous: Claude Code's StopFailure error is `unknown`, so the status, type and words must carry it.
  const ambiguous = classify({ error: 'unknown', status: 400, type: 'invalid_request_error', text: "Ambiguous model 'relay-large': it matches more than one model of this gateway" });
  assert.equal(ambiguous.reason, 'model');
  assert.equal(ambiguous.step, 'name');
});

test('a picture the endpoint will not take for that model is named `input`', () => {
  const c = classify({ error: 'unknown', status: 400, type: 'invalid_request_error', text: 'Image input is not supported for model relay-large' });
  assert.equal(c.reason, 'input');
  assert.equal(c.step, 'session');
});

test("the provider's own refusal is named `refusal` and is never retried or moved", () => {
  for (const r of [
    { error: 'invalid_request', stop: 'refusal', text: "Haiku 4.5 can't help with this. Start a new session to continue." },
    { error: 'invalid_request', stop: 'refusal', text: "Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)." },
  ]) {
    const c = classify(r);
    assert.equal(c.reason, 'refusal', r.text);
    assert.equal(c.step, 'session');
    assert.equal(c.retriable, false);
  }
});

test('an endpoint that does not answer is named `no-answer`; its step restarts the gateway', () => {
  for (const r of [
    { error: 'server_error', text: 'Request timed out. If the API is slow to answer, or a proxy or gateway holds responses, set API_TIMEOUT_MS above 8000.' },
    // What 2.1.328 wrote for a port that refuses the connection: `server_error`, no status, and these words.
    { error: 'server_error', text: 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)' },
  ]) {
    const c = classify(r);
    assert.equal(c.reason, 'no-answer', r.text);
    assert.equal(c.step, 'gateway');
    assert.equal(c.retriable, true);
  }
});

test('an overload or a server error past the retries is named `server`', () => {
  for (const r of [
    { error: 'server_error', status: 500, type: 'api_error', text: 'API Error: 500 Internal server error' },
    { error: 'server_error', status: 529, type: 'overloaded_error', text: 'API Error: 529 Overloaded' },
  ]) {
    const c = classify(r);
    assert.equal(c.reason, 'server', r.text);
    assert.equal(c.retriable, true);
  }
});

test('an API error with no row is `provider-error`, carrying the tool\'s own line cut short, never guessed at', () => {
  const long = `API Error: 418 ${'teapot '.repeat(60)}`;
  const c = classify({ error: 'invalid_request', status: 418, type: 'invalid_request_error', text: long });
  assert.equal(c.reason, 'provider-error');
  assert.ok(c.text.length <= 160, `line is cut short: ${c.text.length}`);
  assert.ok(c.text.endsWith('…'), c.text.slice(-3));
});

test('what is not a provider stop is null: the model\'s prose, a tool\'s own error line, nothing at all', () => {
  assert.equal(classify({}), null);
  assert.equal(classify({ text: 'The API answered 429 rate_limit_error earlier; that was an error in the log, not now. Done.' }), null);
  assert.equal(classify({ text: 'Error: 2 of 40 tests failed' }), null);
  assert.equal(classify(), null);
});

test('the table is closed and frozen', () => {
  assert.ok(NAMES.includes('limit') && NAMES.includes('refusal') && NAMES.includes('provider-error'));
  assert.throws(() => { REASONS.limit = null; });
  // Every name has a step and words.
  for (const n of NAMES) assert.ok(REASONS[n].step && REASONS[n].words, n);
});

test('a very long error line is read only in its first part, so it is named at once', () => {
  // A gateway's error body can be anything; a pattern that looks back over all of it would take minutes.
  for (const text of ['model '.repeat(35_000), `API Error: 400 ${'model '.repeat(35_000)}`]) {
    const t = performance.now();
    const c = classify({ error: 'unknown', status: 400, text });
    assert.ok(performance.now() - t < 200, `took ${Math.round(performance.now() - t)} ms for ${text.length} chars`);
    assert.equal(c.reason, 'provider-error');
    assert.ok(c.text.length <= 160);
  }
});

test('the cut never leaves half of a character before the ellipsis', () => {
  for (const pad of [158, 157]) {
    const c = classify({ error: 'invalid_request', status: 418, text: `${'a'.repeat(pad)}😀😀😀` });
    assert.ok(c.text.endsWith('…'));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(c.text), [...c.text.slice(-3)].map((x) => x.codePointAt(0).toString(16)).join(' '));
    assert.ok(c.text.length <= 160);
  }
});

test('the kept line is cleaned: no key, no token and no account address', () => {
  // The shape a gateway really writes after its error words (made-up values).
  const text = 'API Error: Request rejected (429) (key sk-ant-api03-MADEUPMADEUP0000, account alex.relay@example.com, Authorization: Bearer tok-MADEUP-123456)';
  const c = classify({ error: 'rate_limit', status: 429, type: 'rate_limit_error', text });
  assert.equal(c.reason, 'limit');
  for (const secret of ['sk-ant-api03', 'MADEUPMADEUP', 'alex.relay', 'example.com', 'tok-MADEUP']) assert.ok(!c.text.includes(secret), `${secret} in: ${c.text}`);
  assert.match(c.text, /^API Error: Request rejected \(429\)/);
});

test('words alone are never a stop: prose that sounds like one, with no field of the tool, is null', () => {
  for (const text of [
    "Sorry, I can't help with this part of the refactor.",
    'The integration test timed out after 30 s; I will raise the limit.',
    'The server log shows ECONNREFUSED on port 5432, so Postgres is down.',
    'The model: User was not found in schema.prisma, so I added it.',
    'Django says ambiguous model reference in the migration.',
    'The upload form says image input is not supported for GIFs; fixed.',
    'API Error handling is now in src/api.js.',
  ]) assert.equal(classify({ text }), null, text);
});

test("the tool's own fields win over the words of its line", () => {
  // A server error whose words name a timeout: the endpoint answered with a 500, so it did answer.
  assert.equal(classify({ error: 'server_error', status: 500, type: 'api_error', text: 'API Error: 500 upstream timeout' }).reason, 'server');
  // A 404 with no word about a model is a wrong address at a gateway, not a model name: nothing is guessed.
  assert.equal(classify({ error: 'unknown', status: 404, text: 'API Error: 404 page not found' }).reason, 'provider-error');
  // A usage limit whose words say "can't help with this" is still the limit.
  assert.equal(classify({ error: 'rate_limit', status: 429, text: "Request rejected (429): we can't help with this many requests" }).reason, 'limit');
  // A server error that quotes the model's words is not a refusal.
  assert.equal(classify({ error: 'server_error', status: 529, type: 'overloaded_error', text: "API Error: 529 Overloaded while answering: I can't help with this" }).reason, 'server');
});

test('each row holds by its own field alone, with no words to carry it', () => {
  // A refusal in the transcript: Claude Code writes stop_reason "refusal", often with no text at all.
  assert.equal(classify({ stop: 'refusal', text: '' })?.reason, 'refusal');
  // Rows read from the tool's code but not seen in its records against the stand-in (unverified):
  // connection_failed, oauth_org_not_allowed and overloaded.
  assert.equal(classify({ error: 'connection_failed', text: '' })?.reason, 'no-answer');
  assert.equal(classify({ error: 'oauth_org_not_allowed', text: '' })?.reason, 'auth');
  assert.equal(classify({ error: 'overloaded', text: '' })?.reason, 'server');
  // An error name with no row (also one the tool may add later): a provider error, nothing guessed.
  for (const error of ['account_on_hold', 'verification_required', 'something_new']) assert.equal(classify({ error, text: '' })?.reason, 'provider-error', error);
  // "unknown" with nothing else is still the tool saying the reply ended in an error.
  assert.equal(classify({ error: 'unknown', text: '' })?.reason, 'provider-error');
});

test('docs/PROVIDERS.md, which keeps the samples, exists and names every row in the same words', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../../docs/PROVIDERS.md', import.meta.url), 'utf8');
  for (const n of NAMES) assert.ok(doc.includes(`| ${REASONS[n].words} |`), `${n}: "${REASONS[n].words}" is not a row of the doc`);
  assert.doesNotMatch(doc, /sk-ant-|Bearer [\w-]{6,}|@[\w-]+\.[a-z]{2,}/, 'no key, token or address in the doc');
});

test('the status at the start of the tool line wins over the words after it (the hook keeps no status of its own)', async () => {
  const { hookPatch } = await import('../../src/hook.mjs');
  const { stopOf } = await import('../../src/operator/sources.mjs');
  const viaHook = (error, line) => stopOf(hookPatch({ status: 'working' }, { hook_event_name: 'StopFailure', error, last_assistant_message: line }, 1000).failure)?.reason;
  assert.equal(viaHook('server_error', 'API Error: 500 upstream timeout'), 'server');
  assert.equal(viaHook('server_error', 'API Error: 502 Bad gateway: upstream connect error. reset reason: connection timeout'), 'server');
  assert.equal(viaHook('unknown', "API Error: 500 Internal error: the model said I can't help with this"), 'server');
  // A stop with no status keeps its words: a time-out is no answer, an ambiguous name at a 400 is the name.
  assert.equal(viaHook('server_error', 'API Error: Request timed out.'), 'no-answer');
  assert.equal(viaHook('unknown', "API Error: 400 Ambiguous model 'relay-large'"), 'model');
});

test('a very long line of word characters is cleaned at once, in the hook too (it has 5 seconds)', async () => {
  const { hookPatch } = await import('../../src/hook.mjs');
  const line = `API Error: 500 ${'a'.repeat(200_000)} alex@example.com`;
  const t = process.cpuUsage();
  const p = hookPatch({ status: 'working' }, { hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: line }, 1000);
  const { user, system } = process.cpuUsage(t);
  assert.ok((user + system) / 1000 < 1000, `took ${(user + system) / 1000} ms of CPU`);
  assert.equal(p.failure.error, 'server_error');
  assert.equal(classify({ error: 'server_error', text: 'API Error: 500 for alex.relay@example.com' }).text, 'API Error: 500 for ***');
});
