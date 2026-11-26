// What Tia keeps of the owner's corrections (src/operator/corrections.mjs): nothing while its switch is off, one small
// record each (his own words masked and cut to 500 characters), at most 200 a day, kept 90 days, "Forget these" in one
// press, only his page reads or writes them, evidence in the loop's shape for skills only, and no field report carries
// a word of them. Made-up names only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-corrections');
test.after(() => box.cleanup());
const c = await import('../../src/operator/corrections.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');
const { setHold, heldUntil } = await import('../../src/operator/decide-store.mjs');
const { checkRoute } = await import('../../src/assistant/door.mjs');
const { doRoutes } = await import('../../src/work/dofeature.mjs');
const { buildReport } = await import('../../src/field/report.mjs');
const { reportText, strictReport } = await import('../../src/field/shape.mjs');
const { stateDir } = await import('../../src/paths.mjs');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 24 * 3600_000;
const ON = { operator: { corrections: { on: true } } };
const file = () => path.join(stateDir(), 'operator', 'corrections.jsonl');
const reset = () => fs.rmSync(file(), { force: true });
const TOKEN = `hwt_${'x'.repeat(24)}`; // a made-up Work token's shape: masked as every such shape is

test('off when absent: nothing is kept and nothing written', () => {
  reset();
  assert.deepEqual(c.readCorrections({}), { on: false, perDay: 200 });
  assert.equal(c.readCorrections({ operator: { corrections: { on: 'yes' } } }).on, false);
  assert.equal(c.noteCorrection({}, { kind: 'undo', about: { rule: 'limit' } }, NOW), false);
  assert.equal(fs.existsSync(file()), false);
  assert.deepEqual(c.applyCorrectionsPatch({}, { on: true }), { on: true });
  assert.throws(() => c.applyCorrectionsPatch({}, { on: true, perDay: 999 }), /corrections is/);
});

test('one small record: its kind, what it belongs to, when, and his own words masked and cut to 500 characters', () => {
  reset();
  const words = `Wait for the reset ${TOKEN} first.​ ${'x'.repeat(700)}`;
  assert.equal(c.noteCorrection(ON, { kind: 'sent-back', about: { role: 'developer', other: 'x' }, words }, NOW), true);
  const [r] = c.listCorrections(NOW);
  assert.deepEqual(Object.keys(r).sort(), ['about', 'at', 'kind', 'words']);
  assert.deepEqual(r.about, { role: 'developer' }, 'only what it belongs to, of the four it may');
  assert.equal(r.kind, 'sent-back');
  assert.ok(r.words.length <= 500, String(r.words.length));
  assert.ok(!r.words.includes(TOKEN), 'a token is masked');
  assert.ok(!r.words.includes('​'), 'a character nobody can see is taken out');
  assert.equal(c.noteCorrection(ON, { kind: 'pushed', about: { rule: 'limit' } }, NOW), false, 'a kind that is not one of the six');
  assert.equal(c.noteCorrection(ON, { kind: 'undo', about: { rule: '../x y' } }, NOW), false, 'a name that is not a plain id');
  assert.equal(c.noteCorrection(ON, { kind: 'undo', about: {} }, NOW), false);
  assert.equal(c.listCorrections(NOW).length, 1);
});

test('his kept words: a home folder of any system, this computer\'s own folders and an e-mail address are masked', () => {
  const w = c.keptWords('see /home/alex/secret/plan.txt and C:\\Users\\alex\\x.txt, mail alex@example.com');
  assert.doesNotMatch(w, /alex/, w);
  assert.match(w, /~\/secret\/plan\.txt/);
  assert.match(w, /mail \*\*\*/);
  // This computer's own home, whatever its name (read at the test's run, never written here).
  assert.equal(c.keptWords(`in ${path.join(os.homedir(), 'notes', 'a.txt')} please`), `in ${path.join('~', 'notes', 'a.txt')} please`);
  assert.equal(c.keptWords('in /srv/data/home/notes.txt'), 'in /srv/data/home/notes.txt', 'a folder named home inside a path is no home folder');
  assert.equal(c.keptWords('Wait for the reset first.'), 'Wait for the reset first.', 'plain words stay as he wrote them');
});

