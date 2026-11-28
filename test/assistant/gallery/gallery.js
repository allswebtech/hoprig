// Every kind of Tia's cards in every state, and every kind of message, from fixtures. ?theme=dark forces dark.
import { add, h } from '/lib.js';
import { cardElement, setSource } from '/tiacards.js';
import { messageView } from '/tiamsg.js';
import { formFields } from '/tiacards.js';
import { cardView } from '/tia.js';

const q = new URLSearchParams(location.search);
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');
const now = Date.now();
let n = 0;
const id = () => `v_${String(++n).padStart(12, '0')}`;
const sessions = [
  { name: 'shop', status: 'working', statusAt: now - 4 * 60_000, lastMessage: 'Running the tests now.' },
  { name: 'alpha', status: 'attention', statusAt: now - 60_000, note: 'Allow npm test in alpha?' },
  { name: 'docs', status: 'ended', statusAt: now - 20 * 60_000 },
  { name: 'api', status: 'waiting', statusAt: now - 9 * 60_000, limit: { text: 'limit' } },
];
setSource({
  computers: () => [{ machine: null, status: 'online', sessions }, { machine: 'box2', status: 'offline', sessions: [] }],
  subscribe: () => () => {},
  views: async (ids) => ({ cards: Object.fromEntries(ids.map((x) => [x, null])) }),
  tap: async () => { const e = new Error('that item changed since you saw it'); e.status = 409; e.data = { current: null }; throw e; },
  now: () => Date.now(),
});
const g = document.getElementById('g');
const only = q.get('only');
const section = (t) => add(g, h('h2.g', t));
const card = (c) => add(g, h('div.tia-row.tia.tia-cardrow', cardElement({ id: id(), at: now, ...c })));
let before = null;
const msg = (who, text, at = now) => {
  add(g, messageView(who, text, { at, before }));
  before = at;
};
const status = (sub, title, state, extra = {}) => ({ kind: 'status', subject: { type: 'session', computer: 'this', id: sub }, title, state, since: now - 4 * 60_000, step: { label: state === 'asks' ? 'Answer it' : 'Open the session', href: `#/s/${sub}` }, ...extra });
const prog = (title, state, done, extra = {}) => ({ kind: 'progress', subject: { type: 'job', computer: 'this', id: 'j_0123456789' }, title, steps: ['Session started', 'Working on it', 'Checked', 'Told you'], done, state, started: now - 7 * 60_000, step: { label: 'Open the jobs', href: '#/tia/jobs' }, ...extra });
const need = (i, extra = {}) => ({ id: `limit-${String(i).repeat(12)}`, rev: 'aaaaaaaaaaaa', subject: `session ${['shop', 'alpha', 'api'][i % 3]}`, kind: 'limit', facts: ['provider Main', 'stopped at its usage limit'], why: 'It cannot go on until it moves to another provider.', since: new Date(now - 12 * 60_000).toISOString(), act: { id: 'switch', label: 'Continue on the next provider', risk: 'low' }, ...extra });

