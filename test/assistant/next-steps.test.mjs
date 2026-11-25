// Every result of every tool and action of Tia's names its next step ("Next: …"), held by one test over the whole
// catalog: each act is called once on the stand-in dashboard with an input that works (after the reads that show its
// ids), and its text must say what to do next. An act that has no next step is listed in NONE with its reason.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { loadInventory } from '../../src/assistant/acts.mjs';
import { NEXT } from '../../src/assistant/next.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { TOOLS } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';
import { withPlan } from './fake-work.mjs';

const BUILTIN = new URL('../../skills', import.meta.url).pathname;
const CID = '55555555-5555-4555-8555-555555555501';
const CHAT = `chat:${CID}`;

// Acts whose result has no next step, each with why. None today: every act names one.
const NONE = {};

// An input that works for each act; `before`: the calls that show its ids first (ids come only from tool results);
// `world`: a change to the stand-in's state for that act alone (not `state`: finish_job has a field of that name).
// A mission of the shop with one task that waits in his review.
const withMission = (s) => {
  s.work.missions = [{ id: 'm-20261117-abc123', goal: 'Make the shop faster', project: 'shop', state: 'waits', why: null, total: { cost: 0.12, tokens: 9000, minutes: 7 },
    tasks: [{ id: 'fix-the-cart-total', title: 'Fix the cart total', role: 'developer', state: 'review', why: null, tokens: 9000, minutes: 7, firstPass: true }], line: [] }];
};
// One "went wrong twice" line of Home that can make a draft (src/field/learn.mjs twiceLines).
const withTwice = (s) => {
  s.twice = [{ key: 'get:git-auth', kind: 'get', class: 'git-auth', count: 2, last: '2026-11-20T10:00:00.000Z', kindWords: 'hoprig get', words: 'git was not let into a repository', help: 'Sign in to the git server, then run it again.', command: 'hoprig pc setup', doc: null, draft: true }];
};
const SAMPLES = {
  list_sessions: {}, read_session: { session: 'api-fix' }, list_projects: {}, get_computer_status: { computer: 'this' },
  read_attention: {}, read_brain: {},
  'manage_procedures find': { query: 'nightly build' },
  'manage_procedures draft': { name: 'nightly-check', description: 'Check the nightly build and report it.', procedure: '## Procedure\n1. list_sessions', allowed_tools: ['list_sessions'] },
  start_session: { folder: '/home/owner/projects/api', account: 'sub', message: 'fix the failing test' },
  send_to_session: { session: 'web-ui', text: 'yes, update them' },
  start_chat: { folder: '/home/owner/projects/api', account: 'sub', message: 'fix the failing test' },
  send_to_chat: { session: CHAT, text: 'and the docs' },
  watch_session: { session: 'api-fix', goal: 'the tests pass' },
  finish_job: { state: 'done', report: 'The tests pass.', job: (t) => /Job (j_[0-9a-f]{10})/.exec(t)[1], before: [['watch_session', { session: 'web-ui', goal: 'the screenshots are updated' }]] },
  notify_owner: { message: 'The tests pass.' }, open_screen: { screen: 'providers' },
  stop_session: { session: 'api-fix' }, switch_account: { session: 'api-fix', account: 'sub2' }, set_auto_mode: { enabled: true },
  change_setting: { key: 'upload_max_mb', value: 50 }, run_command: { command: 'df -h' },
  'manage_computer add': { ssh_target: 'alex@box3' }, 'manage_computer rename': { label: 'desk two' },
  'manage_computer check_updates': {}, 'manage_computer update': { item: 'claude' },
  // OpenCode installed and off, so turning it on is a real act (the stand-in has it not installed).
  'manage_computer coding_tool': { coding_tool: 'opencode', turn: 'on', world: (s) => { s.codingTools.find((x) => x.id === 'opencode').installed = '2.3.0'; }, before: [['get_computer_status', { computer: 'this', coding_tools: true }]] },
  'manage_computer setup_fix': { check: 'kit:tools.gh', before: [['get_computer_status', { computer: 'this', setup: true }]] },
  'manage_computer set_up': { kits: ['tools'] }, 'manage_computer end_process': { pid: 4242 },
  // The add-on's id is the stand-in dashboard's own (no product's name in this test).
  'manage_computer addon': { addon: baseState().addons[0].id, addon_action: 'start' }, 'manage_computer public_link': { turn: 'off' },
  'manage_computer reboot': {}, 'manage_computer power_off': {},
  'manage_computer restart_dashboard': { world: (s) => { s.updates.items.find((x) => x.id === 'hoprig').last = { ok: true, version: '0.9.1', restart: true }; } },
  'manage_project new': { name: 'blog' }, 'manage_project get': { spec: 'blog' }, 'manage_project sync': { project: 'shop' },
  'manage_project add_repository': { project: 'shop', repo: 'docs' },
  'manage_project install': { project: 'shop' }, 'manage_project create_folders': {},
  'manage_project workspace_map': { dry_run: true }, 'manage_project workspace_sync': { dry_run: true },
  'manage_project workspace_sync_from': { from_computer: 'box2', dry_run: true },
  'manage_project workspace_restore': { address: 'https://git.example.com/owner/brain.git', dry_run: true, before: [['list_projects', { view: 'git' }]] },
  'manage_project workspace_places': { projects_folder: '~/projects' }, 'manage_project where': {},
  'manage_project find': { place: 'kits/builds' }, 'manage_project drop_check': { project: 'shop' },
  'manage_project drop': { project: 'shop' }, 'manage_project group_add': { group: 'kits/builds' },
  'manage_project workspace_forget': { mapped: 'blog', before: [['list_projects', { view: 'map' }]] },
  'manage_automation list': {}, 'manage_automation add_schedule': { time: '07:00', text: 'continue', send_to: 'api-fix' },
  'manage_automation change_schedule': { schedule: 'abcd1234', time: '09:00', folder: '/home/owner/projects/shop', account: 'sub' }, 'manage_automation delete_schedule': { schedule: 'abcd1234' },
  'manage_automation set_rule': { rule: 'retry', on: true }, 'manage_automation set_upkeep_hours': { hours: 6 },
  'manage_automation pause': {}, 'manage_automation resume': {},
  'manage_automation queue_message': { session: 'api-fix', text: 'continue' }, 'manage_automation queue_clear': { session: 'api-fix' },
  'manage_skills installed': {}, 'manage_skills suggested': {}, 'manage_skills find': { query: 'pdf' },
  'manage_skills check_updates': {}, 'manage_skills review': { spec: 'pdf-tools' }, 'manage_skills update_review': { skill: 'tdd' },
  'manage_skills install': { review: 'r1', before: [['manage_skills', { action: 'review', spec: 'pdf-tools' }]] },
  'manage_skills remove': { skill: 'tdd' },
  'manage_skills cancel_review': { review: 'r1', before: [['manage_skills', { action: 'review', spec: 'pdf-tools' }]] },
  'manage_skills undo_update': { skill: 'tdd', world: (s) => { s.skills.user.skills[0].canUndo = true; } },
  'manage_skills twice': { world: withTwice },
  'manage_skills twice_dismiss': { line: 'get:git-auth', world: withTwice, before: [['manage_skills', { action: 'twice' }]] },
  'manage_skills twice_draft': { line: 'get:git-auth', world: withTwice, before: [['manage_skills', { action: 'twice' }]] },
  'manage_work today': {}, 'manage_work list': {}, 'manage_work task': { task: 'renew-the-domain' }, 'manage_work mission': {},
  'manage_work goal': { goal: 'Make the shop site load faster.', project: 'shop' },
  'manage_work fix_ids': { world: (s) => { s.work.items.push({ ...s.work.items[0] }); } },
  'manage_work tidy': { world: (s) => { s.work.tidy = { alters: [{ kind: 'order', text: 'The keys of 2 tasks are put in their usual order.' }], diff: '-  "b": 1,\n+  "a": 1,', hash: 'c'.repeat(32) }; } },
  'manage_work mission_stop': { mission: 'm-20261117-abc123', world: withMission },
  'manage_work mission_add': { mission: 'm-20261117-abc123', task: 'call-the-bank', world: withMission },
  'manage_work mission_tests': { mission: 'm-20261117-abc123', task: 'fix-the-cart-total', world: withMission, before: [['manage_work', { action: 'mission', mission: 'm-20261117-abc123' }]] },
  'manage_work run': { run: '20261117-101500-abcdef12', before: [['manage_work', { action: 'task', task: 'update-the-readme' }]] },
  'manage_work progress': {},
  'manage_work plans': { world: withPlan }, 'manage_work plan': { plan: 'launch-the-shop', world: withPlan, before: [['manage_work', { action: 'plans' }]] },
  'manage_work add': { title: 'Write the release notes' }, 'manage_work edit': { task: 'renew-the-domain', title: 'Renew the domain today' },
  'manage_work done': { task: 'renew-the-domain' },
  'manage_work reopen': { task: 'renew-the-domain', before: [['manage_work', { action: 'done', task: 'renew-the-domain' }]] },
  'manage_work undo': { before: [['manage_work', { action: 'add', title: 'Write the release notes' }]] },
  'manage_work start': { task: 'fix-the-cart-total', brief: 'Fix the cart total so the discount code is applied.', kind: 'code' },
  'manage_work accept': { task: 'update-the-readme' }, 'manage_work send_back': { task: 'update-the-readme', text: 'Add the install line.' },
  'manage_work drop': { task: 'renew-the-domain' }, 'manage_work remove': { task: 'renew-the-domain' },
};

