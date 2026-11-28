// A read must be found as a read. A real model asked "show me what changed in a project" made a command card: her look did
// not name the facts of a folder's git state, and find_acts answered with five sign-in acts first. Here: the facts are named
// where she looks for reads, find_acts ranks by what was asked, and the acts that are only his own press come last.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { MCP_TOOLS } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const state = baseState();
  const ops = new FakeOps(state);
  const routed = [];
  ops.routeCall = async (computer, method, p, body) => {
    checkRoute(method, p.split('?')[0], body, { config: () => state.assistant, poke() {} });
    routed.push({ method, p, body });
    return { repo: '/home/owner/projects/shop', branch: 'main', ahead: 0, behind: 0, staged: [], changes: [{ path: 'footer.txt', status: 'M' }], untracked: ['notes.md'], conflicts: [] };
  };
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }) });
  return { routed, call: (name, args) => core.call(name, args, { conversation: 'fr' }) };
}
const acts = (r) => JSON.parse(/<untrusted_data[^>]*>(.*)<\/untrusted_data>/s.exec(r.text)[1]).acts;

test('look names the facts of a folder git state, within its size', () => {
  const look = MCP_TOOLS.find((t) => t.name === 'look');
  assert.match(look.description, /git\.status/);
  assert.match(look.description, /git\.log/);
  assert.ok(look.description.length < 900, `look description is ${look.description.length} characters`);
});

test('look git.status reads the folder git state through the read route, no card, no command', async () => {
  const { call, routed } = setup();
  const r = await call('look', { facts: [{ id: 'git.status', args: { folder: '/home/owner/projects/shop' } }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.card, undefined);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].method, 'GET');
  assert.match(routed[0].p, /^\/api\/code\/git\/status\?root=/);
  assert.match(r.text, /footer\.txt/);
  const l = await call('look', { facts: [{ id: 'git.log', args: { folder: '/home/owner/projects/shop', n: 5 } }] });
  assert.equal(l.isError, false, l.text);
  assert.match(routed[1].p, /^\/api\/code\/git\/log\?root=.*&n=5/);
});

test('find_acts: a question about changes answers with the git facts first, never with sign-in acts', async () => {
  const { call } = setup();
  for (const q of ['Show me what changed in shop', 'show uncommitted changes diff in shop repo', 'what is changed in the project, git status', 'last commits of shop']) {
    const list = acts(await call('find_acts', { query: q }));
    assert.match(list[0].id, /^git\.(status|log)$/, `${q}: first is ${list[0].id}`);
    assert.equal(list[0].answer, 'read');
    assert.match(list[0].use, /look/);
    assert.ok(!list.slice(0, 3).some((x) => /^accounts\./.test(x.id)), `${q}: no sign-in act among the first three`);
  }
});

test('find_acts: an act that is only his own press says so and comes after the reads that fit', async () => {
  const { call } = setup();
  const list = acts(await call('find_acts', { query: 'git sign in changes', limit: 8 }));
  const firstOwn = list.findIndex((x) => x.yours);
  assert.ok(firstOwn > 0, `a sign-in act is among them, not first (${list.map((x) => x.id).join(', ')})`);
  assert.match(list[0].id, /^git\./);
  const out = acts(await call('find_acts', { query: 'sign out of my Claude account' }));
  const logout = out.find((x) => x.id === 'accounts.claude-login.logout');
  assert.ok(logout && logout.yours, `what is asked for is his own press: it is found, and says so (${out.map((x) => x.id).join(', ')})`);
});
