// The Operator page's parts in a stand-in DOM: what a card says and offers, what the empty list says, and when the list
// is drawn again. The page itself is proven in a real browser as well.
import assert from 'node:assert/strict';
import test from 'node:test';

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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  contains(n) {
    return n === this || this.children.some((c) => c instanceof FakeElement && c.contains(n));
  }
  // Selectors of the forms "tag", "tag.class", "[data-x=\"v\"]" and "tag.class[data-x=\"v\"]": what the page asks.
  matches(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[data-([\w-]+)="([^"]*)"\])?$/.exec(sel);
    if (!m) throw new Error(`the stand-in DOM does not know the selector ${sel}`);
    const classes = this.className.split(' ');
    return (!m[1] || this.tag === m[1]) && m[2].split('.').filter(Boolean).every((c) => classes.includes(c)) && (!m[3] || this.dataset[m[3]] === m[4]);
  }
  querySelectorAll(sel) {
    return this.children.filter((c) => c instanceof FakeElement).flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  focus() {
    document.activeElement = this;
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
document.activeElement = null;
const h0 = () => new FakeElement('div');
const fill2 = (el, ...kids) => el.replaceChildren(...kids);
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const all = (n, f) => (n instanceof FakeText ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c) => all(c, f))]);

const page = await import('../../web/operator.js');

const catalog = {
  push: { label: 'Push the branch', risk: 'others', effect: 'Sends it to its remote, where others see it.' },
  open: { label: 'Open', risk: 'none', effect: 'Opens where it is.' },
  stop: { label: 'End the session', risk: 'stops', effect: 'The session and its coding tool stop.' },
  dismiss: { label: 'Not now', risk: 'none', effect: 'Hides it until its facts change.' },
};
const repoItem = { id: 'repo-aaaaaaaaaaaa', rev: 'bbbbbbbbbbbb', kind: 'repo', class: 'info', subject: 'repository shop', since: null, facts: ['1 ahead (not pushed)'], acts: [{ id: 'push' }, { id: 'open', href: '#/workspace/project/shop', label: 'Open the project' }], recommended: 'push', why: 'Only ahead.' };
const stuckItem = { id: 'stuck-cccccccccccc', rev: 'dddddddddddd', kind: 'stuck', class: 'stopped', subject: 'session alpha', since: null, facts: ['working, with no progress for 40 min'], acts: [{ id: 'open', href: '#/s/alpha', label: 'Open the session' }, { id: 'stop' }], recommended: 'open', why: 'Look at its screen.' };

test('a step with a risk says it on the card and asks first; a plain one asks nothing', () => {
  const card = page.itemCard(repoItem, catalog, () => {});
  assert.ok(texts(card).includes('Push the branch: others will see it.'), texts(card).join('|'));
  const push = page.confirmFor({ id: 'push' }, catalog.push);
  assert.deepEqual([push.title, push.ok, push.danger], ['Push the branch?', 'Push the branch', false]);
  assert.match(push.text, /Others will see it\. It cannot be undone from here\.$/);
  assert.equal(page.confirmFor({ id: 'stop' }, catalog.stop).danger, true, 'stopping work is the red button');
  assert.equal(page.confirmFor({ id: 'open' }, catalog.open), null);
  assert.ok(texts(page.itemCard(stuckItem, catalog, () => {})).includes('End the session: the work that runs now stops.'));
});

test('an empty list says "nothing needs you" only when every source was read', () => {
  const at = '2026-03-10T14:00:00Z';
  assert.deepEqual(page.emptyWords({ watched: [{ source: 'sessions', ok: true, at }, { source: 'repos', ok: false, at: null }] }), { icon: 'check', text: 'Nothing needs you now.' });
  const w = page.emptyWords({ hidden: 1, watched: [{ source: 'sessions', ok: true, at }, { source: 'schedules', label: 'Schedules', ok: false, at, error: 'could not be read: bad file' }] });
  assert.deepEqual(w, { icon: 'alert', text: 'Nothing needs you in what could be read. 1 source could not be read: Schedules. 1 put off until it changes.' });
});

test('every step and the More of a card name the item they are for', () => {
  const card = page.itemCard(repoItem, catalog, () => {});
  const named = all(card, (n) => n.tag === 'button' || n.tag === 'a' || n.tag === 'summary').map((n) => n.attrs['aria-label']);
  assert.deepEqual(named, ['Push the branch: repository shop', 'More steps for repository shop', 'Open the project: repository shop', 'Not now: repository shop']);
});

test('the list is drawn again only when what it shows changed', () => {
  const r = { items: [repoItem, stuckItem], watched: [], hidden: 0 };
  assert.equal(page.listKey(r), page.listKey(JSON.parse(JSON.stringify(r))), 'the same list: nothing to draw');
  assert.notEqual(page.listKey(r), page.listKey({ ...r, items: [repoItem, { ...stuckItem, rev: 'eeeeeeeeeeee' }] }));
  assert.notEqual(page.listKey(r), page.listKey({ ...r, items: [repoItem] }));
});

test('after a tap the toast says what the timeline says; a card that changed under a tap is marked', () => {
  assert.equal(page.doneWords({ act: 'push', said: 'repository shop: pushed 2' }), 'repository shop: pushed 2');
  assert.ok(texts(page.itemCard(stuckItem, catalog, () => {}, { changed: true })).includes('Changed: look again'));
  assert.ok(!texts(page.itemCard(stuckItem, catalog, () => {})).includes('Changed: look again'));
});

