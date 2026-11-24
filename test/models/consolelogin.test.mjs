// A stored sign-in on a Console account's key (src/routerstate.mjs billedLogin): Claude Code says "api_key" for it,
// and its profile file holds no key, so it looked free. It is billed by use: the tick list says so, a part on it waits
// for the owner's card, and "Tia writes my digest" on it with no daily limit calls nothing. A claude.ai sign-in stays
// free. Claude Code is a stand-in (fixtures/fake-claude-console.mjs): no provider is asked, the real sign-in is not read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { sealedPath } from '../seal.mjs';

const posix = process.platform !== 'win32';
const box = sandbox('consolelogin');
test.after(() => box.cleanup());
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-console.mjs');
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
const calls = path.join(box.root, 'calls.jsonl');
process.env.FAKE_CALLS = calls;

const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const C = await import('../../src/claudecode.mjs');
const RS = await import('../../src/routerstate.mjs');
const { otherProviders, partGate } = await import('../../src/models/others.mjs');
const { keepSample, tiaWorder } = await import('../../src/work/tellwire.mjs');
const { spendFile } = await import('../../src/assistant/spend.mjs');

saveConfig({ claudeBin: path.join(bin, 'claude') });
// The stored sign-in: a profile with no key of its own (kind "login").
writeProfile('acct', { label: 'Account' });
writeProfile('lead', { label: 'Lead', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });

/** The sign-in check against the stand-in, as doctor, setup and the page run it. */
async function check(kind, at) {
  process.env.FAKE_AUTH = kind;
  await C.claudeLoginStatus({ env: { ...process.env, PATH: sealedPath(`${bin}:/usr/bin:/bin`) } });
  // a later check, a minute on: written again (rememberLogin writes only what changed or is a minute old)
  if (at) RS.rememberLogin({ loggedIn: true, method: kind === 'console' ? 'api_key' : 'claude.ai' }, at);
}
const ownerLead = { lead: true, others: ['acct'], byTia: false };

test('a sign-in on a Console key is billed by use: the tick list says so and a part on it waits for his card', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  await check('console');
  assert.equal(RS.loginSeen().loggedIn, true);
  assert.equal(RS.providerFacts({ name: 'acct', kind: 'login' }).paid, true, 'the page gets paid, as for any key billed by use');
  assert.equal(otherProviders('lead').find((p) => p.name === 'acct').paid, true);
  assert.match(partGate(ownerLead, 'acct').card, /billed by use: the owner's OK comes first/, 'nothing starts by itself');
  assert.match(partGate({ ...ownerLead, byTia: true }, 'acct', { tia: { allowed: ['acct'], level: 'handsoff' } }).card, /no daily limit for paid use/);
});

test('"Tia writes my digest" on a Console sign-in with no daily limit: nothing is called', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  await check('console');
  fs.rmSync(calls, { force: true });
  fs.rmSync(spendFile(), { force: true });
  const cfg = { assistant: { enabled: true, runsOn: 'acct', accounts: ['acct'], dailyCapUsd: null }, server: { notify: { url: 'http://127.0.0.1:1/t', work: { digest: true, tiaWords: true } } } };
  keepSample(cfg, 'bhai kitna time lagega');
  const out = await tiaWorder({ cfg: () => cfg, log: () => {} })({ title: 'Work: {n1} done', lines: ['{n2} runs'], values: { n1: '1', n2: 'shop' } });
  assert.equal(out, null, 'the plain digest goes');
  assert.equal(fs.existsSync(calls), false, 'no call was made');
});

test('a claude.ai sign-in stays free, and the next check of another kind replaces the mark', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  await check('console');
  await check('claudeai', Date.now() + 120_000);
  assert.equal(RS.providerFacts({ name: 'acct', kind: 'login' }).paid, undefined);
  assert.equal(otherProviders('lead').find((p) => p.name === 'acct').paid, false);
  assert.deepEqual(partGate(ownerLead, 'acct'), { ok: true });
  // a run that only says "signed in" (launch.mjs) keeps what the last check said
  RS.rememberLogin({ loggedIn: true, method: 'api_key' }, Date.now() + 240_000);
  RS.rememberLogin({ loggedIn: true }, Date.now() + 360_000);
  assert.equal(RS.loginSeen().paid, true);
});
