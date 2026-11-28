// A plan step refuses what her own tool refuses (design 2.3: each step is checked as if done alone). The four the check found:
// a chat start on a provider she may not use, a message without her mark, a group added for real, a setup fix off its card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRoute } from '../../src/assistant/door.mjs';
import { runConfirmed } from '../../src/assistant/confirmed.mjs';
import { dashboardActs } from '../../src/assistant/actsrun.mjs';
import { herArgs } from '../../src/assistant/herbody.mjs';
import { rowById } from '../../src/assistant/catalog.mjs';
import { plan_acts } from '../../src/assistant/plantool.mjs';

const stub = { config: () => ({}), settingsOf: () => null };
const card = (steps) => ({ id: 'c_b', tool: 'plan_acts', input: { title: 't', steps } });
const SEND = { act: 'chats.send', args: { target: 'chat-11111111-1111-4111-8111-111111111111'.replace('chat-', ''), text: 'go' } };
const OTHER = { act: 'updates.run', args: {} };
const through = (steps, method, url, body) => runConfirmed(card(steps), () => checkRoute(method, url, body, stub));

test('her mark and Settings defaults are added to what the step sends, and the card binds exactly that', () => {
  assert.deepEqual(herArgs(rowById('chats.send'), { text: 'go' }), { byTia: true, text: 'go' });
  assert.deepEqual(herArgs(rowById('chat.chats'), { dir: '/p' }), { defaults: true, byTia: true, dir: '/p' });
  assert.deepEqual(herArgs(rowById('chat.chats'), { dir: '/p', sessionId: 's' }), { defaults: true, dir: '/p', sessionId: 's' });
  const id = SEND.args.target;
  const ok = through([SEND, OTHER], 'POST', `/api/chats/${id}/send`, { byTia: true, text: 'go' });
  assert.equal(ok.owner, true);
  // The same message without her mark is refused: it would be typed as the owner's.
  assert.throws(() => through([SEND, OTHER], 'POST', `/api/chats/${id}/send`, { text: 'go' }), /owner's own|not a route|hers|bound/);
  assert.throws(() => through([{ ...SEND, args: { ...SEND.args, byTia: false } }, OTHER], 'POST', `/api/chats/${id}/send`, { text: 'go', byTia: false }), /hers/);
});

test('a chat start in a plan takes Settings defaults and her own door body check', () => {
  const start = { act: 'chat.chats', args: { dir: '/home/owner/projects/api', profile: 'sub' } };
  const ok = through([start, OTHER], 'POST', '/api/chats', { defaults: true, byTia: true, dir: '/home/owner/projects/api', profile: 'sub' });
  assert.equal(ok.owner, true);
  const loose = { act: 'chat.chats', args: { dir: '/home/owner/projects/api', profile: 'sub', defaults: false } };
  assert.throws(() => through([loose, OTHER], 'POST', '/api/chats', { defaults: false, byTia: true, dir: '/home/owner/projects/api', profile: 'sub' }), /Settings' defaults/);
});

test('a group is added in a plan only as the dry run her own tool makes; the real one is his press on the page', () => {
  const dry = { act: 'workspace.group', args: { dir: '/p', repo: 'r', holds: 'h', dryRun: true } };
  assert.equal(through([dry, OTHER], 'POST', '/api/workspace/group', { dir: '/p', repo: 'r', holds: 'h', dryRun: true }).owner, true);
  const real = { act: 'workspace.group', args: { dir: '/p', repo: 'r', holds: 'h', dryRun: false } };
  assert.throws(() => through([real, OTHER], 'POST', '/api/workspace/group', { dir: '/p', repo: 'r', holds: 'h', dryRun: false }), /owner's own press/);
});

test('a setup fix in a plan is the one check its card shows, with only the fields her own tool sends', () => {
  const fix = { act: 'pcsetup.fix', args: { id: 'extras.tmux' } };
  assert.equal(through([fix, OTHER], 'POST', '/api/pcsetup/fix', { id: 'extras.tmux' }).owner, true);
  assert.throws(() => through([fix, OTHER], 'POST', '/api/pcsetup/fix', { id: 'git.git' }), /owner's own|not a route/);
  assert.throws(() => through([fix, OTHER], 'POST', '/api/pcsetup/fix', { id: 'extras.tmux', password: 'x' }), /owner's own|to send/);
});

test('a plan that starts a chat on a provider she may not use is refused before the card, and again at the tap', async () => {
  const steps = [{ act: 'chat.chats', args: { dir: '/home/owner/projects/api', profile: 'paid-key' } }, OTHER];
  const ctx = { tia: async () => ({ allowed: ['sub'] }), acts: dashboardActs({ routeCall: async () => ({}) }) };
  await assert.rejects(plan_acts.before({}, { title: 't', steps }, ctx), /paid-key/);
  const okSteps = [{ act: 'chat.chats', args: { dir: '/home/owner/projects/api', profile: 'sub' } }, OTHER];
  await assert.doesNotReject(plan_acts.before({}, { title: 't', steps: okSteps }, ctx));
});

test('every field of a step that names a provider is held to her allowed list, and her mark is not taken off', async () => {
  const ctx = { tia: async () => ({ allowed: ['okprov'] }), acts: dashboardActs({ routeCall: async () => ({}) }) };
  const bad = (act, args) => assert.rejects(plan_acts.before({}, { title: 't', steps: [{ act, args }, OTHER] }, ctx), /badprov/);
  await bad('chats.provider', { target: 'c1', profile: 'badprov' });
  await bad('work.items.do', { target: 'w1', provider: 'badprov' });
  await bad('chat.chats', { dir: '/p', profile: 'okprov', lead: true, others: ['badprov'], byTia: false });
  await bad('chat.chats', { dir: '/p', sessionId: 's', profile: 'okprov', lead: true, others: ['badprov'] });
  await assert.doesNotReject(plan_acts.before({}, { title: 't', steps: [{ act: 'chat.chats', args: { dir: '/p', profile: 'okprov', lead: true, others: ['okprov'] } }, OTHER] }, ctx));
  assert.equal(herArgs(rowById('chat.chats'), { dir: '/p', byTia: false }).byTia, true);
});
