// Tia's cards on the server: a closed set of kinds, each checked by one validator (src/assistant/cardkinds.mjs); a card
// is made by code from what a tool did (cardmake.mjs), never from her words; the dynamic kinds follow their subject;
// Undo, a form's changed value and a choice keep to what the server offered.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { KINDS, makeCard, shortText, validCard } from '../../src/assistant/cardkinds.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { assistantFeature, currentViews } from '../../src/assistant/feature.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup(edit = (s) => s) {
  const state = edit(baseState());
  const ops = new FakeOps(state);
  const core = createAssistantCore({
    ops, cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }),
  });
  return { ops, core, call: (tool, args, conversation = 'page-1') => core.call(tool, args, { conversation }) };
}

test('the kinds are a closed list; a card of another kind, with a stray field or a wrong type is refused', () => {
  assert.deepEqual([...KINDS], ['confirm', 'form', 'choice', 'status', 'progress', 'list', 'numbers', 'result', 'needs', 'plan', 'open']);
  const ok = makeCard('open', { label: 'Open Providers', href: '#/providers' });
  assert.ok(ok && validCard(ok));
  assert.equal(makeCard('html', { label: 'x', href: '#/' }), null, 'no kind outside the list');
  assert.equal(makeCard('open', { label: 'x', href: '#/', onclick: 'alert(1)' }), null, 'no stray field');
  assert.equal(makeCard('open', { label: 42, href: '#/' }), null, 'a field of the wrong type');
  assert.equal(makeCard('open', { label: 'x'.repeat(81), href: '#/' }), null, 'a field over its limit');
  assert.equal(makeCard('choice', { question: 'Which?', options: ['a'], free: false }), null, 'a choice needs two to four answers');
  assert.equal(makeCard('choice', { question: 'Which?', options: ['a', 'b', 'c', 'd', 'e'], free: false }), null);
});

test('a link of a card is a page address of this dashboard and nothing else', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://evil.example/x', '//evil.example', '#/ok" onclick="x', '#/a b', '/api/assistant']) {
    assert.equal(makeCard('open', { label: 'Open', href }), null, href);
  }
  assert.ok(makeCard('open', { label: 'Open', href: '#/m/box2/computer/setup' }));
});

