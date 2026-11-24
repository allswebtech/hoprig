// "Tia writes my digest" on a provider billed by use (src/work/tellwire.mjs tiaWorder): the call runs by itself, so it
// runs only inside the daily limit for paid use he set, a hold taken before it and settled by what it cost, in her one
// ledger (src/assistant/spend.mjs). No limit, or no room left: no call, the plain digest. Claude Code is a stand-in
// (fixtures/fake-digest-claude.mjs) that records each call: no provider is asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const posix = process.platform !== 'win32';
const box = sandbox('tellwire-money');
test.after(() => box.cleanup());
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-digest-claude.mjs');
const bin = path.join(box.root, 'fake-claude.sh');
fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
const callLog = path.join(box.root, 'calls.jsonl');
process.env.FAKE_DIGEST_LOG = callLog;

const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { SpendLedger, spendFile } = await import('../../src/assistant/spend.mjs');
const { keepSample, tiaWorder } = await import('../../src/work/tellwire.mjs');

saveConfig({ claudeBin: bin });
// Billed by use: a key straight to the vendor (profiles.mjs isPayPerUse). A subscription token: not billed by use.
writeProfile('paidkey', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });
writeProfile('plan', { label: 'Plan', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });

const T = { title: 'Work: {n1} done', lines: ['{n2} runs'], values: { n1: '1', n2: 'shop' } };
const cfgOf = (runsOn, cap) => ({ assistant: { enabled: true, runsOn, accounts: [runsOn], dailyCapUsd: cap }, server: { notify: { url: 'http://127.0.0.1:1/t', work: { digest: true, tiaWords: true } } } });
const calls = () => {
  try {
    return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
function fresh(cfg) {
  fs.rmSync(callLog, { force: true });
  fs.rmSync(spendFile(), { force: true });
  keepSample(cfg, 'bhai kitna time lagega');
}
async function word(runsOn, cap) {
  const cfg = cfgOf(runsOn, cap);
  fresh(cfg);
  const said = [];
  const out = await tiaWorder({ cfg: () => cfg, log: (s) => said.push(s) })(T);
  return { out, said };
}

test('billed by use with no daily limit set: no call, the plain digest, and the reason in the log', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  const { out, said } = await word('paidkey', null);
  assert.equal(out, null, 'the plain digest goes');
  assert.equal(calls().length, 0, 'nothing was called');
  assert.equal(fs.existsSync(spendFile()), false, 'nothing was held');
  assert.match(said.join('\n'), /billed by use, and no daily limit for paid use is set/);
});

test('billed by use inside the limit: one call with what is left as its budget, held first and settled by its cost', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  const { out } = await word('paidkey', 5);
  assert.deepEqual(out, { title: 'Work: 1 done', body: 'shop runs' });
  const c = calls();
  assert.equal(c.length, 1);
  assert.equal(c[0][c[0].indexOf('--max-budget-usd') + 1], '5', 'the call stops at what is left of the limit');
  const kinds = fs.readFileSync(spendFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(kinds.map((e) => e.kind), ['hold', 'spent'], 'the hold before the call, its cost after it');
  assert.equal(kinds[1].hold, kinds[0].id, 'its own cost settles its own hold');
  assert.deepEqual(new SpendLedger().today(), { spent: 0.03, held: 0 }, 'the ledger shows what it cost');
});

test('billed by use with no room left today: no call, the plain digest, nothing more held', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  const cfg = cfgOf('paidkey', 1);
  fresh(cfg);
  new SpendLedger().spent(0.8, 'her own turn');
  const said = [];
  const out = await tiaWorder({ cfg: () => cfg, log: (s) => said.push(s) })(T);
  assert.equal(out, null);
  assert.equal(calls().length, 0, 'nothing was called');
  assert.deepEqual(new SpendLedger().today(), { spent: 0.8, held: 0 }, 'no hold was written');
  assert.match(said.join('\n'), /billed by use, and today's .* has no room/);
});

test('a subscription: worded as before, with no hold and no budget', { skip: !posix && 'the stand-in is a POSIX script' }, async () => {
  const { out } = await word('plan', null);
  assert.deepEqual(out, { title: 'Work: 1 done', body: 'shop runs' });
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].includes('--max-budget-usd'), false);
  assert.equal(fs.existsSync(spendFile()), false, 'nothing in the ledger');
});
