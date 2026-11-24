// Tia's workspace actions of manage_project (domains.mjs), on the fake dashboard: where, find and drop_check only
// read; drop and group_add are always a card, and confirming one only opens the owner's sheet on the Workspace page
// (nothing is dropped or written by her). Each result says what can be done next; each error the step that recovers.
// Her door never reaches the drop, a real group add, a group remove or the rules text. The tool list stays at 25.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { TOOLS, byName } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const ops = new FakeOps(baseState());
  const cards = new CardStore();
  const core = createAssistantCore({ ops, cards, audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }) });
  return { ops, cards, core, call: (tool, args) => core.call(tool, args, { conversation: 'c1' }) };
}
const cardId = (r) => (/card (c_[0-9a-f]{12})/.exec(r.text) || [])[1];

test('the tool list stays at 25; the new actions are in manage_project with closed parameters', () => {
  assert.ok(TOOLS.length <= 25, String(TOOLS.length));
  const t = byName.get('manage_project');
  for (const a of ['where', 'find', 'drop_check', 'drop', 'group_add']) assert.ok(t.input.json.properties.action.enum.includes(a), a);
  assert.equal(t.input.json.additionalProperties, false);
  assert.equal(t.levelOf({ action: 'where' }), 'L0');
  assert.equal(t.levelOf({ action: 'drop_check' }), 'L0');
  assert.equal(t.levelOf({ action: 'drop' }), 'L2');
  assert.equal(t.levelOf({ action: 'group_add' }), 'L2');
});

