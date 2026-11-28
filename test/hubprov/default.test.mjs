// The default provider on a linked computer, and the words of the pages for the hub's providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chooseDefault } from '../../src/defaultprovider.mjs';

const row = (name, extra = {}) => ({ name, kind: 'api', tools: ['claude'], limited: null, paid: false, ...extra });

test('a linked computer\'s own provider is the default; the hub\'s come after it', () => {
  const profiles = [row('hub-shared', { hub: true }), row('mine')];
  assert.equal(chooseDefault({ profiles, auto: { enabled: false, order: [] } }), 'mine');
});

test('with no provider of its own, the hub\'s default is used, so "Needs a provider first" never shows while the hub shares', () => {
  const profiles = [row('hub-first', { hub: true }), row('hub-second', { hub: true })];
  assert.equal(chooseDefault({ profiles, auto: { enabled: false, order: [] } }), 'hub-first');
});

test('an own provider at its limit gives way to a hub one that is free', () => {
  const profiles = [row('mine', { limited: { until: Date.now() + 1000 } }), row('hub-free', { hub: true })];
  assert.equal(chooseDefault({ profiles, auto: { enabled: false, order: [] } }), 'hub-free');
});

test('the pages: the muted word hub, Sign in here, the one switch in a closed More fold, Keep to this computer; Use here only in the gateways fold', () => {
  const src = fs.readFileSync(new URL('../../web/accounts.js', import.meta.url), 'utf8');
  assert.match(src, /a\.hub \? h\('span\.hub-word\.muted', ' hub'\)/);
  assert.match(fs.readFileSync(new URL('../../web/providerwords.js', import.meta.url), 'utf8'), /if \(a\.hub\) return \{ kind: 'signin', label: 'Sign in here' \};/);
  assert.match(src, /a\.hub \? 'Sign in here' : a\.signinRefused \? 'Sign in again' : 'Sign in'/, 'and on its own page');
  assert.match(src, /fold\('hubshare', 'More', toggle\('My other computers may use this computer\\'s providers'/);
  assert.match(src, /'Keep to this computer'/);
  for (const f of fs.readdirSync(new URL('../../web/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    // Two things exist side by side: the hub's providers on its linked computers (no button, they appear by themselves) and
    // Use here for a gateway on a computer this dashboard controls, which is only in the fold of web/gateways.js.
    const text = fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
    if (f === 'gateways.js') assert.match(text, /label: 'Use here'/);
    else assert.doesNotMatch(text, /label: 'Use here'|Gateways on your computers/, f);
  }
});
