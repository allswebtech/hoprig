// The upkeep's switch "credentials" on the Workspace page (web/wscredsauto.js): off by default, shown only when the
// credentials folder is a repository, and its press sets exactly the setting `hoprig workspace auto --credentials on`
// sets, through the route the panel's other switches use; what the command refuses, the route refuses; Tia's door
// never lets it through. Its words say what it does and are in the docs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempHome } from './helpers.mjs';
import { fakeCtx, fakeDeck } from '../automation/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], on: {}, classList: { add() {}, remove() {}, toggle() {} } });
    if (tag === 'input') this.checked = false;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.on[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
globalThis.window ??= { dispatchEvent: () => {} };
const texts = (n) => (n == null ? [] : n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const find = (n, tag) => (n instanceof FakeElement ? (n.tag === tag ? n : n.children.map((c) => find(c, tag)).find(Boolean)) : null);

const P = await import('../../web/wscredsauto.js');
const { DEFAULTS } = await import('../../src/automation/settings.mjs');
const { automationFeature } = await import('../../src/automation/feature.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');

/** The page's switch pressed on: the patch its panel saves. */
async function pressed(w) {
  const sent = [];
  const el = P.credsToggle(w, async (patch) => (sent.push(patch), true));
  const input = find(el, 'input');
  assert.equal(input.checked, w.credentials === true);
  await input.on.change({ target: { checked: !input.checked } });
  return sent;
}

const req = (body) => Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
async function postSettings(feature, body) {
  const route = feature.routes.find(([m, re]) => m === 'POST' && re.test('/api/automation/settings'));
  return route[2](req(body), null, new URLSearchParams());
}

test('off by default, on the page and in the settings, and shown only for a repository', async () => {
  assert.equal(DEFAULTS.workspace.credentials, false);
  assert.equal(P.credsToggle({ credsRepo: false, credentials: false }, () => true), null, 'a plain folder: no switch');
  assert.equal(P.credsToggle({ credsRepo: true }, () => true).children.length > 0, true);
  assert.equal(find(P.credsToggle({ credsRepo: true }, () => true), 'input').checked, false, 'never chosen: off');
  const src = fs.readFileSync(path.join(ROOT, 'web', 'workspace.js'), 'utf8');
  assert.match(src, /everyHours: 6, credentials: false, onlyHere: false, servers: false, \.\.\./, 'the panel\'s own default is off');
  assert.match(src, /credsToggle\(w, save\)/, 'beside the other switches of the upkeep');
  for (const [folder, shown] of [['repository', true], ['folder', false], ['missing', false]]) {
    assert.equal(await P.credsIsRepo(async () => ({ folder })), shown, folder);
  }
  assert.equal(await P.credsIsRepo(async () => { throw new Error('older Hoprig'); }), false);
});

test('the page\'s press sets exactly the setting the command sets', async () => {
  const t = tempHome('credsauto');
  try {
    const { main } = await import('../../src/workspace/cli.mjs');
    const { loadConfig, saveConfig } = await import('../../src/config.mjs');
    const { makeUi } = await import('../../src/setup/ui.mjs');
    const out = [];
    const ui = makeUi({ interactive: false, write: (s) => out.push(s) });
    assert.equal(await main(['auto', '--credentials', 'on'], { ui, write: (s) => out.push(s) }), 0, out.join(''));
    const byCommand = loadConfig().automation.workspace;
    assert.equal(byCommand.credentials, true);
    saveConfig({ automation: null });

    const sent = await pressed({ credsRepo: true, credentials: false });
    assert.deepEqual(sent, [{ credentials: true }], 'one key, the command\'s own');
    const f = fakeCtx({ deck: fakeDeck([]), stateDir: path.join(t.root, 'auto') });
    const feature = automationFeature(null, { ctx: f.ctx, tick: false });
    feature.start();
    try {
      await postSettings(feature, { workspace: sent[0] });
      assert.deepEqual(f.config().automation.workspace, byCommand, 'the same setting, every key of it');
      // What the command refuses (a value that is not on or off), the route refuses, and nothing is saved.
      assert.equal(await main(['auto', '--credentials', 'yes'], { ui, write: (s) => out.push(s) }), 1);
      for (const bad of ['yes', 1, null, 'on']) {
        await assert.rejects(postSettings(feature, { workspace: { credentials: bad } }), (e) => e.status === 400 && /on or off/.test(e.message), String(bad));
      }
      await assert.rejects(postSettings(feature, { workspace: { credentials: true, extra: 1 } }), (e) => e.status === 400);
      assert.equal(f.config().automation.workspace.credentials, true, 'unchanged by a refusal');
      assert.deepEqual(await pressed({ credsRepo: true, credentials: true }), [{ credentials: false }], 'off again');
    } finally {
      await feature.close();
    }
  } finally {
    t.cleanup();
  }
});

test('Tia\'s door never sets it: the switch is the owner\'s alone', () => {
  assert.throws(() => checkRoute('POST', '/api/automation/settings', { workspace: { credentials: true } }, {}), /not a rule she may change/);
  assert.throws(() => checkRoute('POST', '/api/automation/settings', { workspace: { credentials: false } }, {}), /not a rule she may change/);
});

test('its words say what it does, and the docs carry them', () => {
  assert.match(P.CREDS_HINT, /every change in the credentials folder is saved and uploaded to its repository, by itself/);
  assert.match(P.CREDS_HINT, /Whoever can read that repository reads every key in it/);
  const flat = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
  assert.ok(flat('docs/WORKSPACE.md').includes(P.CREDS_LABEL), 'docs/WORKSPACE.md names the switch');
  assert.ok(flat('docs/WORKSPACE.md').includes(P.CREDS_HINT), 'and says its sentence');
  assert.ok(flat('site/content/changelog.md').includes(P.CREDS_LABEL), 'the changelog names it');
});
