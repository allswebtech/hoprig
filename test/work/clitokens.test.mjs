// hoprig tasks tokens: lists the Work tokens (never a token or a hash) and revokes one by id or name, with its
// webhooks; --dry-run revokes nothing; --help names the command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-clitokens');
test.after(() => t.cleanup());
const { main, USAGE } = await import('../../src/work/cli.mjs');
const access = await import('../../src/work/access.mjs');

const run = async (args) => {
  const out = [];
  const err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('tokens lists, revokes by name or id with its webhooks, and a dry run changes nothing', async () => {
  assert.match(USAGE, /hoprig tasks tokens \[revoke <id or name>\]/);
  assert.match((await run(['tokens'])).out, /No Work tokens/);
  const a = access.createWorkToken('Shop script');
  access.addWebhook({ token: a.id, url: 'https://hooks.example.com/in', events: ['result'] });
  const list = await run(['tokens']);
  assert.equal(list.code, 0);
  assert.match(list.out, /Shop script .*last used never/);
  assert.match(list.out, /webhook .*hooks\.example\.com/);
  const json = JSON.parse((await run(['tokens', '--json'])).out);
  assert.equal(json.tokens[0].name, 'Shop script');
  const text = JSON.stringify(json) + list.out;
  assert.equal(text.includes(a.token) || text.includes('hash') || text.includes('secret'), false);
  const dry = await run(['tokens', 'revoke', 'Shop script', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(access.verifyWorkToken(a.token).id, a.id, 'a dry run revokes nothing');
  const gone = await run(['tokens', 'revoke', 'Shop script']);
  assert.equal(gone.code, 0, gone.err);
  assert.equal(access.verifyWorkToken(a.token), null);
  assert.deepEqual(access.listWebhooks(), []);
  const b = access.createWorkToken('By id');
  assert.equal((await run(['tokens', 'revoke', b.id])).code, 0);
  assert.equal(access.verifyWorkToken(b.token), null);
  assert.equal((await run(['tokens', 'revoke', 'nothing-like-it'])).code, 1);
  assert.equal((await run(['tokens', 'make', 'x'])).code, 2, 'tokens are made on the page only');
  assert.equal((await run(['tokens', '--project', 'x'])).code, 2);
  assert.ok(!fs.readFileSync(access.accessFile(), 'utf8').includes(b.token));
});
