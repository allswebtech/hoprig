// Item 1 of the phone look: the rows of Home, Needs you say in plain words what is wrong and the one thing to do; an act
// that stops something is never the first, red button of a row: it is inside the row's More.
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainRow } from '../../web/operator-plain.js';

// ---- the row in a stand-in DOM
class N {}
class T extends N { constructor(t) { super(); this.text = t; } }
class E extends N {
  constructor(tag) { super(); Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, f) { this.listeners[k] = f; }
  append(...n) { for (const x of n) this.children.push(x instanceof N ? x : new T(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  contains() { return false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.Node = N;
globalThis.document ??= { createElement: (t) => new E(t), createElementNS: (a, t) => new E(t), createTextNode: (t) => new T(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof T ? [n.text] : n.children.flatMap(texts));
const all = (n, f) => (n instanceof T ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c) => all(c, f))]);
const { itemRow } = await import('../../web/operator.js');
const catalog = { end: { label: 'End the process', risk: 'stops', effect: 'Ends it.' }, dismiss: { label: 'Not now', risk: 'none', effect: 'Hides it.' } };

const item = (o) => ({ id: 'x-1', rev: 'r', class: 'machine', since: null, acts: [], facts: [], ...o });

test('a signed-out account says so and the button says Sign in', () => {
  const p = plainRow(item({ kind: 'provider', class: 'stopped', subject: 'provider Claude account (stored login)', facts: ['its sign-in is gone: new sessions on it cannot start'], acts: [{ id: 'open', href: '#/providers', label: 'Open Providers to sign in' }] }));
  assert.equal(p.title, 'Your Claude account is signed out');
  assert.equal(p.line, 'New sessions on it cannot start.');
  assert.equal(p.labels.open, 'Sign in');
});

test('a second dashboard is said without a port and a process number', () => {
  const p = plainRow(item({ kind: 'leftover', subject: 'dashboard on port 7941', facts: ['process 1576869, running for 33 min', 'this dashboard is on port 7433', 'nothing of yours uses the other one'], acts: [{ id: 'end' }] }));
  assert.equal(p.title, 'Another dashboard is running on this computer');
  assert.equal(p.line, 'Nothing uses it. It has run for 33 min.');
  assert.doesNotMatch(`${p.title} ${p.line}`, /\d{4}/);
  assert.equal(p.labels.end, 'End it');
});

test('a busy computer, low memory and a full disk are said plainly', () => {
  const load = plainRow(item({ kind: 'machine', subject: 'load', facts: ['load 70.5 on 16 CPUs (4.4 per CPU)'], acts: [{ id: 'open', href: '#/desktop/tasks', label: 'Open Tasks' }] }));
  assert.equal(load.title, 'This computer is very busy');
  assert.equal(load.line, 'Everything runs slower until it calms down.');
  assert.equal(load.labels.open, 'See what is busy');
  const mem = plainRow(item({ kind: 'machine', subject: 'memory', facts: ['1.2 GB of 16 GB available (7 %)'] }));
  assert.equal(mem.title, 'This computer is low on memory');
  assert.equal(mem.line, 'Only 1.2 GB of 16 GB is free.');
  const disk = plainRow(item({ kind: 'machine', subject: 'disk /home', facts: ['disk /home is 93 % full'] }));
  assert.equal(disk.title, 'The disk /home is almost full');
});

test('a thing it does not know keeps its own words', () => {
  const p = plainRow(item({ kind: 'stuck', class: 'stopped', subject: 'session alpha', facts: ['working, with no progress for 40 min'] }));
  assert.deepEqual([p.title, p.line], ['session alpha', 'working, with no progress for 40 min']);
});

test('a row whose first step stops something has no first button: the step is inside More', () => {
  const it = item({ kind: 'leftover', subject: 'dashboard on port 7941', facts: ['process 1576869, running for 33 min'], acts: [{ id: 'end' }], recommended: 'end' });
  const row = itemRow(it, catalog, () => {});
  const t = texts(row);
  assert.ok(t.includes('Another dashboard is running on this computer'), t.join('|'));
  assert.ok(!t.some((x) => /7941|1576869/.test(x)), 'no port or process number');
  assert.equal(all(row, (n) => String(n.className).includes('primary')).length, 0, 'no first button');
  assert.equal(all(row, (n) => String(n.className).includes('danger')).length, 1, 'the end step is behind More, said as End it');
  assert.ok(t.includes('End it'));
});

test('inside Settings Tia the parts are closed folds: decisions, looks, corrections, rules and what she did', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/operator-tia.js', import.meta.url), 'utf8');
  for (const k of ['decide', 'look', 'corrections', 'rules']) assert.match(src, new RegExp(`part\\('${k}'`), `${k} is a fold of its own`);
  assert.match(src, /fold\('tia-part-done', 'Done by Tia'/);
  const mission = fs.readFileSync(new URL('../../web/mission.js', import.meta.url), 'utf8');
  assert.equal((mission.match(/\bblock\('/g) || []).length, 5, 'Projects, Limits, Providers, Accept by itself and Roles are folds');
  assert.doesNotMatch(mission, /h\('div\.card\.ms-block', h\('h3/);
});

test('a task run that did not finish is named for what it is, not by its run number', () => {
  const p = plainRow(item({ kind: 'ended', class: 'stopped', subject: 'Work run 20260310-133000-a1b2c3d4', facts: ['"Load the images faster" failed 48 min ago'] }));
  assert.equal(p.title, 'A task run did not finish');
  assert.equal(p.line, '"Load the images faster" failed 48 min ago');
  assert.doesNotMatch(JSON.stringify(p), /2026\d{4}-\d{6}/);
  const u = plainRow(item({ kind: 'unknown', class: 'stopped', subject: 'Work run 20260310-133000-a1b2c3d4', facts: ['"Load the images faster" failed 48 min ago'] }));
  assert.equal(u.title, 'A task run did not finish', 'the run that failed for a reason nothing knows');
  assert.equal(plainRow(item({ kind: 'unknown', class: 'stopped', subject: 'task wk-3f2a9c', facts: ['"Load" ended in an error twice'] })).title, 'A task failed twice');
});
