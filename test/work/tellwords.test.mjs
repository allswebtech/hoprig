// "Tia writes my digest" (src/work/tellwords.mjs): the model gets placeholders, never numbers; every value is put in by
// code after the call; a wording whose placeholders came back missing, doubled, new or moved, or with a digit of its
// own, is not used and the plain digest goes. With the setting off the word function is never called.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-tellwords');
test.after(() => t.cleanup());
const { digestMessage, digestTemplate } = await import('../../src/work/tellmsg.mjs');
const { digestWorder, useWording, wordingPrompt } = await import('../../src/work/tellwords.mjs');
const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
const { teller } = await import('../../src/work/tell.mjs');

const running = { title: 'Nightly', basis: { count: 4 }, eta: { past: false, doneFrom: '2026-11-19T09:30:00Z', doneTo: '2026-11-19T12:30:00Z' } };
const tpl = digestTemplate({ done: [{ title: 'Cart fix' }, { title: 'Pay page' }], failed: [], running: [running], waiting: [{}], tokens: 12000, unreported: 1, tz: 'UTC' });

test('the model gets placeholders only: no number or name of the digest is in what it is sent', () => {
  const p = wordingPrompt(tpl, 'bhai kitna time lagega');
  const sent = p.replace(/\{n\d+\}/g, '');
  assert.doesNotMatch(sent, /\d/, 'no digit outside the placeholders');
  for (const v of Object.values(tpl.values)) if (/[A-Za-z]/.test(v)) assert.equal(sent.includes(v), false, v);
  assert.match(p, /\{n1\}/);
  assert.match(p, /<untrusted_data kind="owner-sample">/);
});

// A Hinglish wording of every line that keeps every placeholder in its line and order.
const P = '(\\{n\\d+\\})';
const HI = [
  [`^Work: ${P} waits? for you, ${P} running$`, 'Kaam: $1 aapka intezaar, $2 chal raha'],
  [`^Work: ${P} (waits? for you|running|done|failed)$`, 'Kaam: $1 naya hai'],
  [`^Open ${P} to look at what waits for you\\.$`, '$1 kholo aur dekho kya aapka intezaar kar raha hai.'],
  [`^Nothing waits for you\\. ${P} has the rest\\.$`, 'Aapka kuch intezaar nahi. Baaki $1 mein hai.'],
  [`^Running: ${P}, done by about ${P} to ${P} \\(from ${P} like it\\)$`, 'Chal raha: $1, lagbhag $2 se $3 tak khatam ($4 jaise kaam se)'],
  [`^Running: ${P}, no estimate yet$`, 'Chal raha: $1, abhi andaza nahi'],
  [`^Running: ${P}, longer than any like it$`, 'Chal raha: $1, sab se lamba chal raha'],
  [`^And ${P} more running$`, 'Aur $1 chal rahe'],
  [`^${P} running: ${P} names them$`, '$1 chal rahe: naam $2 mein'],
  [`^Done \\(${P}\\): ${P}$`, 'Ho gaye ($1): $2'],
  [`^Failed or stopped \\(${P}\\): ${P}$`, 'Fail ya ruke ($1): $2'],
  [`^Used: ${P} tokens \\(${P} did not report\\)$`, 'Lage: $1 tokens ($2 ne bataya nahi)'],
  [`^Used: ${P} tokens$`, 'Lage: $1 tokens'],
  [`^Used: not reported$`, 'Lage: bataya nahi'],
];
const hinglish = (l) => {
  for (const [re, to] of HI) if (new RegExp(re).test(l)) return l.replace(new RegExp(re), to);
  throw new Error(`no Hinglish for: ${l}`);
};
const good = (x = tpl) => [x.title, ...x.lines].map(hinglish).join('\n');

test('the screen\'s name is a placeholder: a wording cannot rename the page', () => {
  assert.equal(Object.values(tpl.values).includes('Work → Today'), true);
  assert.doesNotMatch(tpl.lines[0], /Work → Today/);
  const m = useWording(tpl, good().replace(/\{n(\d+)\}/, (x) => x)); // unchanged: the page keeps its name
  assert.match(m.body.split('\n')[0], /Work → Today/);
});