// His kept words, case by case: what he said, and what is kept of it.
const KEPT = [
  ['see `/home/alex/plan.txt`', 'see `~/plan.txt`'],
  ['open file:///home/alex/plan.txt', 'open file://~/plan.txt'],
  ['at [/home/alex/x](x)', 'at [~/x](x)'],
  ['</Users/alex/x>', '<~/x>'],
  ['in `C:\\Users\\alex\\x.txt`', 'in `~\\x.txt`'],
  ['ssh alex@box2 now', 'ssh *** now'],
  ['I logged in as alex@box2.', 'I logged in as ***.'],
  ['try alex@box2...', 'try ***...'],
  ['as alex@box2, then', 'as ***, then'],
  ['(alex@box2)', '(***)'],
  ['ssh alex@192.168.1.5', 'ssh ***'],
  ['ssh alex@10.0.0.5.', 'ssh ***.'],
  ['pin react@18.3.1 first', 'pin react@18.3.1 first'],
  ['pin lodash@latest', 'pin lodash@latest'],
  ['npm i react@next', 'npm i react@next'],
  ['use @scope/ui@beta here', 'use @scope/ui@beta here'],
  ['cd ~/home/alex', 'cd ~/home/alex'],
  ['in /srv/data/home/notes.txt', 'in /srv/data/home/notes.txt'],
  ['Wait for the reset first.', 'Wait for the reset first.'],
];
for (const [said, kept] of KEPT) test(`his kept words: ${JSON.stringify(said)} is kept as ${JSON.stringify(kept)}`, () => assert.equal(c.keptWords(said), kept));