test('one word per thing: a quiet session is "No progress", not stopped; the card menu is "More steps"', () => {
  assert.equal(page.classWords(stuckItem), 'No progress');
  assert.equal(page.classWords(repoItem), 'For your information');
  assert.ok(texts(page.itemCard(stuckItem, catalog, () => {})).includes('More steps'));
});

test('a focused primary or red button has a ring that shows, not the pale one of a plain button', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.btn\.primary:focus-visible, \.btn\.danger:focus-visible \{ outline: 2px solid var\(--text\); outline-offset: 2px; \}/);
});

test('a paid move the daily cap does not allow: the card says it in one line and its button opens Settings → Tia at the cap', async () => {
  const tia = await import('../../web/operator-tia.js');
  const limitItem = { id: 'limit-aaaaaaaaaaaa', rev: 'bbbbbbbbbbbb', kind: 'limit', class: 'stopped', subject: 'session alpha', since: null, facts: ['at a usage limit'], acts: [{ id: 'switch' }], recommended: 'switch', why: 'It waits for a provider.' };
  const words = 'Moving this session to paid-x costs money by use, and Tia has no daily limit for paid use.';
  const v = { his: { [limitItem.id]: { rev: limitItem.rev, words, cap: true } } };
  assert.equal(tia.hisCap(limitItem, v), true);
  const card = page.itemCard(limitItem, { switch: { label: 'Continue on the next provider', risk: 'none' } }, () => {}, { his: tia.hisWords(limitItem, v), cap: tia.hisCap(limitItem, v) });
  assert.ok(texts(card).includes(`Yours: ${words}`), texts(card).join('|'));
  const [btn] = all(card, (n) => n.tag === 'a' && texts(n).join('') === 'Set a daily limit for paid use');
  assert.ok(btn, 'the button is there');
  assert.equal(btn.href ?? btn.attrs.href, '#/settings/tia?show=tia-daily-cap');
  assert.equal(page.CAP_SWITCH, '#/settings/tia?show=tia-daily-cap');
  // Another reason the item is his: no button; the item changed since: neither.
  const other = { his: { [limitItem.id]: { rev: limitItem.rev, words: 'Tia tried twice and it came back: it is yours now.' } } };
  assert.equal(tia.hisCap(limitItem, other), false);
  assert.equal(all(page.itemCard(limitItem, {}, () => {}, { his: tia.hisWords(limitItem, other), cap: tia.hisCap(limitItem, other) }), (n) => n.tag === 'a' && texts(n).join('') === 'Set a daily limit for paid use').length, 0);
  assert.equal(tia.hisCap({ ...limitItem, rev: 'eeeeeeeeeeee' }, v), false);
});

test('a tapped step is usable again after its answer, also when the list is not drawn again', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/operator.js', import.meta.url), 'utf8');
  const tap = src.slice(src.indexOf('async function tap('), src.indexOf('async function load('));
  assert.match(tap, /finally \{[^}]*button\.disabled = false/);
});

test('a rule that left an item to him says so on its card; Done by Tia shows Undo only where it can be, and says when there is none', async () => {
  const tia = await import('../../web/operator-tia.js');
  const v = { his: { [stuckItem.id]: { rev: stuckItem.rev, words: 'Tia tried twice and it came back: it is yours now.' } }, undoable: ['aabbccdd'] };
  const card = page.itemCard(stuckItem, catalog, () => {}, { his: tia.hisWords(stuckItem, v) });
  assert.ok(texts(card).includes('Yours: Tia tried twice and it came back: it is yours now.'), texts(card).join('|'));
  assert.equal(tia.hisWords({ ...stuckItem, rev: 'eeeeeeeeeeee' }, v), null, 'the item changed since: no note');
  const list = tia.byTiaList([
    { at: '2026-03-10T14:00:00Z', by: 'limit', subject: 'session alpha', act: 'switch', ok: true, result: 'moved to plan-b', undo: 'aabbccdd' },
    { at: '2026-03-10T13:00:00Z', by: 'leftover', subject: 'tmux server t', act: 'end', ok: true, result: 'ended', noUndo: 'An ended process cannot be undone.' },
    { at: '2026-03-10T12:00:00Z', by: 'limit', subject: 'session beta', act: 'switch', ok: false, refused: true, result: 'Auto mode is on' },
    { at: '2026-03-10T11:00:00Z', by: 'limit', subject: 'session gamma', act: 'switch', ok: true, result: 'moved to plan-b', undo: '00112233' },
  ], v, () => {});
  const words = texts(list);
  assert.ok(words.includes('Undo'), words.join('|'));
  assert.equal(all(list, (n) => n.tag === 'button').length, 1, 'one Undo: none for a move that was moved back already');
  assert.ok(words.includes('No Undo now: it is more than a day ago.'), 'a move with no Undo left says why');
  const back = texts(tia.byTiaList([{ at: '2026-03-10T11:00:00Z', by: 'limit', subject: 'session gamma', act: 'switch', ok: true, result: 'moved to plan-b', undo: '00112233' }], { ...v, undone: { '00112233': new Date(Date.now() - 5 * 60_000).toISOString() } }, () => {}));
  assert.ok(back.includes('Moved back by you 5 min ago.'), back.join('|'));
  assert.ok(words.includes('An ended process cannot be undone.'));
  assert.ok(words.includes('the limit rule did not act'), words.join('|'));
  assert.ok(texts(tia.byTiaList([], v, () => {})).includes('Tia has done nothing by herself.'));
  // A move cut off by a stop of the dashboard may have been done: Undo is offered while the server says it can be.
  const cut = tia.byTiaList([{ at: '2026-03-10T14:00:00Z', by: 'limit', subject: 'session alpha', act: 'switch', ok: false, cutOff: true, result: 'not known whether it was done', undo: 'aabbccdd' }], v, () => {});
  assert.equal(all(cut, (n) => n.tag === 'button').length, 1, 'Undo on a cut-off move');
  assert.ok(texts(cut).includes('the limit rule was cut off by a stop of the dashboard'), texts(cut).join('|'));
});