test('where: who has what, an old file and an unknown computer said, and what can be done next', async () => {
  const { call, ops } = setup();
  const r = await call('manage_project', { action: 'where' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /unknown \(no file\): lab/);
  assert.match(r.text, /"computer_label": ?"box2"[\s\S]*"old": ?true/);
  assert.match(r.text, /drop_check says/);
  assert.deepEqual(ops.calls, [], 'read only');
  const one = await call('manage_project', { action: 'where', entry: 'nope' });
  assert.equal(one.isError, true);
  assert.match(one.text, /call where without entry/);
});

test('drop_check reads; drop is a card whose confirmation only opens the sheet, and nothing is dropped', async () => {
  const { call, core, ops, cards } = setup();
  await call('list_projects', {});
  const chk = await call('manage_project', { action: 'drop_check', project: 'shop' });
  assert.equal(chk.isError, false, chk.text);
  assert.match(chk.text, /Type the project's name \(shop\)/);
  const r = await call('manage_project', { action: 'drop', project: 'shop' });
  const id = cardId(r);
  assert.ok(id, r.text);
  assert.match(cards.get(id).lines.join('\n'), /you answer its questions and press Drop there yourself/);
  const done = await core.confirm(id);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.summary, /nothing was dropped/);
  assert.equal(done.open, '#/workspace?drop=shop', 'the page opens his sheet, filled in');
  assert.deepEqual(ops.calls, [], 'her drop wrote nothing: the owner presses Drop on his sheet');
  for (const [m, p] of [['POST', '/api/workspace/drop'], ['POST', '/m/box2/api/workspace/drop'], ['POST', '/api/workspace/group/remove'], ['POST', '/api/workspace/rules']]) assert.throws(() => checkRoute(m, p, {}), /owner's own step/, p);
  assert.throws(() => checkRoute('POST', '/api/workspace/group', { dir: 'kits' }), /owner's own press/);
  assert.doesNotThrow(() => checkRoute('POST', '/api/workspace/group', { dir: 'kits', dryRun: true }));
  assert.throws(() => checkRoute('POST', '/api/workspace/drop/check', { name: 'shop', typed: 'shop' }), /typed/);
});

test('a project not here: the card is refused with the step that recovers', async () => {
  const { call } = setup();
  await call('list_projects', {});
  const r = await call('manage_project', { action: 'drop', project: 'api' });
  assert.equal(r.isError, true);
  assert.match(r.text, /where says which computer has it/);
});

test('group_add: a card naming what goes into the map; confirming opens the sheet, nothing written', async () => {
  const { call, core, ops, cards } = setup();
  const bad = await call('manage_project', { action: 'group_add', group: 'kits', holds: 'packs:group' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /give group_repo too/);
  const r = await call('manage_project', { action: 'group_add', group: 'kits' });
  const id = cardId(r);
  assert.ok(id, r.text);
  assert.match(cards.get(id).lines.join('\n'), /Written to the map: \{"dir":"kits"\}/);
  const done = await core.confirm(id);
  assert.equal(done.ok, true);
  assert.match(done.summary, /nothing was written/);
  assert.equal(done.open, '#/workspace?group=kits');
  assert.deepEqual(ops.calls, []);
});

test('group_add: the card names what the scan adds in the group\'s folder apart from what it finds elsewhere', async () => {
  const { call, ops, cards } = setup();
  ops.groupDryRun = async (x) => ({ group: { dir: x.dir }, added: true, ignore: null, notes: [], mapAdded: ['kits/tool', 'notes-app'], mapAddedHere: ['kits/tool'], mapAddedElsewhere: ['notes-app'], dryRun: true });
  const lines = cards.get(cardId(await call('manage_project', { action: 'group_add', group: 'kits' }))).lines;
  assert.ok(lines.includes('And what is in its folder now, into the map: kits/tool'), lines.join('\n'));
  assert.ok(lines.includes('And what the scan finds elsewhere in the workspace, into the map too: notes-app'), lines.join('\n'));
  ops.groupDryRun = async (x) => ({ group: { dir: x.dir }, added: true, ignore: null, notes: [], mapAdded: ['notes-app'], dryRun: true }); // an older computer
  const old = cards.get(cardId(await call('manage_project', { action: 'group_add', group: 'kits' }))).lines.join('\n');
  assert.doesNotMatch(old, /in its folder/);
  assert.match(old, /the scan of the workspace finds now, into the map: notes-app/);
});

test('find reads the naming rule\'s look-up and adds nothing', async () => {
  const { call, ops } = setup();
  const r = await call('manage_project', { action: 'find', place: 'kits/builds' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Nothing was added/);
  assert.deepEqual(ops.calls, []);
});

test('the page follows a confirmed card\'s link only to a sheet of the Workspace page', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  const re = new RegExp(/const SHEET_LINK = \/(.+)\/;\n/.exec(src)[1]);
  for (const ok of ['#/workspace?drop=shop', '#/m/box2/workspace?drop=kits%2Fbuilds%2Fgizmo', '#/workspace?group=kits&repo=x']) assert.ok(re.test(ok), ok);
  for (const no of ['#/settings/security', 'https://evil.example/#/workspace?drop=shop', '#/workspace', '#/workspace?typed=shop', 'javascript:alert(1)//#/workspace?drop=x']) assert.ok(!re.test(no), no);
});

test('her drop result never invites a promise to report it; her words say "this computer", never "this"', async () => {
  const { call, core } = setup();
  await call('list_projects', {});
  const chk = await call('manage_project', { action: 'drop_check', project: 'shop' });
  assert.match(chk.text, /exists only on this computer/);
  assert.doesNotMatch(chk.text, /only on this \(/);
  const r = await call('manage_project', { action: 'drop', project: 'shop' });
  const done = await core.confirm(cardId(r));
  assert.match(done.summary, /You are not told whether he drops it: do not promise to report it/);
});

test('a drop on another computer: list_projects there shows blog, then the card is for box2 and opens its sheet', async () => {
  const { call, core } = setup();
  await call('get_computer_status', {});
  const list = await call('list_projects', { computer: 'box2' });
  assert.match(list.text, /blog/, list.text);
  const r = await call('manage_project', { action: 'drop', project: 'blog', computer: 'box2' });
  const id = cardId(r);
  assert.ok(id, r.text);
  const done = await core.confirm(id);
  assert.equal(done.open, '#/m/box2/workspace?drop=blog');
  assert.match(done.summary, /on box2/);
});