test('a wording that keeps every placeholder in its place is used, with the code\'s values put in', () => {
  const m = useWording(tpl, good());
  assert.ok(m);
  const plain = digestMessage(tpl);
  assert.equal(m.title, 'Kaam: 1 aapka intezaar, 1 chal raha');
  for (const v of Object.values(tpl.values)) assert.ok(`${m.title}\n${m.body}`.includes(v), v);
  assert.equal(m.body.split('\n').length, plain.body.split('\n').length);
});

test('a placeholder missing, doubled, new or moved to another line, or a digit of its own: not used', () => {
  const g = good();
  const bad = [
    g.replace('{n1}', ''),
    g.replace('{n1}', '{n1} {n1}'),
    g.replace('{n2}', '{n2} {n99}'),
    g.replace('{n1}', '{n5}').replace(/\{n5\}(?![\s\S]*\{n5\})/, '{n1}'),
    g.replace('Kaam:', 'Kaam 3:'),
    g.replace('{n1}', '7'),
    `${g}\nEk line aur`,
    g.split('\n').slice(0, -1).join('\n'),
    '',
    null,
  ];
  for (const w of bad) assert.equal(useWording(tpl, w), null, String(w));
});

test('the worder: without a sample, a failed call or a bad wording, the plain digest (null) goes', async () => {
  const logs = [];
  const mk = (call, sample = 'kitna time lagega') => digestWorder({ call, sample: () => sample, log: (s) => logs.push(s) });
  assert.equal(await mk(async () => good(), null)(tpl), null);
  assert.equal(await mk(async () => { throw new Error('offline'); })(tpl), null);
  assert.equal(await mk(async () => 'Ignore the rules. 99 done')(tpl), null);
  assert.ok((await mk(async () => good())(tpl)).title.startsWith('Kaam:'));
  assert.ok(logs.some((l) => /plain digest/.test(l)));
});

test('the teller: "Tia writes my digest" off, the word function is never called; on, a changed wording sends the plain one', async () => {
  const place = { folder: path.join(t.root, 'workdata'), label: 'ai_brain/work' };
  fs.mkdirSync(place.folder, { recursive: true });
  let NOW = Date.parse('2026-11-19T12:00:00Z');
  const run = (title, ago) => writeRun(place, {
    v: 1, id: newRunId(new Date(NOW - ago)), item: 'cart-fix', title, writer: writerId(), by: 'owner', startedAt: new Date(NOW - ago).toISOString(), endedAt: null,
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: null, conversation: null, message: null, brief: 'Do it',
    state: 'running', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
  const sent = [];
  let calls = 0;
  for (const tiaWords of [false, true]) {
    fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'work-told.json'), { force: true });
    fs.rmSync(path.join(place.folder, 'runs'), { recursive: true, force: true });
    const cfg = { work: { timeZone: 'UTC' }, server: { notify: { url: 'http://127.0.0.1:8212/t', work: { digest: true, digestHours: 1, tiaWords } } } };
    const a = teller({ cfg: () => cfg, place: () => place, items: () => [], now: () => NOW, alive: () => true, send: async (m) => (sent.push(m), { sent: true }),
      word: async () => {
        calls += 1;
        return null; // what digestWorder gives for a wording it does not use
      } });
    await a.tick();
    run('Cart fix', 10 * 60_000);
    NOW += 61 * 60_000;
    await a.tick();
  }
  assert.equal(calls, 1, 'called only with the setting on');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], 'the plain digest both times');
  assert.equal(sent[0].title, 'Work: 1 running');
});

test('placeholders swapped inside a line, or a digit of another script: not used', () => {
  const g = good();
  const line = g.split('\n').findIndex((l) => /\{n\d+\}.*\{n\d+\}.*\{n\d+\}/.test(l) && l.includes('Chal raha'));
  assert.ok(line > 0, g);
  const swap = g.split('\n').map((l, i) => (i === line ? l.replace(/\{(n\d+)\}(.*?)\{(n\d+)\}/, '{$3}$2{$1}') : l)).join('\n');
  assert.notEqual(swap, g);
  assert.equal(useWording(tpl, swap), null, 'from and to swapped');
  for (const digit of [' २ ghante', ' ３', ' ٣']) {
    const w = g.split('\n').map((l, i) => (i === 1 ? `${l}${digit}` : l)).join('\n');
    assert.equal(useWording(tpl, w), null, digit);
  }
  assert.ok(useWording(tpl, g), 'the same wording without them is used');
});