test('the sidebar and the tab bar draw their number in one place, with the same words for a screen reader', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/shell.js', import.meta.url), 'utf8');
  assert.equal(src.match(/'aria-label': badgeLabel\(/g).length, 1, 'the list and the bar share navItem, which uses badgeLabel');
  assert.match(src, /fill\(bottom, bar\.map\(\(p\) => navItem\(p, current, 'tab'\)\)\)/);
  assert.doesNotMatch(src, /waiting for you` \}/);
  const { badgeLabel } = await import('../../web/shell.js');
  assert.deepEqual([badgeLabel(1), badgeLabel(3)], ['1 thing needs you', '3 things need you']);
});

// The Tia panel as the server sends it (GET /api/operator/settings), with one rule.
const tiaView = (over = {}) => ({
  acts: false, tia: true, active: false, said: 'Tia does nothing by herself: "Tia acts" is off.', projectsOut: [], his: {}, undoable: [], undone: {},
  rules: [{ id: 'limit', sentence: 'When a session stops at a usage limit, continue it on the next provider of my order.', detail: 'Only to a provider Tia may use.', act: 'switch', on: false, undo: 'move it back with one tap under Done by Tia.', noUndo: null, budget: { perHour: 3, perDay: 10, waitMinutes: 10 }, left: { hour: 3, day: 10 } }],
  ...over,
});

test('the number fields of "Change the limits" are styled as every other field', async () => {
  const tia = await import('../../web/operator-tia.js');
  const inputs = all(tia.tiaPanel(tiaView(), () => {}), (n) => n.tag === 'input' && n.attrs.type === 'number');
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every((i) => i.className.split(' ').includes('field')), inputs.map((i) => i.className).join('|'));
});

// The switch of a panel by its key, and a change of it as the browser sends one.
const switchOf = (root, key) => all(root, (n) => n.tag === 'input' && n.dataset.focus === key)[0];
const flip = async (input, to) => {
  input.checked = to;
  await input.listeners.change({ target: input });
};
const answers = [];
globalThis.fetch = async (url, o) => {
  const a = answers.shift() || { status: 200, body: {} };
  answers.calls = [...(answers.calls || []), [String(url), o?.body ? JSON.parse(o.body) : null]];
  return { ok: a.status < 400, status: a.status, json: async () => a.body };
};

test('Cancel on "Let Tia act by herself?" or a refused change puts the switch back as it was', async () => {
  const tia = await import('../../web/operator-tia.js');
  const panel = tia.tiaPanel(tiaView(), () => {}, { confirm: async () => false });
  const master = switchOf(panel, 'master');
  await flip(master, true);
  assert.equal(master.checked, false, 'cancelled: drawn off, as the server has it');
  answers.length = 0;
  answers.push({ status: 200, body: tiaView() });
  const project = h0();
  await tia.projectOutSwitch(project, 'shop');
  answers.push({ status: 403, body: { error: 'refused' } });
  const ps = switchOf(project, 'project');
  await flip(ps, true);
  assert.equal(ps.checked, false, 'refused: drawn as it was');
});

test('Settings → Tia asks the same question as the Operator page before she may act', async () => {
  const tia = await import('../../web/operator-tia.js');
  const box = h0();
  answers.length = 0;
  answers.push({ status: 200, body: tiaView() });
  await tia.tiaActsSetting(box, { confirm: async () => false });
  answers.calls = [];
  await flip(switchOf(box, 'master'), true);
  assert.deepEqual(answers.calls.filter(([, b]) => b), [], 'nothing is sent after Cancel');
  const src = (await import('node:fs')).readFileSync(new URL('../../web/operator-tia.js', import.meta.url), 'utf8');
  assert.equal(src.match(/confirm = confirmActs/g).length, 2, 'one question, used in both places');
});

test('after his own change the panel is drawn again while the focus is on the switch, and the focus stays on that switch', async () => {
  const tia = await import('../../web/operator-tia.js');
  const box = h0();
  let key = tia.drawTia(box, tiaView(), () => {});
  switchOf(box, 'master').focus();
  const on = tiaView({ acts: true, active: true, said: 'Tia does by herself only what the rules that are on say, within their limits.' });
  key = tia.drawTia(box, on, () => {}, { drawn: key, force: true });
  assert.ok(texts(box).includes(on.said), 'drawn again with what the server says now');
  assert.ok(texts(box).includes('Tia OFF'), 'Tia OFF is there');
  assert.equal(document.activeElement, switchOf(box, 'master'), 'the focus is on the new master switch');
  // While he types in an open "Change the limits" form, the 15-second reload does not draw over it (his own Save does).
  const limitsForms = () => all(box, (n) => n.tag === 'details' && String(n.className).includes('op-limits'));
  const form = limitsForms()[0];
  form.open = true;
  all(form, (n) => n.tag === 'input')[0].focus();
  const kept = tia.drawTia(box, tiaView({ acts: true, said: 'other words' }), () => {}, { drawn: key });
  assert.equal(limitsForms()[0], form, 'the open form he types in stays');
  assert.equal(kept, key);
  tia.drawTia(box, tiaView({ acts: true, said: 'other words' }), () => {}, { drawn: key, force: true, focus: 'limits-limit' });
  assert.ok(texts(box).includes('other words'), 'after his Save it is drawn again');
  assert.equal(document.activeElement.dataset.focus, 'limits-limit', 'the focus on that rule\'s "Change the limits"');
});

test('after Undo the focus stays on its line of Done by Tia; after Tia OFF it goes to the master switch', async () => {
  const tia = await import('../../web/operator-tia.js');
  const v = { undoable: ['aabbccdd'], his: {} };
  const box = h0();
  fill2(box, tia.byTiaList([{ at: '2026-03-10T14:00:00Z', by: 'limit', subject: 'session alpha', act: 'switch', ok: true, result: 'moved to plan-b', undo: 'aabbccdd' }], v, () => {}));
  assert.equal(tia.focusKey(box, 'undo-aabbccdd'), true);
  assert.equal(document.activeElement.tag, 'li');
  assert.equal(document.activeElement.tabIndex, -1, 'a line takes the focus without being in the tab order');
  const src = (await import('node:fs')).readFileSync(new URL('../../web/operator-tia.js', import.meta.url), 'utf8');
  assert.match(src, /after\('master'\); \/\/ the button is gone/);
  assert.match(src, /after\(`undo-\$\{l\.undo\}`\)/);
  const op = (await import('node:fs')).readFileSync(new URL('../../web/operator.js', import.meta.url), 'utf8');
  assert.doesNotMatch(op, /!tia\.contains\(document\.activeElement\)/, 'the panel is no longer held back by the focus alone');
});

test('on another computer\'s page the Tia panel is read only: no switch, no Tia OFF, no Undo, and it says where to change it', async () => {
  const tia = await import('../../web/operator-tia.js');
  const { machine } = await import('../../web/lib.js');
  machine.set('box2');
  try {
    const panel = tia.tiaPanel(tiaView({ acts: true, active: true, said: 'Tia does by herself only what the rules that are on say, within their limits.' }), () => {});
    assert.deepEqual(all(panel, (n) => n.tag === 'input' || n.tag === 'button' || n.tag === 'details'), []);
    assert.ok(texts(panel).includes('Change this on that computer\'s own dashboard.'), texts(panel).join('|'));
    const list = tia.byTiaList([{ at: '2026-03-10T14:00:00Z', by: 'limit', subject: 'session alpha', act: 'switch', ok: true, result: 'moved to plan-b', undo: 'aabbccdd' }], { undoable: ['aabbccdd'] }, () => {});
    assert.equal(all(list, (n) => n.tag === 'button').length, 0, 'no Undo there');
    const box = h0();
    answers.length = 0;
    answers.push({ status: 200, body: tiaView({ projectsOut: ['shop'] }) });
    await tia.projectOutSwitch(box, 'shop');
    assert.deepEqual(all(box, (n) => n.tag === 'input'), []);
    assert.ok(texts(box).some((t) => /Tia never acts in this project\. Change this on that computer/.test(t)), texts(box).join('|'));
  } finally {
    machine.set(null);
  }
});

test('the rules\' words: what a limit counts, what "two tries" means, a switch named by its sentence alone', async () => {
  const tia = await import('../../web/operator-tia.js');
  const { RULES } = await import('../../src/operator/rules.mjs');
  const w = tia.limitWords(tiaView().rules[0]);
  assert.match(w, /^At most 3 acts an hour and 10 a day/);
  assert.match(w, /after two tries that did not help \(it came back within the hour\), it is yours/);
  assert.match(RULES.find((r) => r.id === 'limit').detail, /Providers → Auto mode/);
  assert.match(RULES.find((r) => r.id === 'leftover').detail, /an idle tmux server .* or a test's dashboard/);
  assert.ok(RULES.every((r) => !r.undo || /^[a-z]/.test(r.undo)), 'Undo: reads on mid-sentence');
  const panel = tia.tiaPanel(tiaView(), () => {});
  const rule = switchOf(panel, 'rule-limit');
  assert.equal(rule.attrs['aria-label'], tiaView().rules[0].sentence);
  assert.equal(rule.attrs['aria-describedby'], 'op-hint-rule-limit');
  const failed = texts(tia.byTiaList([{ at: '2026-03-10T14:00:00Z', by: 'gateway', subject: 'gateway gate', act: 'restart-gateway', ok: false, result: 'it did not start' }], { undoable: [] }, () => {}));
  assert.ok(failed.includes('the gateway rule tried, and it failed'), failed.join('|'));
});

test('the Tia fold names "Tia decides" and the looks as her ways to act alone', async () => {
  const tia = await import('../../web/operator-tia.js');
  const t = texts(tia.tiaPanel(tiaView(decideView), () => {})).join('|');
  assert.match(t, /Tia decides/);
});

test('"Tia decides": the confirm says what a decision really costs, not a few hundred tokens', async () => {
  const d = await import('../../web/operator-decide.js');
  assert.match(d.COST_WORDS, /about 3,400 tokens/);
  assert.doesNotMatch(d.COST_WORDS, /few hundred/);
});

const decideView = { decide: { on: false, missions: false, missionsPerDay: 10, model: null, modelRefused: null, perHour: 6, perDay: 30, tokensPerDay: 125_000, today: { calls: 0, hour: 0, tokens: 0, missions: 0 }, held: null } };

test('"Tia decides": a mission\'s choices have a switch of their own that says what it does, what it costs and today\'s count', async () => {
  const d = await import('../../web/operator-decide.js');
  const words = texts(d.decidePart({ decide: { ...decideView.decide, today: { ...decideView.decide.today, missions: 2 } } }, () => {})).join(' ');
  assert.match(words, /Also a mission's choices/);
  assert.match(words, /about 3,500 tokens each: measured 3,514 on average, 3,589 at most, over 30 calls/);
  assert.match(words, /A task sent back twice stays yours/);
  assert.match(words, /Today: 2 of 10 mission decisions/);
});

test('"Tia decides": the panel and the confirm say where his note is written', async () => {
  const d = await import('../../web/operator-decide.js');
  assert.match(texts(d.decidePart(decideView, () => {})).join(' '), /Advanced → How Tia decides here/);
  assert.match(d.NOTE_PLACE, /up to 500 characters/);
});

test('"Tia decides": while her record of decisions could not be read, the panel says she makes none until when', async () => {
  const d = await import('../../web/operator-decide.js');
  // A freeze lasts a day: a time 23 hours away is said with its date, in the server's own clock (UTC).
  const frozen = new Date(Date.now() + 23 * 3600_000).toISOString();
  const until = `${frozen.slice(0, 10)} ${frozen.slice(11, 16)} UTC`;
  const v = { decide: { ...decideView.decide, on: true, frozen } };
  const words = texts(d.decidePart(v, () => {})).join(' ');
  assert.ok(words.includes(`Her record of decisions could not be read: she makes none until ${until}.`), words);
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  assert.equal(d.clock(soon), `${soon.slice(11, 16)} UTC`, 'within the day: the time alone');
  assert.doesNotMatch(words, /Today:/, 'not the usual line as if all were well');
  assert.match(texts(d.decidePart(decideView, () => {})).join(' '), /Today: 0 of 30 decisions/);
});

test('"Tia decides": the hold line says whose hold it is', async () => {
  const d = await import('../../web/operator-decide.js');
  const held = new Date(Date.now() + 20 * 60_000).toISOString();
  const say = (heldBy) => texts(d.decidePart({ decide: { ...decideView.decide, held, heldBy } }, () => {})).join(' ');
  assert.match(say('owner'), /you held them\./);
  assert.match(say('tia'), /Tia held them because the computer was overloaded/);
  assert.match(say('both'), /you held them, and Tia did/);
});

test('"Tia decides": its "Change the limits" has a name that says which limits', async () => {
  const d = await import('../../web/operator-decide.js');
  const summary = all(d.decidePart(decideView, () => {}), (n) => n.tag === 'summary')[0];
  assert.equal(summary.attrs['aria-label'], 'Change the limits of Tia decides');
});

const lookView = { look: { on: false, perDay: 2, dollarsPerDay: 3, today: { looks: 1, dollars: 0.42 }, estimate: { model: 'Claude Opus 5.5', usd: 0.57, tokens: 41000, measuredModel: 'haiku', measuredOn: '2026-11-19', unknown: [], prices: { input: 4, output: 20, read: '2026-11-19' } } } };

test('a look: its switch says what it does, what one costs as an estimate with its basis, and today\'s count', async () => {
  const l = await import('../../web/operator-look.js');
  const words = texts(l.lookPart(lookView, () => {})).join(' ');
  assert.match(words, /Tia looks into what nobody can explain/);
  assert.match(words, /can only read the project \(Read, Glob, Grep\)/);
  assert.match(words, /One look costs about \$0\.57 \(an estimate: 41,000 tokens counted on a real look on haiku \(2026-11-19\), priced at the list price of Claude Opus 5\.5 \(\$4 a million input tokens and \$20 a million output tokens, the list prices read on 2026-11-19\); a look on Claude Opus 5\.5 may read and think more\)/);
  // A rolling 24 hours, said as such: a look at 23:00 still counts the next morning.
  assert.match(words, /In the last 24 hours: 1 of 2 looks, \$0\.42 of \$3\.00\./);
  assert.match(words, /One look may spend at most \$2\.58: what is left of the \$3\.00 of the last 24 hours\./, 'the cap beside the estimate');
  const held = l.lookToday({ ...lookView.look, today: { looks: 1, dollars: 3, reserved: 3 } });
  assert.match(held, /Of it, \$3\.00 is not spent but held back/);
  // The page's clock says a time within 20 hours of now by its time alone, and one further away with its date: both
  // are checked against the clock as it is, never against a fixed day (which holds only on that day).
  const soon = new Date(Date.now() + 3600_000).toISOString();
  assert.match(l.lookToday({ ...lookView.look, frozen: soon }), new RegExp(`could not be read: she starts none until ${soon.slice(11, 16)} UTC`));
  const far = new Date(Date.now() + 30 * 3600_000).toISOString();
  assert.match(l.lookToday({ ...lookView.look, frozen: far }), new RegExp(`could not be read: she starts none until ${far.slice(0, 10)} ${far.slice(11, 16)} UTC`));
  assert.doesNotMatch(l.lookToday({ ...lookView.look, frozen: 'unread' }), /\$/, 'no dollars shown for a record nobody can read');
  const none = texts(l.lookPart({ look: { ...lookView.look, estimate: { model: 'Claude Opus 5.5', usd: null, tokens: 0, unknown: ['not measured yet'] } } }, () => {})).join(' ');
  assert.match(none, /What one look costs is not known yet \(not measured yet\)/);
  assert.doesNotMatch(none, /about \$/);
});

test('a look\'s finding is a card part for him: the session\'s words as such, its cost, and "Make it a task" only when it counts', async () => {
  const unknownItem = { id: 'unknown-aaaaaaaaaaaa', rev: 'bbbbbbbbbbbb', kind: 'unknown', class: 'stopped', subject: 'Work run 20261119-120000-a1b2c3d4', since: null, facts: ['"Cart" failed 3 min ago'], acts: [{ id: 'open', href: '#/work/activity', label: 'Open the runs' }], recommended: 'open', why: 'It failed for a reason no check of Hoprig knows.' };
  const finding = { state: 'done', counted: true, cost: 0.31, tokens: 25000, task: null, finding: { cause: 'total() adds the price, not price times qty', where: [{ file: 'src/cart.mjs', line: 3 }], mend: 'Multiply by qty', sure: 'fairly sure' } };
  const card = page.itemCard(unknownItem, catalog, () => {}, { finding });
  const words = texts(card).join(' ');
  assert.match(words, /What Tia's look found/);
  assert.match(words, /Cause:\s+total\(\) adds the price/);
  assert.match(words, /Where:\s+src\/cart\.mjs:3/);
  assert.match(words, /These are the words of a session of Tia's\. It changed nothing\. It cost \$0\.31 and 25,000 tokens, as the coding tool reported\./);
  const buttons = all(card, (n) => n.tag === 'button').map((n) => n.attrs['aria-label']);
  assert.ok(buttons.includes('Make it a task: Work run 20261119-120000-a1b2c3d4'), buttons.join('|'));
  assert.match(words, /Make it a task adds this mend to your Work tasks\. Nothing runs until you start it; Tia does not mend it by herself\./);
  const kept = texts(page.itemCard(unknownItem, catalog, () => {}, { finding: { ...finding, counted: false, notCounted: 'its branch has 1 commit of its own, so it is kept' } }));
  assert.ok(kept.join(' ').includes('The look was only allowed to read the project, but its copy of the project was changed, so Hoprig cannot vouch for what it found. That copy is kept for you to look at.'), kept.join(' '));
  assert.ok(kept.join(' ').includes('For a programmer: its branch has 1 commit of its own, so it is kept.'), 'the reason itself is still there, after the plain sentence');
  const unsure = texts(page.itemCard(unknownItem, catalog, () => {}, { finding: { ...finding, counted: false, notCounted: 'git could not list the branches' } })).join(' ');
  assert.match(unsure, /Hoprig could not make sure the look left its copy of the project as it was, so it cannot vouch for what it found\./);
  assert.ok(kept.join(' ').includes('Not checked: Hoprig cannot vouch for what follows'), 'the cause is marked as not checked');
  assert.ok(!kept.join(' ').includes('It is not counted'));
  assert.ok(!all(page.itemCard(unknownItem, catalog, () => {}, { finding: { ...finding, counted: false } }), (n) => n.tag === 'button').some((n) => /Make it a task/.test(n.attrs['aria-label'] || '')));
  const madeCard = page.itemCard(unknownItem, catalog, () => {}, { finding: { ...finding, task: 'mend-total-sums-only-l-price-and-ignores', taskTitle: 'Mend: total() adds the price, not price times qty' } });
  assert.match(texts(madeCard).join(' '), /It is a task in Work now:\s+Mend: total\(\) adds the price, not price times qty\s*\./);
  assert.doesNotMatch(texts(madeCard).join(' '), /mend-total-sums/, 'never named by its cut id');
  assert.ok(all(madeCard, (n) => n.tag === 'a' && n.attrs.href === '#/work/tasks').length === 1, 'a link to the tasks');
  assert.match(texts(page.itemCard(unknownItem, catalog, () => {}, { finding: { state: 'failed', finding: null, fault: 'its last line is not the finding asked for', cost: null } })).join(' '), /It found nothing that counts: its last line is not the finding asked for/);
  assert.equal(all(page.itemCard(unknownItem, catalog, () => {}), (n) => n.className.includes('op-look')).length, 0, 'no look: no part');
  assert.match(texts(page.itemCard(unknownItem, catalog, () => {}, { finding: { state: 'waits', on: 'Auto mode' } })).join(' '), /Tia's look waits while your session on Auto mode works\./);
  // Tokens reported with no dollars: the tokens are said, and that the whole budget was held back.
  const noCost = texts(page.itemCard(unknownItem, catalog, () => {}, { finding: { ...finding, cost: null, tokens: 12000 } })).join(' ');
  assert.match(noCost, /Its coding tool reported no cost \(it reported 12,000 tokens\), so the day's count holds back this look's whole budget\./);
});

test('the Tia panel holds the look\'s switch', async () => {
  const tia = await import('../../web/operator-tia.js');
  const v = { acts: false, active: false, said: 'Off.', rules: [], projectsOut: [], ...decideView, ...lookView };
  assert.match(texts(tia.tiaPanel(v, () => {})).join(' '), /Tia looks into what nobody can explain/);
});

const corrView = { corrections: { on: true, perDay: 200, total: 7, weekTotal: 5, days: 90, week: { rule: { limit: 3 }, decision: { limit: 1, machine: 1 }, skill: { checkout: 2 }, role: { developer: 4 } }, byKind: {}, decisionKinds: { undo: 1, 'hold-lifted': 1 } } };

test('his corrections: the switch, Forget these and Use these as evidence, and "took this back" under a rule and under Tia decides', async () => {
  const tia = await import('../../web/operator-tia.js');
  const rule = { id: 'limit', on: true, sentence: 'Move a session at its limit', detail: 'x', undo: 'Undo it', budget: { perHour: 1, perDay: 1, waitMinutes: 1 }, left: { hour: 1, day: 1 } };
  const v = { acts: true, active: true, said: 'On.', rules: [rule], projectsOut: [], ...decideView, ...lookView, ...corrView };
  const panel = tia.tiaPanel(v, () => {});
  const words = texts(panel).join(' ');
  assert.match(words, /Tia keeps your corrections/);
  assert.match(words, /Nothing changes by itself from them/);
  assert.match(words, /Kept now: 7 \(5 this week\)/);
  assert.match(words, /You took this back 3 times this week\./, 'under the rule');
  assert.match(words, /Tia decides: You took this back 2 times this week\./);
  assert.match(words, /does not start the loop/);
  const buttons = all(panel, (n) => n.tag === 'button').map((n) => texts(n).join(''));
  assert.ok(buttons.includes('Forget these') && buttons.includes('Use these as evidence'), buttons.join('|'));
  const written = texts(tia.tiaPanel({ ...v, corrections: { ...corrView.corrections, evidence: { file: '~/.local/state/hoprig/operator/evidence.jsonl', lines: 2 } } }, () => {})).join(' ');
  assert.match(written, /Evidence written: 2 lines in ~\/\.local\/state\/hoprig\/operator\/evidence\.jsonl, for the improvement loop \(not started\)\./);
  // A chat card he declined, a plan he changed and a step he picked are no acts of "Tia decides": each its own line.
  const mixed = texts(tia.tiaPanel({ ...v, corrections: { ...corrView.corrections, decisionKinds: { 'other-answer': 1, declined: 1, 'plan-changed': 1, 'hold-lifted': 1 } } }, () => {})).join(' ');
  assert.match(mixed, /Tia decides: You took this back 1 time this week\./, mixed);
  assert.match(mixed, /Her recommended step: you picked another 1 time this week\./);
  assert.match(mixed, /Her confirm cards in a chat: you declined them 1 time this week\./);
  assert.match(mixed, /Her plans: you changed them before you accepted them 1 time this week\./);
  const none = texts(tia.tiaPanel({ ...v, corrections: { ...corrView.corrections, week: { rule: {}, decision: {}, skill: {}, role: {} }, decisionKinds: {} } }, () => {})).join(' ');
  assert.doesNotMatch(none, /took this back/);
});

test('the Team tab says per role how many he sent back', async () => {
  const m = await import('../../web/mission.js');
  // This week's count alone: the role's 9 tasks count every mission kept, not this week.
  assert.equal(m.sentBack({ corrected: { developer: 4 } }, { role: 'developer', tasks: 9 }), 'You sent back 4 of its tasks this week.');
  assert.equal(m.SHOWN_ONLY, 'Only shown to you; nothing changes by itself from it.');
  assert.equal(m.sentBack({ corrected: {} }, { role: 'developer', tasks: 9 }), null);
  assert.equal(m.sentBack({}, { role: 'tester', tasks: 1 }), null);
  assert.equal(m.sentBack({ corrected: { developer: 2 } }, { role: 'developer', tasks: 0 }), 'You sent back 2 of its tasks this week.', 'never "2 of its 0"');
});

test('a saved model her decisions may not use is said on the page, with what she uses instead', async () => {
  const d = await import('../../web/operator-decide.js');
  const words = texts(d.decidePart({ decide: { ...decideView.decide, modelRefused: 'opus' } }, () => {})).join(' ');
  assert.match(words, /The model saved for her decisions, "opus", is not a small model/);
  assert.match(words, /she decides with haiku, the cheapest, until it is changed in Settings/);
  assert.doesNotMatch(texts(d.decidePart(decideView, () => {})).join(' '), /The model saved for her decisions/);
});

test('the look\'s switch names the model a look runs on, or says in one line why none can start', async () => {
  const lw = await import('../../web/operator-look.js');
  const base = { on: false, perDay: 2, dollarsPerDay: 3, today: { looks: 0, dollars: 0, reserved: 0 }, frozen: null };
  const est = { model: 'Claude Fable 5.2', modelId: 'claude-fable-5-2', usd: 0.2336, tokens: 26_616, measuredOn: '2026-11-19', measuredModel: 'haiku', unknown: [], prices: { input: 8, output: 40, read: '2026-11-19' } };
  assert.match(lw.lookCostWords({ ...base, estimate: est, runsOn: { provider: 'relay', model: 'claude-fable-5-2', label: 'Relay Team' } }), /priced at the list price of Claude Fable 5\.2 \(\$8 a million input tokens.*A look now runs on fable-5-2 of Relay Team\./);
  // The provider by the label the server hands; Auto mode as the Providers page names it; an older server hands none.
  assert.match(lw.lookCostWords({ ...base, estimate: est, runsOn: { provider: 'auto', model: 'opus', label: 'Auto mode' } }), /A look now runs on Opus of Auto mode\./);
  assert.match(lw.lookCostWords({ ...base, estimate: est, runsOn: { provider: 'auto', model: 'opus' } }), /A look now runs on Opus of Auto mode\./, 'an older server: Auto mode all the same');
  assert.match(lw.lookCostWords({ ...base, estimate: est, runsOn: { provider: 'relay', model: 'claude-fable-5-2' } }), /A look now runs on fable-5-2 of relay\./);
  const words = texts(lw.lookPart({ look: { ...base, estimate: est, runsOn: null, cannot: 'relay serves no model of the strongest family (Opus or Fable), so no look starts on it' } }, () => {})).join(' ');
  assert.match(words, /No look can start now: relay serves no model of the strongest family \(Opus or Fable\), so no look starts on it\./);
});

// ---------- Operator has no page: its act cards are rows on Home, its Tia side a fold in Settings -> Tia ----------
const tick = () => new Promise((r) => setTimeout(r, 5));
const attention = (items) => ({ status: 200, body: { items, acts: catalog, needs: items.filter((i) => i.class !== 'info').length, watched: [], timeline: [], hidden: 0, more: 0 } });

test('a Stopped card is a row of Home Needs you with its one button; a card that only informs is not there', async () => {
  const box = h0();
  answers.length = 0;
  answers.push(attention([stuckItem, repoItem]));
  const stop = page.needsYouRows(box);
  await tick();
  stop();
  const t = texts(box);
  assert.ok(t.includes('session alpha') && !t.includes('Needs you'), 'only the rows: the heading and its count are Home\'s group: ' + t.join('|'));
  assert.ok(!t.includes('repository shop'), 'a branch that is only here is not a row');
  assert.ok(!t.includes('For your information') && !t.includes('Watched') && !t.includes('Done by you'), 'no old parts');
  const primary = all(box, (n) => n.tag === 'a' && n.className.split(' ').includes('primary'));
  assert.deepEqual(primary.map((n) => n.attrs['aria-label']), ['Open the session: session alpha']);
  assert.equal(all(box, (n) => n.tag === 'details').length, 1, 'the other steps are behind one closed More');
  assert.equal(all(box, (n) => n.tag === 'details')[0].open, false);
});

test('with nothing to act on the box stays empty, and the Home count is the cards that ask', async () => {
  const box = h0();
  answers.length = 0;
  answers.push(attention([repoItem]));
  const stop = page.needsYouRows(box);
  await tick();
  stop();
  assert.deepEqual(texts(box), []);
  assert.equal(page.homeCount(), 0);
  answers.push(attention([stuckItem]));
  const stop2 = page.needsYouRows(box);
  await tick();
  stop2();
  assert.equal(page.homeCount(), 1);
});

test('the old address of the Operator opens Home; Home draws the rows with the one call', async () => {
  const reg = await import('../../web/registry.js');
  const calls = [];
  globalThis.location = { pathname: '/', hash: '#/operator', replace: (x) => calls.push(x) };
  const p = reg.pageById('operator');
  assert.equal(p.group, null, 'not in the menu');
  p.render({});
  assert.deepEqual(calls, ['#/']);
  const fs = await import('node:fs');
  const home = fs.readFileSync(new URL('../../web/home.js', import.meta.url), 'utf8');
  assert.match(home, /import \{ needsYouRows \} from '\.\/operator\.js'/);
  assert.match(home, /needsYouRows\(opRows,/);
  const src = fs.readFileSync(new URL('../../web/operator.js', import.meta.url), 'utf8');
  assert.match(src, /typeof registry\.registerHomeCount === 'function'/);
});

test('Settings -> Tia: one closed fold holds her switch, the rules, the looks and what she did', async () => {
  const tia = await import('../../web/operator-tia.js');
  answers.length = 0;
  answers.push({ status: 200, body: { ...attention([]).body, reflexes: tiaView(), byTia: [] } }, { status: 200, body: { lookOthers: false } });
  const f = tia.tiaAloneFold();
  await tick();
  assert.equal(f.tag, 'details');
  assert.notEqual(f.open, true, 'closed at first');
  const t = texts(f);
  assert.ok(t.includes('What she may do alone') && t.includes('Done by Tia'), t.join('|'));
  assert.ok(switchOf(f, 'master'), 'her switch is inside');
  assert.ok(t.includes('Look at my other computers too'));
});

test('a session that asks is not a row while its own card is on Home; one that has no card is', () => {
  const asks = { ...stuckItem, kind: 'asks', subject: 'session beta' };
  const card = [{ sessions: [{ name: 'beta', status: 'attention' }] }];
  assert.equal(page.sameAsCard(asks, card), true);
  assert.equal(page.sameAsCard(asks, [{ sessions: [{ name: 'gamma', status: 'attention' }] }]), false);
  const chat = { ...asks, subject: 'chat "Fix it" (99883e68)' };
  assert.equal(page.sameAsCard(chat, [{ sessions: [{ name: 'x', chatId: '99883e68-aaaa', status: 'attention' }] }]), true, 'a chat is found by its id');
  assert.equal(page.sameAsCard(stuckItem, [{ sessions: [{ name: 'alpha', status: 'attention' }] }]), false, 'no progress is Working on Home: its row stays');
});

test('Needs you holds the Operator rows above the session rows, and the one badge is their sum', async () => {
  const reg = await import('../../web/registry.js');
  const home = await import('../../web/home.js');
  const box = h0();
  answers.length = 0;
  answers.push(attention([stuckItem]));
  const counts = [];
  const stop = page.needsYouRows(box, (n) => counts.push(n));
  await tick();
  stop();
  assert.deepEqual(counts, [1]);
  const sessions = [
    { name: 'one', kind: 'claude', status: 'attention', statusAt: 1 },
    { name: 'two', kind: 'claude', status: 'attention', statusAt: 1 },
    { name: 'three', kind: 'claude', status: 'working', statusAt: 1 },
  ];
  const groups = home.homeGroups(sessions, { needsRows: ['providers'], lead: { el: box, n: 1 } });
  const needs = groups.find((g) => g.id === 'needs');
  assert.equal(needs.rows[0], box, 'the Operator rows stand first, above the providers row and the sessions');
  assert.equal(needs.rows.length, 2);
  assert.equal(needs.count, 1 + 1 + 2, 'Operator rows + providers row + sessions that need you');
  assert.equal(groups.find((g) => g.id === 'working').count, 1);
  home.setOwnNeeds(home.ownNeedsCount(groups, 1));
  assert.equal(reg.homeCount(), needs.count, 'the registry sums the Operator count and Home count: the badge equals the group count');
  // A group with no rows is not drawn: no Operator rows, no sessions that need you.
  const quiet = home.homeGroups(sessions.slice(2), { lead: { el: box, n: 0 } });
  assert.deepEqual(quiet.map((g) => g.id), ['working']);
  home.setOwnNeeds(0);
});