test('at most 200 a day; kept 90 days; "Forget these" is one press', () => {
  reset();
  for (let i = 0; i < 205; i++) c.noteCorrection(ON, { kind: 'other-answer', about: { decision: 'limit' } }, NOW + i);
  assert.equal(c.listCorrections(NOW + 300).length, 200);
  assert.equal(c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' } }, NOW + DAY + 1000), true, 'the next day counts again');
  assert.equal(c.listCorrections(NOW + 92 * DAY).length, 0, 'older than 90 days: gone from what is read');
  assert.equal(c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' } }, NOW + 92 * DAY), true);
  assert.equal(fs.readFileSync(file(), 'utf8').trim().split('\n').length, 1, 'and from the file when the next one is kept');
  assert.equal(c.forgetCorrections(NOW + 92 * DAY), 1);
  assert.equal(fs.existsSync(file()), false);
});

test('a record older than 90 days goes from the file at the next read, also with the switch off', () => {
  reset();
  assert.equal(c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' }, words: 'never deploy on friday' }, NOW - 91 * DAY), true);
  assert.match(fs.readFileSync(file(), 'utf8'), /never deploy on friday/);
  assert.equal(c.noteCorrection({}, { kind: 'undo', about: { rule: 'limit' } }, NOW), false, 'the switch is off');
  assert.equal(c.correctionCounts(NOW).total, 0, 'what the page reads');
  assert.doesNotMatch(fs.readFileSync(file(), 'utf8'), /never deploy on friday/, 'and the line is gone from the file');
});

test('"Forget these" removes the evidence written from them too, and evidence older than 90 days goes', () => {
  reset();
  c.noteCorrection(ON, { kind: 'undo', about: { skill: 'shop-deploy' }, words: 'words he typed today' }, NOW);
  const e = c.writeEvidence(NOW);
  assert.match(fs.readFileSync(e.file, 'utf8'), /words he typed today/);
  assert.equal(c.forgetCorrections(NOW), 1);
  assert.equal(fs.existsSync(e.file), false, 'the evidence file is gone with them');
  c.noteCorrection(ON, { kind: 'undo', about: { skill: 'shop-deploy' }, words: 'old words of his' }, NOW);
  c.writeEvidence(NOW);
  c.correctionCounts(NOW + 91 * DAY);
  assert.equal(fs.existsSync(e.file), false, 'a line seen 91 days ago goes from the evidence file');
});

test('what the pages show: this week per rule, decision, skill and role', () => {
  reset();
  for (let i = 0; i < 3; i++) c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' } }, NOW - i * DAY);
  c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' } }, NOW - 10 * DAY); // not this week
  c.noteCorrection(ON, { kind: 'sent-back', about: { role: 'developer' } }, NOW);
  c.noteCorrection(ON, { kind: 'undo', about: { skill: 'checkout' } }, NOW);
  const n = c.correctionCounts(NOW);
  assert.equal(n.week.rule.limit, 3);
  assert.equal(n.week.role.developer, 1);
  assert.equal(n.week.skill.checkout, 1);
  assert.equal(n.total, 6);
  assert.equal(n.byKind.undo, 5);
  c.noteCorrection(ON, { kind: 'declined', about: { decision: 'git_commit' } }, NOW);
  c.noteCorrection(ON, { kind: 'plan-changed', about: { decision: 'plan' } }, NOW);
  c.noteCorrection(ON, { kind: 'undo', about: { decision: 'limit' } }, NOW);
  const k = c.correctionCounts(NOW).decisionKinds;
  assert.deepEqual([k.declined, k['plan-changed'], k.undo], [1, 1, 1], 'a decision\'s corrections this week, by their kind');
});

test('"Use these as evidence": the skill corrections in the loop\'s shape, one file; rules and roles are left out', () => {
  reset();
  c.noteCorrection(ON, { kind: 'undo', about: { skill: 'checkout' }, words: 'Use the card for this, not a chat.' }, NOW);
  c.noteCorrection(ON, { kind: 'undo', about: { skill: 'cart' } }, NOW);
  c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' } }, NOW);
  c.noteCorrection(ON, { kind: 'sent-back', about: { role: 'developer' } }, NOW);
  const r = c.writeEvidence(NOW);
  assert.equal(r.lines, 2);
  assert.equal(r.leftOut, 2);
  assert.equal(r.file, path.join(stateDir(), 'operator', 'evidence.jsonl'));
  const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { target: 'skill:checkout', kind: 'correction', text: 'Use the card for this, not a chat.', seen: '2026-11-19' });
  assert.deepEqual(Object.keys(lines[1]).sort(), ['kind', 'seen', 'target', 'text']);
  assert.equal(lines[1].target, 'skill:cart');
  // After the toast has gone the panel still names where it is, home shown as ~ where it lies inside it.
  const kept = c.correctionCounts(NOW).evidence;
  assert.equal(kept.lines, 2, 'the panel can still say where it is after the toast');
  assert.ok(kept.file.endsWith(path.join('operator', 'evidence.jsonl')), kept.file);
});

const fail = class extends Error {
  constructor(s, m) {
    super(m);
    this.status = s;
  }
};
const feature = (who, cfg) => operatorFeature({ HttpError: fail, caller: () => who, readJson: async () => ({}), config: () => cfg, saveConfig: () => {} }, { sources: {}, accounts: async () => ({ profiles: [] }) });
const route = (f, method, url) => f.routes.find(([m, re]) => m === method && re.test(url))[2];

test('only his page reads, forgets or writes them: another computer and Tia are refused', async () => {
  reset();
  c.noteCorrection(ON, { kind: 'undo', about: { rule: 'limit' } }, Date.now());
  for (const who of ['computer', 'self']) {
    const f = feature(who, ON);
    for (const [m, u] of [['GET', '/api/operator/corrections'], ['POST', '/api/operator/corrections/forget'], ['POST', '/api/operator/corrections/evidence']]) {
      await assert.rejects(route(f, m, u)({ url: u }), (e) => e.status === 403, `${who} ${u}`);
    }
    f.close();
  }
  for (const [m, u] of [['GET', '/api/operator/corrections'], ['POST', '/api/operator/corrections/forget'], ['POST', '/api/operator/corrections/evidence'], ['POST', '/api/operator/settings']]) {
    assert.throws(() => checkRoute(m, u, m === 'POST' ? {} : undefined), /./, `Tia's door: ${u}`);
  }
  const f = feature('page', ON);
  assert.equal((await route(f, 'GET', '/api/operator/corrections')({ url: '/api/operator/corrections' })).total, 1);
  const ev = await route(f, 'POST', '/api/operator/corrections/evidence')({ url: '/x' });
  assert.equal(ev.file, path.join('operator', 'evidence.jsonl'), 'it says where, inside the state folder');
  assert.match(ev.said, /written as evidence for the improvement loop, into /);
  assert.ok(ev.said.includes(path.join(stateDir(), 'operator', 'evidence.jsonl')) || ev.said.includes('~/'), ev.said);
  assert.match(ev.said, /left out: the loop improves skills only\. The improvement loop is not started: you start it yourself\./);
  assert.doesNotMatch(ev.said, /Hoprig's state folder/, 'a place he can find, not a word for it');
  assert.equal(c.correctionCounts(Date.now()).evidence, null, 'no line of skills was written: nothing to name');
  assert.match((await route(f, 'POST', '/api/operator/corrections/forget')({ url: '/x' })).said, /1 correction is forgotten/);
  assert.equal(c.listCorrections().length, 0);
  f.close();
});

test('lifting her hold is a correction; lifting only his own is not', async () => {
  reset();
  const f = feature('page', ON);
  const lift = route(f, 'POST', '/api/operator/hold');
  setHold(Date.now() + 30 * 60_000, Date.now(), 'owner');
  await lift({ url: '/x' });
  assert.equal(c.listCorrections().length, 0, 'his own hold');
  setHold(Date.now() + 30 * 60_000, Date.now(), 'tia');
  await lift({ url: '/x' });
  assert.equal(heldUntil(), null);
  assert.deepEqual(c.listCorrections().map((r) => [r.kind, r.about]), [['hold-lifted', { decision: 'machine' }]]);
  f.close();
});

test('a mission\'s task sent back with words reaches the record\'s door with them', async () => {
  const seen = [];
  const r = doRoutes({ runs: { sendBack: async () => ({ item: 'cart-total' }) }, readJson: async () => ({ at: 0, text: 'Keep the old total too.' }), refOf: () => 'cart-total', ownerOnly: () => {}, resume: async () => {}, corrected: (...a) => seen.push(a) });
  const [, , fn] = r.find(([m, re]) => m === 'POST' && re.test('/api/work/items/cart-total/send-back'));
  await fn({}, '/api/work/items/cart-total/send-back'.match(/^\/api\/work\/items\/([^/]+)\/send-back$/));
  assert.deepEqual(seen, [['sent-back', 'cart-total', 'Keep the old total too.']]);
});

test('no field report carries a word of them: its shape has no place for one', () => {
  reset();
  c.noteCorrection(ON, { kind: 'sent-back', about: { role: 'developer' }, words: 'my secret plan for the shop' }, Date.now());
  const r = buildReport({ kind: 'doctor', steps: [], corrections: c.listCorrections(), words: 'my secret plan for the shop' });
  const text = reportText(r);
  assert.ok(strictReport(text));
  assert.doesNotMatch(text, /secret plan|correction|developer|sent-back/);
  assert.equal(strictReport(text.replace(/\}\s*$/, ',"corrections":[{"words":"my secret plan"}]}')), null, 'a report with such a field is refused');
});