const acts = () => TOOLS.flatMap((t) => (t.actions ? Object.keys(t.actions).map((a) => ({ t, act: a, key: `${t.name} ${a}` })) : [{ t, act: null, key: t.name }]));

function setup(change) {
  const s = baseState();
  change?.(s);
  s.assistant.level = 'handsoff';
  s.sessions.push({ computer: 'this', name: CHAT, kind: 'chat', chatId: CID, byTia: true, status: 'waiting', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/api', title: 'Login fix', lastMessage: '', note: '', limit: null, sessionId: CID, statusAt: Date.now(), created: 1 });
  const ops = new FakeOps(s);
  const core = createAssistantCore({ ops, cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }) });
  return { core, call: (name, args) => core.call(name, args, { conversation: 'n' }) };
}
const READS = [['list_sessions', {}], ['get_computer_status', {}], ['get_computer_status', { computer: 'this' }], ['list_projects', {}], ['manage_skills', { action: 'installed' }], ['manage_work', { action: 'list' }], ['manage_automation', { action: 'list' }], ['read_brain', {}]];

test('every act of hers has a next step in the table, or a reason in NONE; the table names no act that is gone', () => {
  const keys = acts().map((x) => x.key);
  for (const k of keys) assert.ok(NEXT[k] || NONE[k], `${k}: no next step and no reason why not`);
  for (const k of [...Object.keys(NEXT), ...Object.keys(NONE)]) assert.ok(keys.includes(k), `${k} is no act of hers any more`);
  for (const [k, why] of Object.entries(NONE)) assert.ok(typeof why === 'string' && why.length >= 20, `${k}: one sentence of why`);
});