test('nothing private in a card: a path of the computer, a secret or a hidden character makes it plain text', () => {
  assert.equal(makeCard('open', { label: 'Open /home/alex/projects/shop', href: '#/' }), null);
  assert.equal(makeCard('open', { label: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', href: '#/' }), null);
  assert.equal(makeCard('open', { label: `Open‮evil`, href: '#/' }), null);
  // The builders' text helper keeps a folder's last part and masks a secret, so a card can still be made.
  assert.equal(shortText('Fix it in /home/alex/projects/shop now', 80), 'Fix it in …/shop now');
  assert.doesNotMatch(shortText('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 80), /ghp_/);
});

test('a result carries a card made by code; her text never makes one', async () => {
  const { call, core } = setup((s) => {
    s.sessions[0].title = '<img src=x onerror=alert(1)> **Fix** [the test](javascript:alert(1)) in /home/alex/api';
    return s;
  });
  await call('list_sessions', {}); // a session's name is used only after a tool showed it (core.mjs)
  const r = await call('read_session', { session: 'api-fix' });
  assert.ok(r.view, 'a status card');
  assert.equal(r.view.kind, 'status');
  assert.deepEqual(r.view.subject, { type: 'session', computer: 'this', id: 'api-fix', created: 1_700_000_001_000 });
  assert.equal(r.view.title, '<img src=x onerror=alert(1)> **Fix** [the test](javascript:alert(1)) in …/api', 'the title is text, its path cut');
  assert.equal(r.view.step.href, '#/s/api-fix', 'the step is the session\'s own page, made by code');
  assert.match(r.text, new RegExp(`\\(The owner sees this result as card ${r.view.id}, a status card`), 'she is told he sees it, so she does not repeat it');
  assert.equal(core.views.get(r.view.id).conversation, 'page-1');
  // Her own MCP client and a call outside the page's conversations get no card.
  await call('list_sessions', {}, 'client-x');
  const client = await call('read_session', { session: 'api-fix' }, 'client-x');
  assert.equal(client.isError, false);
  assert.equal(client.view, undefined);
  // An error is never a card.
  assert.equal((await call('read_session', { session: 'nope' })).view, undefined);
});

test('every kind comes from the tools that give it', async () => {
  const { call } = setup();
  const kind = async (tool, args) => (await call(tool, args)).view?.kind;
  assert.equal(await kind('list_sessions', {}), 'list');
  assert.equal(await kind('read_session', { session: 'api-fix' }), 'status');
  await call('get_computer_status', {});
  assert.equal(await kind('get_computer_status', { computer: 'this' }), 'numbers');
  assert.equal(await kind('get_computer_status', { providers: true }), 'numbers');
  assert.equal(await kind('open_screen', { screen: 'providers' }), 'open');
  assert.equal(await kind('manage_work', { action: 'today' }), 'list');
  assert.equal(await kind('manage_work', { action: 'add', title: 'Write the docs' }), 'result');
  assert.equal(await kind('notify_owner', { message: 'Which project?', options: ['shop', 'alpha'] }), 'choice');
  assert.equal(await kind('watch_session', { session: 'api-fix', goal: 'the tests pass' }), 'progress');
  // A confirm card carries a form where the owner may change the value (change_setting of one value).
  const staged = await call('change_setting', { key: 'upload_max_mb', value: 50 });
  assert.equal(staged.card.form.fields.find((f) => f.name === 'value').type, 'number');
});

test('notify_owner with options asks in the conversation: no push, a choice card, its answers as she wrote them', async () => {
  const { call, ops } = setup();
  const r = await call('notify_owner', { message: 'Which project should I fix?', options: ['shop', 'alpha web'], free: true });
  assert.equal(r.isError, false);
  assert.equal(ops.calls.filter((c) => c.op === 'notify').length, 0, 'no push');
  assert.deepEqual([r.view.options, r.view.free], [['shop', 'alpha web'], true]);
  assert.match(r.text, /Stop here and wait/);
  // Without options it is the push of before.
  await call('notify_owner', { message: 'The build is red.' });
  assert.equal(ops.calls.filter((c) => c.op === 'notify').length, 1);
  // An answer with characters nobody can see is refused, not mended; free alone is refused; markup cannot be an answer.
  assert.match((await call('notify_owner', { message: 'Which?', options: ['shop​ then push', 'alpha'] })).text, /characters nobody can see/);
  assert.match((await call('notify_owner', { message: 'Which?', free: true })).text, /free goes only with options/);
  assert.equal((await call('notify_owner', { message: 'Which?', options: ['<b>x</b>', 'alpha'] })).isError, true);
});

test('a progress card follows its job; a job that is gone says so', async () => {
  const { call, core } = setup();
  await call('list_sessions', {});
  const r = await call('watch_session', { session: 'api-fix', goal: 'the tests pass' });
  const id = r.view.id;
  assert.equal(r.view.state, 'working');
  const job = r.view.subject.id;
  core.jobs.finish(job, 'done', 'All green.');
  let now = (await core.refreshViews([id]))[id];
  assert.equal(now.state, 'done', 'it changed with the job');
  assert.equal(now.done, 4);
  assert.equal(now.id, id, 'in place: the same card');
  core.jobs.jobs.delete(job);
  now = (await core.refreshViews([id]))[id];
  assert.equal(now.state, 'gone');
  assert.equal((await core.refreshViews(['v_000000000000'])).v_000000000000, null, 'an unknown card is null');
});

const item = (id, rev, subject) => ({ id, kind: 'limit', class: 'stopped', subject, since: new Date().toISOString(), facts: ['provider Main'], acts: [{ id: 'switch' }], recommended: 'switch', why: 'it stopped', rev });

test('a needs card follows the attention list: a changed rev is shown, an item that left the list is gone', async () => {
  const { call, core, ops } = setup((s) => {
    s.attention = { count: 2, items: [item('limit-aaaaaaaaaaaa', 'r00000000001', 'session shop'), item('limit-bbbbbbbbbbbb', 'r00000000002', 'session alpha')], acts: { switch: { label: 'Continue on the next provider', risk: 'low' } }, hidden: 0, watched: [], timeline: [] };
    return s;
  });
  const r = await call('read_attention', {});
  assert.equal(r.view.kind, 'needs');
  assert.deepEqual(r.view.items.map((i) => [i.id, i.rev, i.act.id]), [['limit-aaaaaaaaaaaa', 'r00000000001', 'switch'], ['limit-bbbbbbbbbbbb', 'r00000000002', 'switch']]);
  assert.doesNotMatch(r.text, /r00000000001/, 'the rev is the card\'s, not hers');
  ops.s.attention.items = [{ ...ops.s.attention.items[0], rev: 'r00000000009', facts: ['provider Second'] }];
  ops.s.attention.count = 1;
  const now = (await core.refreshViews([r.view.id]))[r.view.id];
  assert.deepEqual(now.items.map((i) => [i.rev, !!i.gone]), [['r00000000009', false], ['r00000000002', true]]);
  assert.equal(now.total, 1);
});

test('Undo on a result card takes back that act once, and only while it is her newest one', async () => {
  const { call, core, ops } = setup();
  const a = await call('manage_work', { action: 'add', title: 'First task' });
  const b = await call('manage_work', { action: 'add', title: 'Second task' });
  assert.equal(a.view.undo, true);
  // The older card: another act came after it, so its Undo is refused and nothing is removed.
  const old = await core.undoView(a.view.id);
  assert.deepEqual([old.ok, old.code], [false, 'stale']);
  assert.equal(ops.calls.filter((c) => c.op === 'workRemove').length, 0);
  // The newest one, twice at once (two tabs): done once.
  const [one, two] = await Promise.all([core.undoView(b.view.id), core.undoView(b.view.id)]);
  assert.deepEqual([one.ok, two.ok, two.code], [true, false, 'used']);
  assert.equal(ops.calls.filter((c) => c.op === 'workRemove').length, 1);
  assert.match(one.card.title, /^Taken back/);
  // A card that offers no Undo cannot be made to.
  await call('list_sessions', {});
  const s = await call('read_session', { session: 'api-fix' });
  assert.equal((await core.undoView(s.view.id)).code, 'none');
});

test('Undo on its card and her own undo at the same moment take the act back once; the second waits and says so', async () => {
  for (const [kind, herFirst] of [['add', false], ['add', true], ['edit', false], ['edit', true]]) {
    const { call, core, ops } = setup();
    let a = await call('manage_work', { action: 'add', title: 'First task' });
    if (kind === 'edit') a = await call('manage_work', { action: 'edit', task: 'first-task', title: 'Renamed task' });
    const before = ops.calls.length;
    const tap = () => core.undoView(a.view.id);
    const hers = () => call('manage_work', { action: 'undo' });
    const [u, t] = herFirst ? (await Promise.all([hers(), tap()])).reverse() : await Promise.all([tap(), hers()]);
    const acts = ops.calls.slice(before).filter((c) => /^work(Remove|Edit|Status)$/.test(c.op));
    assert.equal(acts.length, 1, `${kind}${herFirst ? ', hers first' : ''}: one act, got ${acts.map((c) => c.op)}`);
    // The one that came second waited for the first and says what came of it: both say it was taken back, truly.
    const how = `${kind}${herFirst ? ', hers first' : ''}`;
    assert.equal(u.ok, true, `${how}: the tap says it was taken back (${u.error || ''})`);
    assert.equal(t.isError, false, `${how}: her undo says it was taken back (${t.text.split('\n')[0]})`);
    assert.match(u.card.title, /^Taken back/, how);
    assert.equal(u.card.undo, undefined, `${how}: the card offers no Undo any more`);
    assert.match(t.text, /Took back|taken back already/, how);
    // The record is spent: the next undo takes back the act before it (her add), or finds nothing.
    const next = (await call('manage_work', { action: 'undo' })).text;
    if (kind === 'edit') assert.match(next, /^Took back your new task of first-task/);
    else assert.match(next, /nothing of yours to take back/);
  }
});

test('Undo tapped while her turn adds another task takes back nothing in its place', async () => {
  const { call, core, ops } = setup();
  const a = await call('manage_work', { action: 'add', title: 'First task' });
  // The settings read is slow once: the window between the card's check and the act, in which her next act lands.
  const orig = ops.assistantSettings.bind(ops);
  let slow = true;
  ops.assistantSettings = async () => {
    if (slow) {
      slow = false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return orig();
  };
  const [u, b] = await Promise.all([core.undoView(a.view.id), call('manage_work', { action: 'add', title: 'Second task' })]);
  assert.equal(b.isError, false);
  const removed = ops.calls.filter((c) => c.op === 'workRemove').map((c) => c.args.id);
  assert.ok(removed.every((id) => id === 'first-task'), `only the card's own task may go, removed: ${removed}`);
  assert.equal(removed.includes('second-task'), false, 'the second task stays');
  if (u.ok) assert.deepEqual(removed, ['first-task']);
  else assert.deepEqual(removed, [], 'refused: nothing removed');
});

test('a form card: the owner may change only its editable value, checked again as her input is', async () => {
  const { call, core, ops } = setup();
  const r = await call('change_setting', { key: 'upload_max_mb', value: 50 });
  const id = r.card.id;
  assert.equal((await core.confirm(id, { key: 'public_url' })).code, 'refused', 'a read-only field');
  assert.equal((await core.confirm(id, { command: 'rm -rf x' })).code, 'refused', 'a field the form does not have');
  assert.equal((await core.confirm(id, { value: 5000 })).code, 'refused', 'out of range for the setting');
  assert.equal(core.cards.get(id).status, 'pending', 'a refused value changes nothing');
  const done = await core.confirm(id, { value: '80' });
  assert.equal(done.ok, true);
  assert.deepEqual(ops.calls.find((c) => c.op === 'changeSettings').args.patch, { server: { uploadMaxMB: 80 } });
  assert.ok(core.cards.get(id).lines.some((l) => /Changed by the owner before his OK: value = "80"/.test(l)), 'the record says what he changed');
});

test('two confirms of one form card at once with different values: one runs, and the card says the value that ran', async () => {
  const { call, core, ops } = setup();
  const r = await call('change_setting', { key: 'upload_max_mb', value: 50 });
  const id = r.card.id;
  const [a, b] = await Promise.all([core.confirm(id, { value: 80 }), core.confirm(id, { value: 90 })]);
  assert.deepEqual([a.ok, b.ok, b.code], [true, false, 'used']);
  const applied = ops.calls.filter((c) => c.op === 'changeSettings').map((c) => c.args.patch);
  assert.deepEqual(applied, [{ server: { uploadMaxMB: 80 } }]);
  const c = core.cards.get(id);
  assert.equal(c.input.value, 80, 'the stored input is the one that ran');
  assert.equal(c.form.fields.find((f) => f.name === 'value').value, 80);
  const said = c.lines.filter((l) => /^Changed by the owner/.test(l));
  assert.deepEqual(said, ['Changed by the owner before his OK: value = 80'], 'no line for a value that never ran');
});

test('an Undo that failed for a passing reason stays offered, and the card says the real reason', async () => {
  const { call, core, ops } = setup();
  const a = await call('manage_work', { action: 'add', title: 'First task' });
  const orig = ops.assistantSettings.bind(ops);
  ops.assistantSettings = async () => ({ ...(await orig()), enabled: false });
  const off = await core.undoView(a.view.id);
  assert.equal(off.ok, false);
  assert.match(off.error, /turned off/);
  assert.equal(off.card.undo, true, 'the card still offers Undo');
  assert.doesNotMatch(JSON.stringify(off.card), /changed since/, 'it does not say the task changed');
  ops.assistantSettings = orig;
  const again = await core.undoView(a.view.id);
  assert.equal(again.ok, true, 'a second tap, once she is on again, takes it back');
  assert.deepEqual(ops.calls.filter((c) => c.op === 'workRemove').map((c) => c.args.id), ['first-task']);
  // A task that really changed: the Undo is spent, and the card says so in the tool's own words.
  const b = await call('manage_work', { action: 'add', title: 'Second task' });
  ops.s.work.items.find((x) => x.id === 'second-task').title = 'Renamed by him';
  const changed = await core.undoView(b.view.id);
  assert.deepEqual([changed.ok, changed.code], [false, 'stale']);
  assert.match(changed.card.changed[0], /changed since your add/);
  assert.equal((await core.undoView(b.view.id)).code, 'used');
});

test('an address in a choice card\'s answer is her words: a tap on it does not make it the owner\'s', async () => {
  const { call, core } = setup();
  const url = 'https://git.example.net/other/brain.git';
  const asked = await call('notify_owner', { message: 'Which brain?', options: [url, 'The one I set up'] });
  assert.equal(asked.view.kind, 'choice');
  const restore = () => call('manage_project', { action: 'workspace_restore', address: url });
  assert.match((await restore()).text, /was not shown to you/);
  // The page sends a tapped answer as his message.
  core.beginTurn('page-1', { origin: 'owner', text: url });
  const after = await restore();
  assert.equal(after.card, undefined, 'no card staged on her own address');
  assert.match(after.text, /was not shown to you/);
  // An address he writes himself still counts.
  const his = 'https://git.example.net/alex/brain.git';
  core.beginTurn('page-1', { origin: 'owner', text: `restore ${his} please` });
  assert.ok((await call('manage_project', { action: 'workspace_restore', address: his })).card, 'his own address stages the card');
});

test('an answer written in a choice card\'s own box keeps that card\'s id in his message, for a reload and another device', async () => {
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  // Tia is off: the route keeps his message and runs no turn (no engine, no model).
  const ctx = { HttpError, config: () => ({ server: { roots: [] }, assistant: { enabled: false } }), readJson: async (req) => req.body, dispatch: async () => ({ status: 200, json: {} }), poke() {} };
  const f = assistantFeature(ctx, { core: { cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }) } });
  const route = (method, p) => {
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(p);
      if (m === method && match) return (body) => fn({ headers: {}, body }, match, new URLSearchParams());
    }
    throw new Error(`no route ${method} ${p}`);
  };
  const { conversation } = await route('POST', '/api/assistant/chat')({ text: 'which branch should I use?' });
  const { conversation: other } = await route('POST', '/api/assistant/chat')({ text: 'another chat' });
  const ask = f.core.views.add(conversation, makeCard('choice', { question: 'Which branch?', options: ['main', 'dev'], free: true }));
  const elsewhere = f.core.views.add(other, makeCard('choice', { question: 'Which one?', options: ['a', 'b'], free: false }));
  const open = f.core.views.add(conversation, makeCard('open', { label: 'Open Work', href: '#/work' }));
  const send = (body) => route('POST', '/api/assistant/chat')({ conversation, ...body });
  await send({ text: 'release-2 please', choice: ask.id });
  await send({ text: 'from another chat', choice: elsewhere.id });
  await send({ text: 'not a question', choice: open.id });
  await send({ text: 'plain words' });
  await assert.rejects(send({ text: 'x', choice: '<b>' }), (e) => e.status === 400);
  const { events } = await route('GET', `/api/assistant/chat/${conversation}`)();
  const owner = events.filter((e) => e.kind === 'owner').map((e) => [e.text, e.choice ?? null]);
  assert.deepEqual(owner.slice(1), [['release-2 please', ask.id], ['from another chat', null], ['not a question', null], ['plain words', null]],
    'only a choice card of this conversation is kept with his message');
});

test('notify_owner with options outside the dashboard\'s conversation is refused, never "the owner sees it"', async () => {
  for (const conversation of ['direct', 'client-abc']) {
    const { call, ops } = setup();
    const r = await call('notify_owner', { message: 'Which branch?', options: ['main', 'dev'] }, conversation);
    assert.equal(r.isError, true, conversation);
    assert.match(r.text, /only in the dashboard's own conversation/);
    assert.match(r.text, /ask the owner in words/);
    assert.equal(ops.calls.filter((c) => c.op === 'notify').length, 0);
    // Without options it is the push, as before.
    assert.equal((await call('notify_owner', { message: 'The build is red.' }, conversation)).isError, false);
  }
  assert.equal((await setup().call('notify_owner', { message: 'Which branch?', options: ['main', 'dev'] })).view.kind, 'choice', 'the page\'s conversation');
});

test('a needs card of one kind is read again with that kind: its count and its items are of that kind', async () => {
  const repo = { ...item('repo-cccccccccccc', 'r00000000003', 'repo shop'), kind: 'repo' };
  const limits = Array.from({ length: 55 }, (_, i) => item(`limit-${String(i).padStart(12, '0')}`, 'r00000000001', `session s${i}`));
  const { call, core, ops } = setup((s) => {
    s.attention = { count: 56, items: [...limits.slice(0, 50)], more: 6, acts: { switch: { label: 'Continue on the next provider', risk: 'low' } }, hidden: 0, watched: [], timeline: [] };
    s.attentionAll = [...limits, repo];
    return s;
  });
  const r = await call('read_attention', { kind: 'repo' });
  assert.deepEqual(r.view.items.map((i) => i.subject), ['repo shop']);
  const now = (await core.refreshViews([r.view.id]))[r.view.id];
  assert.deepEqual(now.items.map((i) => [i.subject, !!i.gone]), [['repo shop', false]], 'still on the list');
  assert.equal(now.total, 1, 'the count of its kind');
  assert.ok(ops.reads.filter((x) => x.op === 'attention').some((x) => x.args.kind === 'repo'), 'read with its kind');
  // Read without a kind, an item the route did not send while it held more back is not called gone.
  const all = await call('read_attention', {});
  ops.s.attention.items = ops.s.attention.items.slice(1);
  const again = (await core.refreshViews([all.view.id]))[all.view.id];
  assert.equal(again.items.some((i) => i.gone), false);
});

test('a status card of a terminal carries when it was made, so a rename does not lose it', async () => {
  const { call } = setup();
  await call('list_sessions', {});
  const r = await call('read_session', { session: 'api-fix' });
  assert.deepEqual(r.view.subject, { type: 'session', computer: 'this', id: 'api-fix', created: 1_700_000_001_000 });
  assert.doesNotMatch(r.text, /1700000001000/, 'it is the card\'s, not hers');
});

test('a dynamic card whose subject cannot be read now comes marked unread, never as a fresh one', async () => {
  const { call, core, ops } = setup((s) => {
    s.attention = { count: 1, items: [item('limit-aaaaaaaaaaaa', 'r00000000001', 'session shop')], acts: {}, hidden: 0, watched: [], timeline: [] };
    return s;
  });
  const r = await call('read_attention', {});
  ops.attention = async () => {
    throw new Error('the list could not be read');
  };
  const now = (await core.refreshViews([r.view.id]))[r.view.id];
  assert.equal(now.unread, true);
  assert.equal(now.at, r.view.at, 'with the time it was last read');
  assert.equal(core.views.get(r.view.id).card.unread, undefined, 'the stored card is not changed');
});

test('after Undo, the conversation\'s history serves the card as it is now, not as it was pushed', async () => {
  const { call, core } = setup();
  const a = await call('manage_work', { action: 'add', title: 'First task' });
  // The event as feature.mjs pushes it: the card of that moment.
  const events = [{ i: 0, kind: 'tool_result', id: 't1', view: core.views.get(a.view.id).card }, { i: 1, kind: 'text', text: 'Added it.' }];
  assert.equal((await core.undoView(a.view.id)).ok, true);
  const served = currentViews(events, core.views);
  assert.match(served[0].view.title, /^Taken back/);
  assert.equal(served[0].view.undo, undefined, 'no Undo offered again');
  assert.equal(served[1], events[1], 'an event without a card is as it was');
  assert.match(events[0].view.title, /^Added/, 'the stored event itself is not changed');
});

test('a progress card of a Work run never asks for a review that may be over, and an unknown state is not "working"', async () => {
  const { runProgress } = await import('../../src/assistant/cardmake.mjs');
  const done = runProgress({ id: '20261117-101500-abcdef12', item: 'update-the-readme', state: 'done', startedAt: '2026-11-17T10:15:00.000Z', endedAt: '2026-11-17T10:21:00.000Z' });
  assert.equal(done.step.label, 'Open Work');
  assert.doesNotMatch(JSON.stringify(done), /Waits for your review|Review it/);
  assert.equal(runProgress({ id: 'r1', item: 'x', state: 'paused' }).state, 'unknown');
  assert.ok(makeCard('progress', runProgress({ id: 'r1', item: 'x', state: 'paused' })), 'an unknown state still makes a card');
});

test('her undo first, the card\'s Undo after: the card turns into "Taken back", with no Undo after a reload either', async () => {
  const { call, core, ops } = setup();
  const a = await call('manage_work', { action: 'add', title: 'First task' });
  const hers = await call('manage_work', { action: 'undo' });
  assert.match(hers.text, /^Took back your new task of first-task/);
  const tap = await core.undoView(a.view.id);
  assert.deepEqual([tap.ok, tap.code], [true, undefined], tap.error);
  assert.match(tap.card.title, /^Taken back/);
  assert.equal(core.views.get(a.view.id).card.undo, undefined, 'what a reload or another device draws: no Undo');
  assert.equal(ops.calls.filter((c) => c.op === 'workRemove').length, 1, 'taken back once');
  // A second tap: used, nothing done.
  assert.equal((await core.undoView(a.view.id)).code, 'used');
  assert.equal(ops.calls.filter((c) => c.op === 'workRemove').length, 1);
});

test('a choice card in a turn a job woke pushes through the owner\'s notification switches, never around them', async () => {
  const { byName } = await import('../../src/assistant/tools.mjs');
  const { createOps } = await import('../../src/assistant/ops.mjs');
  const { sendNotification } = await import('../../src/server/notify.mjs');
  const ops = new FakeOps(baseState());
  const tool = byName.get('notify_owner');
  await tool.run(ops, { message: 'Which branch?', options: ['main', 'dev'] }, { conversation: 'page-1', woken: true });
  const sent = ops.calls.filter((c) => c.op === 'notify');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].args.own, true, 'an event of the product\'s own kind');
  // A turn he started: no push at all.
  await tool.run(ops, { message: 'Which branch?', options: ['main', 'dev'] }, { conversation: 'page-1', woken: false });
  assert.equal(ops.calls.filter((c) => c.op === 'notify').length, 1);
  // The ops layer: such an event goes out without force, so his choice of events decides; her own note keeps force.
  const evs = [];
  const real = createOps({ ctx: { notify: async (ev) => (evs.push(ev), { sent: true }) }, runShell: async () => ({}), jobWaitMs: 0 });
  await real.notify({ title: 'Tia', message: 'Which branch?', own: true });
  await real.notify({ title: 'Tia', message: 'The build is red.' });
  assert.deepEqual(evs.map((e) => [e.status, e.force === true]), [['waiting', false], ['waiting', true]]);
  // With "waiting" switched off in his settings, the product's notifications send nothing for it.
  let posted = 0;
  const cfg = { url: 'https://push.example/topic', events: ['limit'] };
  const r = await sendNotification(cfg, evs[0], { fetchImpl: async () => (posted++, new Response('')), log: () => {} });
  assert.deepEqual([r.sent, posted], [false, 0]);
});

test('a Work run\'s progress card names its task by the title; a chat\'s line in a list is never its inside name', async () => {
  const { runProgress, cardOf } = await import('../../src/assistant/cardmake.mjs');
  assert.equal(runProgress({ id: 'r1', item: 'write-the-notes', title: 'Write the notes', state: 'running' }).title, 'Task: Write the notes');
  assert.equal(runProgress({ id: 'r1', item: 'write-the-notes', state: 'running' }).title, 'Task write-the-notes');
  const card = cardOf('list_sessions', {}, { data: { sessions: [{ session: 'chat:fb6c6ed8-ead0-4974-84c7-6f6985534730', computer: 'this', status: 'waiting', title: 'Write the notes', folder: '/w/shop' }] } }, { now: () => Date.now(), jobs: { get: () => null } });
  const it = card.fields.items[0];
  assert.equal(it.label, 'Write the notes');
  assert.doesNotMatch(it.sub, /chat:/);
  assert.equal(it.sub, 'shop');
});

test('the progress card of a Work run she started names the task by its title from the start', async () => {
  const { cardOf } = await import('../../src/assistant/cardmake.mjs');
  const r = cardOf('manage_work', { action: 'start', task: 'write-the-notes' }, { data: { run: '20261119-133400-dfe7bbf6', task: 'write-the-notes', state: 'running', started: '2026-11-19T13:34:00.000Z' }, cardData: { title: 'Write the notes' } }, { now: () => Date.now(), jobs: { get: () => null } });
  assert.equal(r.kind, 'progress');
  assert.equal(r.fields.title, 'Task: Write the notes');
  const src = (await import('node:fs')).readFileSync(new URL('../../src/assistant/worktool.mjs', import.meta.url), 'utf8');
  assert.match(src, /cardData: \{ title: b\.title \}/, 'the start result carries the title for the card only');
});

test('the progress card of a run she reads names the task by its title too', async () => {
  const { call } = setup();
  // Ids come only from tool results: the list shows the task, the task shows its run.
  await call('manage_work', { action: 'list', status: 'all' });
  assert.equal((await call('manage_work', { action: 'task', task: 'update-the-readme' })).isError, false);
  const r = await call('manage_work', { action: 'run', run: '20261117-101500-abcdef12' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.view.kind, 'progress');
  assert.equal(r.view.title, 'Task: Update the README');
});

test('read_session: the status card says what the session asks from its exact card', async () => {
  const { cardOf: askCardOf } = await import('../../src/askcard.mjs');
  const { call } = setup((s) => {
    Object.assign(s.sessions[0], { status: 'attention', note: 'Claude needs your attention', askCard: askCardOf({ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which branch do I push?', options: [{ label: 'main' }, { label: 'dev' }] }] } }) });
    return s;
  });
  await call('list_sessions', {});
  const r = await call('read_session', { session: 'api-fix' });
  assert.equal(r.view.kind, 'status');
  assert.equal(r.view.state, 'asks');
  assert.equal(r.view.note, 'Which branch do I push?');
});