section('Messages');
msg('owner', 'shop ka kya haal hai? 🙂');
msg('tia', 'shop abhi tests chala raha hai. **Sab theek** hai, main dekh rahi hoon.');
msg('tia', 'शॉप में लॉगिन पेज ठीक कर दिया है। अब टेस्ट चल रहे हैं।');
msg('tia', 'Three things:\n\n- shop: working\n- alpha: needs your OK\n- docs: finished\n\n| Project | State |\n|---|---|\n| shop | working |\n| alpha | waiting |\n\nRun this once:\n\n```\nnpm test -- --watch=false\n```');
msg('tia', `A long word: ${'Supercalifragilisticexpialidocious'.repeat(2)} and a link https://example.com/a/very/long/path/that/stays/text and <b>tags</b> <script>alert(1)</script>`);
msg('tia', Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer that is folded after about a screen.`).join('\n'));
add(g, h('div.banner.error-box.tia-stopped', { role: 'alert' }, h('span', 'Tia could not finish her answer: the provider did not answer. If it keeps happening, check her provider in Settings → Tia.'), h('button.btn.secondary.small.tia-again', { type: 'button' }, h('span', 'Try again'))));

section('Status: following, asking, at a limit, ended, gone, not reachable, checking');
card(status('shop', 'shop', 'working'));
card(status('alpha', 'alpha: fix the login page', 'asks'));
card(status('api', 'api', 'limit'));
card(status('docs', 'docs', 'ended'));
card(status('old', 'An old session', 'working'));
card({ kind: 'status', subject: { type: 'computer', computer: 'box2', id: 'box2' }, title: 'Build box', state: 'online', step: { label: 'Open the computer', href: '#/m/box2/computer' } });
card({ ...status('shop', 'shop, drawn again from the history: as it is now', 'asks'), at: now - 3_600_000 });
card({ ...prog('A job drawn again from the history: checking', 'working', 1), at: now - 3_600_000 });

section('Progress: pending, following, ended, stuck, gone');
card(prog('Make the cart total use the discount code', 'working', 1));
card(prog('Write the release notes', 'waiting', 2));
card(prog('Fix the footer on small screens', 'done', 4, { ended: now - 60_000 }));
card(prog('Update the screenshots', 'stuck', 2, { ended: now - 120_000 }));
card(prog('A job of yesterday', 'gone', 1));

section('Choice');
card({ kind: 'choice', question: 'Shop ke do project hain. Kis me fix karu?', options: ['shop-web', 'shop-app'], free: false });
card({ kind: 'choice', question: 'Which provider should the new session use?', options: ['Main', 'Second', 'Gateway', 'Ask me each time'], free: true });

section('Form (inside a confirm card)');
const f = formFields({ title: 'Change upload max mb?', fields: [{ name: 'key', label: 'Setting', type: 'readonly', value: 'upload max mb' }, { name: 'current', label: 'Now', type: 'readonly', value: '25' }, { name: 'value', label: 'New value', type: 'number', value: 50, min: 1, max: 1024 }] });
add(g, h('div.tia-card', h('div.tia-card-head', h('h3.tia-card-q', 'Change upload max mb?')), f.el, h('p.tia-card-why', 'Tia asks before anything risky. Nothing happens until you confirm.'), h('div.tia-card-actions', h('button.btn.primary', { type: 'button' }, h('span', 'Confirm')), h('button.btn.secondary', { type: 'button' }, h('span', 'Decline')))));

section('List: a few items, a 40-item list');
card({ kind: 'list', title: 'Sessions', items: [{ label: 'Fix the login test', sub: 'api', state: 'working', href: '#/s/api' }, { label: 'Dark mode', sub: 'web', state: 'waiting', href: '#/s/web' }, { label: 'Allow npm test?', sub: 'alpha', state: 'asks', href: '#/s/alpha' }], total: 3, all: { label: 'Show all', href: '#/' } });
card({ kind: 'list', title: 'Tasks', items: Array.from({ length: 8 }, (_, i) => ({ label: `Task ${i + 1}: ${i === 2 ? 'a very long title that has to wrap on a phone without pushing anything sideways' : 'update the docs'}`, sub: `Due 2026-11-${20 + (i % 9)}`, href: '#/work/tasks' })), total: 40, all: { label: 'Show all', href: '#/work/tasks' } });

section('Numbers');
card({ kind: 'numbers', title: 'Providers: what is used', rows: [{ label: 'Main: 5-hour limit', value: 40, unit: '%', of: 100 }, { label: 'Main: weekly limit', value: 92, unit: '%', of: 100, note: 'Near its limit' }, { label: 'Second', value: 2, unit: 'sessions' }], asOf: now });
card({ kind: 'numbers', title: 'This computer now', rows: [{ label: 'Load', value: 0.8, unit: 'load' }, { label: 'Memory used', value: 61, unit: '%', of: 100 }, { label: 'Disk /', value: 72, unit: '%', of: 100 }], asOf: now });

section('Result: done with Undo, done, failed, refused Undo');
card({ kind: 'result', ok: true, title: 'Added the task: Write the docs', changed: ['Status: open'], see: { label: 'Open Work', href: '#/work/tasks' }, undo: true });
card({ kind: 'result', ok: true, title: 'Stopped the session shop', changed: ['Its conversation is kept: you can continue it later.'], see: { label: 'Open Home', href: '#/' } });
card({ kind: 'result', ok: false, title: 'Stuck: update the screenshots', changed: ['The session ended before the job was finished.'], see: { label: 'Open the jobs', href: '#/tia/jobs' } });

section('Needs you: three items, one gone, a stale tap');
card({ kind: 'needs', items: [need(1), need(2, { act: { id: 'stop', label: 'End the session', risk: 'stops' } }), need(3, { gone: true })], total: 5, all: { label: 'Show all', href: '#/operator' } });

section('Open');
card({ kind: 'open', label: 'Open Providers', href: '#/providers' });
card({ kind: 'open', label: 'Open Settings → Tia', href: '#/settings/tia' });
const planStep = (label, state, note) => ({ label, state, ...(note ? { note } : {}) });
const plan = (state, steps, extra = {}) => ({ kind: 'plan', subject: { type: 'plan', computer: 'this', id: 'p_0123456789' }, title: 'Put the shop live', steps, state, started: now - 95_000, step: { label: 'Open the jobs', href: '#/tia/jobs' }, ...extra });
const shopSteps = ['Save the shop work', 'Check the shop builds', 'Put the shop live'];
section('Plan of three steps: waiting for the tap, running at step two, done, failed at step two with its undo');
add(g, h('div.tia-row.tia.tia-cardrow', cardView({ id: 'c_plan1', tool: 'plan_acts', input: { title: 'Put the shop live', steps: [] }, lines: [], status: 'pending', createdAt: now, expiresAt: now + 20 * 60_000,
  view: { title: 'Put the shop live', why: '', steps: [{ n: 1, what: shopSteps[0], changes: 'Saves the work to its branch.' }, { n: 2, what: shopSteps[1], changes: 'Changes nothing; it runs the build.', wait: '10 min' }, { n: 3, what: shopSteps[2], changes: 'Puts the shop on the internet.' }] } }, () => {})));
card(plan('running', [planStep(shopSteps[0], 'done'), planStep(shopSteps[1], 'running'), planStep(shopSteps[2], 'waiting')]));
card(plan('done', shopSteps.map((l) => planStep(l, 'done')), { ended: now - 20_000 }));
card(plan('failed', [planStep(shopSteps[0], 'undone'), planStep(shopSteps[1], 'failed', 'The build did not pass.'), planStep(shopSteps[2], 'skipped')], { ended: now - 20_000, note: 'Stopped at step 2. Step 1 was taken back.' }));
if (only === 'plan') { const at = [...g.children].findIndex((x) => x.textContent.startsWith('Plan of three steps')); for (const x of [...g.children].slice(0, at)) x.remove(); }
document.body.dataset.ready = '1';