test('every result of every tool and action names its next step, also a card and what his tap on it did', async () => {
  const seen = { ran: 0, card: 0, tapped: 0 };
  for (const { t, act, key } of acts()) {
    const sample = SAMPLES[key];
    assert.ok(sample, `${key}: no sample input`);
    const { core, call } = setup(sample.world);
    let last = '';
    for (const [n, a] of [...READS, ...(sample.before || [])]) last = (await call(n, a)).text;
    const input = Object.fromEntries(Object.entries(sample).filter(([k]) => k !== 'before' && k !== 'world').map(([k, v]) => [k, typeof v === 'function' ? v(last) : v]));
    const r = await call(t.name, act ? { action: act, ...input } : input);
    assert.equal(r.isError, false, `${key}: ${r.text.slice(0, 300)}`);
    if (NONE[key]) continue;
    assert.match(r.text.split('<untrusted')[0], /\bNext: \S/, `${key}: no next step in ${JSON.stringify(r.text.slice(0, 300))}`);
    if (!r.card) {
      seen.ran++;
      continue;
    }
    seen.card++;
    // What his tap did is told to her in her next turn: it names the next step too, when the act ran.
    const tap = await core.confirm(r.card.id);
    if (!tap.ok) continue;
    const told = core.takeOutcomes('n').map((o) => o.text).join('\n');
    assert.match(told.split('<untrusted')[0], /\bNext: \S/, `${key}, after his tap: ${JSON.stringify(told.slice(0, 300))}`);
    seen.tapped++;
  }
  assert.ok(seen.ran >= 40 && seen.card >= 25 && seen.tapped >= 15, JSON.stringify(seen));
});

// The acts that may start, spend or send by themselves at some level, from the inventory's own facts: an act of hers
// with a risk of R2 or R3 that is not always a card. A next step never names one of them, so a small model is never
// sent from a read to a start, a move or a message the owner did not ask for.
const UNASKED = (() => {
  const out = new Set();
  for (const r of loadInventory().rows) for (const h of r.hers || []) if ((h.risk === 'R2' || h.risk === 'R3') && h.card !== 'yes') out.add(h.action ? `${h.tool} ${h.action}` : h.tool);
  return [...out];
})();
// "start_chat" names the tool; "manage_project sync" names that action (not "workspace_sync"), also as action "sync".
const names = (line, act) => {
  const [tool, action] = act.split(' ');
  return action ? new RegExp(`\\b${tool}\\s+(?:action\\s+"?)?${action}\\b`).test(line) : new RegExp(`\\b${tool}\\b`).test(line);
};
// The tools that find a project or a folder: his words may name a task of his Work list there.
// (manage_project find finds the repositories of a group place, not a project he named.)
const FINDS = ['list_projects', 'manage_project where'];

test('no next step names an act that may start, spend or send by itself; after finding a project the Work list comes first', () => {
  assert.ok(UNASKED.length >= 8 && UNASKED.includes('start_chat') && UNASKED.includes('send_to_session'), UNASKED.join(', '));
  for (const [k, line] of Object.entries(NEXT)) {
    const hit = UNASKED.filter((a) => names(line, a));
    assert.deepEqual(hit, [], `${k}: its next step names ${hit.join(', ')}: "${line}"`);
  }
  for (const k of FINDS) assert.match(NEXT[k], /^manage_work list first/, `${k}: the Work list first`);
  // The matcher itself: it sees a start, an action by its form, and leaves another action of the same name alone.
  assert.ok(names('start_chat in its folder', 'start_chat') && names('manage_project sync it', 'manage_project sync'));
  assert.ok(!names('manage_project workspace_sync with dry_run', 'manage_project sync'));
});
