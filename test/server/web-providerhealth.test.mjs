// A provider's panels on its page (web/providerhealth.js), in a small stand-in DOM with a stand-in answer of the health
// route: the model map names where each rule comes from (the small model's rule is this provider's own), and "What is
// left" does not say the limits again that the usage bars above it already show. Made-up names only.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    const cls = new Set();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
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

const all = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
};
const text = (n) => all(n).map((x) => x.text || '').join('');

const NOW = Date.now();
const health = {
  name: 'relay-a',
  check: { applies: true, count: 3, press: true, last: null },
  map: { rules: [{ from: 'claude-opus-5', to: 'relay-large', by: 'profile' }, { from: 'the small model', to: 'relay-small', by: 'small' }], version: '2.1.328', untaken: 0 },
  left: {
    windows: [{ win: 'fiveHour', line: 'the 5-hour limit: 40% used, resets at 12:00 UTC (reported by the provider at 11:00 UTC)' }],
    paces: [{ win: 'fiveHour', line: 'At the pace of the last hour the 5-hour limit is used up in about 3 hours (from 20% to 40% used in 45 minutes).' }],
    stops: { day: 0, limits: 0, line: null },
    advice: null,
  },
};
globalThis.fetch = async () => new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } });
const { providerHealth } = await import('../../web/providerhealth.js');

async function panels() {
  const box = providerHealth('relay-a');
  for (let i = 0; i < 50 && /Loading/.test(text(box)); i++) await new Promise((r) => setTimeout(r, 5));
  return box;
}

test('each rule of the map says where it comes from, the small model\'s as this provider\'s, on a line part of its own', async () => {
  const box = await panels();
  const rules = all(box).filter((n) => n.tag === 'li' && /relay-(large|small)/.test(text(n)));
  assert.deepEqual(rules.map(text), ['claude-opus-5relay-largefrom this provider', 'the small modelrelay-smallfrom this provider']);
  assert.ok(rules.every((li) => li.children.some((c) => /\bph-by\b/.test(c.className || ''))), 'the source is its own part, for narrow screens');
});

test('"What is left" says the pace and the stops, not the limits the usage bars already show', async () => {
  const box = await panels();
  const left = all(box).find((n) => n.tag === 'ul' && /\bph-left\b/.test(n.className));
  assert.deepEqual(left.children.map(text), [health.left.paces[0].line]);
  assert.doesNotMatch(text(box), /reported by the provider at/);
  assert.ok(NOW);
});

test("a gap the owner's own settings send says to change it there, with no MODELS line to use", async () => {
  const yours = 'claude-opus-5 is sent as relay-old by your own Claude Code settings (modelOverrides in its settings.json), which win over this provider\'s map: change it there. Hoprig does not change that file.';
  health.check.last = { at: new Date(NOW).toISOString(), tool: '2.1.328', endpoint: null, picture: null,
    rows: [{ asks: 'claude-opus-5', sends: 'relay-old', why: 'what claude-opus-5-5 falls back to', verdict: 'refused', said: "Ambiguous model 'relay-old'", mend: { combo: 'Add a combo named "relay-old" at the gateway', models: null, yours } }] };
  try {
    const box = await panels();
    assert.match(text(box), /or, in your own settings:/);
    assert.ok(text(box).includes(yours));
    assert.doesNotMatch(text(box), /Use this|or, in this provider:/);
  } finally {
    health.check.last = null;
  }
});

test('the model map says whether sessions get it, shows what they would send, and has the switch on the owner\'s page', async () => {
  const keep = health.map;
  try {
    health.map = { ...keep, on: false, models: true, change: true };
    let t = text(await panels());
    assert.match(t, /Off: sessions and chats on this provider send the names Claude Code chooses; only Auto mode uses this map/);
    assert.match(t, /Use these names for every session on this provider/);
    assert.match(t, /Sessions already open keep what they have, and Auto mode is not changed by it/);
    assert.doesNotMatch(t, /Every session and chat on this provider sends/);
    health.map = { ...keep, on: true, models: true, change: true };
    t = text(await panels());
    assert.match(t, /On: every new session and chat on this provider sends these names instead/);
    health.map = { ...keep, on: false, models: true, change: false };
    t = text(await panels());
    assert.match(t, /changed on that computer's own page/);
  } finally {
    health.map = keep;
  }
});