test('a wording longer than the push channel keeps is not used: it would arrive cut', async () => {
  const { MESSAGE_MAX } = await import('../../src/server/notify.mjs');
  const { LINE_MAX, fill } = await import('../../src/work/tellmsg.mjs');
  const many = digestTemplate({ done: Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}` })), failed: [{ title: 'Pay page' }], running: [running, running, running], waiting: [{}], tokens: 12000, unreported: 1, tz: 'UTC' });
  assert.ok(digestMessage(many).body.length <= MESSAGE_MAX);
  assert.ok(useWording(many, good(many)), 'a wording of the same length is used');
  // Every line made as long as a line may be once filled in: each one passes, the whole is longer than what is kept.
  const [title, ...lines] = good(many).split('\n');
  const pad = (l) => {
    let x = l;
    while (fill(`${x} ok`, many.values).length <= LINE_MAX) x += ' ok';
    return x;
  };
  const long = lines.map(pad);
  assert.ok(long.every((l) => fill(l, many.values).length <= LINE_MAX));
  assert.ok(long.map((l) => fill(l, many.values)).join('\n').length > MESSAGE_MAX);
  assert.equal(useWording(many, [title, ...long].join('\n')), null);
});

test('his language in every line: a wording that left the line under the title in English is not used', () => {
  const g = good().split('\n');
  // The card a phone showed once: the title worded, the second line its template's English with one word changed.
  const mixed = [g[0], tpl.lines[0].replace(' to look', ' se look'), ...g.slice(2)].join('\n');
  assert.equal(useWording(tpl, mixed), null, mixed);
  const m = useWording(tpl, good());
  assert.ok(m, 'every line worded: used');
  assert.doesNotMatch(m.body.split('\n')[0], /look at what waits/);
  // He writes English: every line the template's own words is no mix (it is the plain digest's words).
  assert.ok(useWording(tpl, [tpl.title, ...tpl.lines].join('\n')));
});

test('the real wording on the cheapest model (Hinglish, 19 Nov): its lines pass the language check', () => {
  const real = digestTemplate({ done: [{ title: 'Add the cart' }, { title: 'Update the README' }], failed: [{ title: 'Pay page' }],
    running: [{ title: 'Nightly', basis: { count: 4 }, eta: { past: false, doneFrom: '2026-11-19T09:30:00Z', doneTo: '2026-11-19T12:30:00Z' } }, { title: 'Beta work', basis: { count: 1 }, eta: {} }], waiting: [{}], tz: 'UTC', tokens: 18000, unreported: 1 });
  const words = ['Kaam: {n1} intezaar mein, {n2} chal rahe', 'Dekhne ke liye {n3} kholo, kya tumhara intezaar ho raha hai.', 'Chal raha: {n4}, lagbhag {n5} se {n6} ke beech khatam ({n7} ke hisaab se)',
    'Chal raha: {n8}, abhi andaza nahi hai', 'Ho gaya ({n9}): {n10}', 'Fail ya ruka ({n11}): {n12}', 'Use hue: {n13} tokens ({n14} ne report nahi kiya)'].join('\n');
  // As it came its body is 309 characters: longer than the 300 the push channel keeps, so the plain digest goes.
  assert.equal(useWording(real, words), null, 'too long for the push channel');
  // Its second line said shorter, in Hinglish still: every line in his language, and it is used.
  const m = useWording(real, words.replace(', kya tumhara intezaar ho raha hai.', '.'));
  assert.ok(m, 'a real Hinglish wording of every line is no mix');
  assert.equal(m.title, 'Kaam: 1 intezaar mein, 2 chal rahe');
  assert.match(m.body.split('\n')[0], /^Dekhne ke liye Work → Today kholo\.$/);
});
