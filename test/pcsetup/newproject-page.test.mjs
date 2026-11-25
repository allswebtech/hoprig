// New project's brief, scope and "Start with AI" parts (web/newproject.js), without a browser (test/chat/fakedom.mjs):
// what a choice changes, and that the control a keyboard user just used stays on the page (a control drawn again
// loses the focus: the fake DOM counts how often a node was taken out).
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
const np = await import('../../web/newproject.js');
const all = (n, ok) => (n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const choices = () => ({ tools: [{ id: 'claude', name: 'Claude Code' }], tool: 'claude', providers: [{ name: 'main', label: 'Main' }], provider: 'main', models: ['opus'], efforts: ['high'], model: null, effort: null });

test('the scope: choosing one marks it in place, and the radio chosen stays on the page', () => {
  const st = { brief: 'A shop.', kind: '', scope: 'product' };
  const f = np.briefFields(st);
  const radios = all(f.el, (n) => n.tag === 'input' && n.attrs.name === 'np-scope');
  assert.deepEqual(radios.map((r) => r.value), ['product', 'setup']);
  const setup = radios[1];
  setup.listeners.change({ target: setup });
  assert.equal(st.scope, 'setup');
  assert.ok(!setup.taken, 'the radio was not drawn again');
  assert.ok(f.el.contains(setup));
});

test('"Start with AI": switching it shows or hides the choices under it, the switch stays, and the step hears of it', () => {
  const st = { name: 'p', start: true, choices: choices(), v: {} };
  let heard = 0;
  const box = np.startPart(st, () => heard++);
  const toggle = all(box, (n) => n.tag === 'input' && n.attrs.type === 'checkbox')[0];
  assert.equal(byClass(box, 'np-choices').length, 1, 'on: the choices show');
  toggle.listeners.change({ target: { checked: false } });
  assert.equal(st.start, false);
  assert.equal(byClass(box, 'np-choices').length, 0, 'off: they are gone, drawn here and not by a redraw of the step');
  assert.ok(!toggle.taken && box.contains(toggle), 'the switch was not drawn again');
  assert.equal(heard, 1, 'the step is told, to change its button in place');
  toggle.listeners.change({ target: { checked: true } });
  assert.equal(byClass(box, 'np-choices').length, 1);
  assert.match(texts(box).join(''), /Start with AI/);
});

test('the scope\'s radio group has its own name: the label above it', () => {
  const f = np.briefFields({ brief: 'A shop.', kind: '', scope: 'product' });
  const group = all(f.el, (n) => n.attrs.role === 'radiogroup')[0];
  const label = all(f.el, (n) => n.attrs.id === group.attrs['aria-labelledby'])[0];
  assert.ok(label, 'it names its label');
  assert.deepEqual(texts(label), ['What should the AI build?']);
  assert.equal(all(f.el, (n) => n.attrs.role === 'group').length, 0, 'no unnamed group around a named one');
});

test('"Start with AI" promises only what the session does: it may still ask for an OK before it changes files', () => {
  const said = texts(np.startPart({ name: 'p', start: true, choices: choices(), v: {} })).join('');
  assert.doesNotMatch(said, /without asking again/);
  assert.match(said, /it may still ask for your OK before it changes a file or runs a command/);
  assert.match(said, /"Allow all edits in this session" stops it asking for edits/);
});

test('no provider: the step cannot start the session, says where to add one (a link), and a failed start says it plainly', () => {
  const none = { ...choices(), providers: [], provider: null };
  assert.equal(np.aiReady({ choices: none, v: {} }), false, 'the button only makes the project');
  assert.equal(np.aiReady({ choices: null, v: {} }), true, 'not loaded yet: the server decides');
  assert.equal(np.aiReady({ choices: { ...choices(), provider: null }, v: { provider: 'main' } }), true, 'one chosen');
  const box = np.startPart({ name: 'p', start: true, choices: none, v: {} });
  const a = all(box, (n) => n.tag === 'a')[0];
  assert.ok(a && a.attrs.href === '#/providers' && texts(a).join('') === 'Providers', 'Providers is a link');
  const failed = np.startFailed(Object.assign(new Error('There is no provider for this coding tool yet: add one under Providers first'), { code: 'no-provider' }), () => {});
  assert.equal(texts(failed).join(''), 'The project is ready, but the session did not start: there is no provider for this coding tool yet. Add one under Providers, then try again.Start with AI', 'one plain sentence, no capital in its middle');
  assert.ok(all(failed, (n) => n.tag === 'a' && n.attrs.href === '#/providers').length === 1, 'and a link to Providers');
  assert.equal(all(failed, (n) => n.tag === 'button').length, 1);
});

test('a project made with a brief but not started: the done step says so and offers "Start with AI"; a failed start says why', () => {
  const later = np.startLater({ name: 'later-one', brief: 'A shop.', choices: null, v: {} }, null);
  assert.match(texts(later).join(''), /Its AI session has not started yet: start it now, or later with hoprig project start later-one\./);
  const buttons = all(later, (n) => n.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.match(texts(buttons[0]).join(''), /Start with AI/);
  assert.ok(buttons[0].className.split(' ').includes('primary'), 'the done step\'s main button');
  const failed = np.startLater({ name: 'x', choices: null, v: {} }, null, Object.assign(new Error('The coding tool is not installed'), { code: 'x' }));
  assert.match(texts(failed).join(''), /the session did not start: the coding tool is not installed\.Start with AI$/, 'the server\'s sentence goes on the sentence, not with a capital in the middle');
});

test('after a refused brief the focus can go to the brief, the field to change', () => {
  const f = np.briefFields({ brief: 'A shop\u200b.', kind: '', scope: 'product' });
  document.body.append(f.el);
  f.problem('the brief has characters in it that cannot be seen (the first is U+200B): take them out', 'A shop.');
  f.focus();
  assert.equal(document.activeElement, all(f.el, (n) => n.tag === 'textarea')[0]);
  f.el.remove();
});

const h0 = (list) => ({ children: list, tag: 'div', attrs: {} });
// h() sets a property the element has, else an attribute (the fake DOM's elements have neither property): either way.
const on = (n, k) => n[k] === true || n.attrs[k] === '' || n.attrs[k] === true;

test('"Add the New Project skill" is ticked at first; unticked, the request says so; with a brief it stays on', () => {
  const st = { name: 'p', brief: '', kind: '', scope: 'product', skill: true };
  const part = np.optionsPart(st);
  const box = all(part, (n) => n.tag === 'input' && n.attrs.type === 'checkbox' && n.attrs.name === 'np-skill')[0];
  assert.ok(box, 'the checkbox');
  assert.equal(on(box, 'checked'), true, 'ticked by default');
  assert.match(texts(part).join(''), /Add the New Project skill/);
  assert.equal(np.newBody(st).skill, undefined, 'ticked: the server\'s default, nothing to say');
  box.listeners.change({ target: { checked: false } });
  assert.equal(st.skill, false);
  assert.equal(np.newBody(st).skill, false, 'unticked: the route is told');
  assert.equal(np.willLines(st).length, 0, 'and "What exactly" lists no skill');
  st.skill = true;
  assert.match(texts(h0(np.willLines(st))).join(''), /The New Project skill/);
  const withBrief = { name: 'p', brief: 'A shop.', kind: '', scope: 'product', skill: false };
  const b2 = all(np.optionsPart(withBrief), (n) => n.tag === 'input' && n.attrs.name === 'np-skill')[0];
  assert.equal(on(b2, 'checked'), true, 'a brief is set up with the skill');
  assert.equal(on(b2, 'disabled'), true);
  assert.equal(np.newBody(withBrief).skill, undefined);
  assert.equal(np.newBody(withBrief).brief, 'A shop.');
});

test('"Add skills that fit its technology" is ticked at first, says what it does, and the request carries the choice', () => {
  const st = { name: 'p', brief: '', kind: '', scope: 'product', skill: true };
  const part = np.optionsPart(st);
  const box = all(part, (n) => n.tag === 'input' && n.attrs.name === 'np-fit')[0];
  assert.ok(box, 'the checkbox');
  assert.equal(on(box, 'checked'), true, 'ticked by default');
  assert.ok(texts(part).join('').includes(np.FIT_WORDS));
  assert.equal(np.FIT_WORDS, 'Add skills that fit its technology: text-only skills from your own and from the reviewed catalog go in by themselves, with Undo; anything else waits for you.');
  assert.equal(np.newBody(st).fit, true);
  box.listeners.change({ target: { checked: false } });
  assert.equal(np.newBody(st).fit, false, 'unticked: the route is told');
  assert.equal(np.newBody({ ...st, brief: 'A shop.', fit: false }).fit, false, 'with a brief too');
});
