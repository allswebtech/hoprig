// "Every subscription is at its limit" is said once: as her notice in the chat (code subs-limited), and the page's
// banner only until that notice is there. When he allowed a provider she may think on that is not a subscription
// (Auto mode, a key), the sentence ends with "Choose another provider for Tia", which only opens "Tia runs on": his
// own choice, never hers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const tia = await import('../../web/tia.js');
const { resolveTia } = await import('../../src/assistant/tia.mjs');
const all = (el) => [el, ...(el.children || []).flatMap((c) => (c instanceof FakeElement ? all(c) : []))];
const links = (el) => all(el).filter((e) => e.tag === 'a');
const HOUR = 3600_000;
const sub = (name, extra = {}) => ({ name, label: `Plan ${name}`, kind: 'subscription', tools: ['claude'], limited: { until: Date.now() + HOUR }, ...extra });
const key = { name: 'key', label: 'Key', kind: 'api', paid: true, tools: ['claude'] };

test('the facts: another provider she may use is known, one he left out is not', () => {
  const noOther = resolveTia({}, { profiles: [sub('one')], autoSwitch: { enabled: false, order: [] } });
  assert.equal(noOther.subsLimited.other, false);
  const withKey = resolveTia({ accounts: ['one', 'key'] }, { profiles: [sub('one'), key], autoSwitch: { enabled: false, order: [] } });
  assert.equal(withKey.subsLimited.other, true);
  assert.equal(withKey.runsOn, null, 'she never takes the key herself');
  const keyLeftOut = resolveTia({ accounts: ['one'] }, { profiles: [sub('one'), key], autoSwitch: { enabled: false, order: [] } });
  assert.equal(keyLeftOut.subsLimited.other, false);
});

test('the notice: the sentence, and the way to "Tia runs on" only when he has another provider she may use', () => {
  const text = 'Plan one has reached its limit, so Tia cannot answer now.';
  const withOther = tia.noticeView({ kind: 'notice', code: 'subs-limited', other: true, text });
  assert.equal(withOther.dataset.code, 'subs-limited');
  assert.deepEqual(links(withOther).map((a) => a.attrs.href), [tia.RUNS_LINK]);
  assert.equal(tia.RUNS_LINK, '#/settings/tia?show=tia-runs-on');
  assert.ok(all(withOther).some((e) => e.children.some((c) => c === 'Choose another provider for Tia' || (c && c.text === 'Choose another provider for Tia'))));
  assert.equal(all(withOther).some((e) => e.tag === 'button'), false, 'nothing is pressed for him');
  const none = tia.noticeView({ kind: 'notice', code: 'subs-limited', text });
  assert.deepEqual(links(none), [], 'no other provider: waiting is the answer, no link');
  assert.equal(tia.bannerLink({ ok: false, code: 'subs-limited', other: true }).attrs.href, tia.RUNS_LINK);
  assert.equal(tia.bannerLink({ ok: false, code: 'subs-limited' }), null);
});

test('once: the banner stays out while the chat shows that notice, and the field has the id the link names', () => {
  assert.equal(tia.saidInChat({ querySelector: (q) => (q === '.tia-notice[data-code="subs-limited"]' ? {} : null) }, 'subs-limited'), true);
  assert.equal(tia.saidInChat({ querySelector: () => null }, 'subs-limited'), false);
  const web = fs.readFileSync(path.join(ROOT, 'web', 'tia.js'), 'utf8');
  assert.match(web, /o && o\.ready && !o\.ready\.ok && !\(o\.ready\.code === 'subs-limited' && saidInChat\(body, o\.ready\.code\)\)/);
  assert.match(web, /if \(e\.code === 'subs-limited' && typeof document\.querySelectorAll === 'function'\) for \(const b of document\.querySelectorAll\('\.tia-ready\[data-code="subs-limited"\]'\)\) b\.remove\(\);/);
  assert.match(web, /h\('select\.field', \{ id: 'tia-runs-on',/);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant', 'feature.mjs'), 'utf8');
  assert.match(src, /: ready\.code === 'subs-limited' \? \{ code: ready\.code, origin, \.\.\.\(ready\.other \? \{ other: true \} : \{\}\) \} : \{\};/);
  assert.match(src, /code: 'subs-limited', until: tia\.subsLimited\.until, other: tia\.subsLimited\.other === true,/);
});
