// The run door (src/work/alone.mjs) as a mission uses it: the cost and tokens the coding tool reports are read from its
// own result line, a mission's run is "by: mission", a review run changes no task status, a mission's run that has to
// wait is not queued in the dashboard's list, a role's tools reach the coding tool, and one run can be stopped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome } from './helpers.mjs';

const t = missionHome('mission-door');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore, readDoc } = await import('../../src/work/store.mjs');
const { aloneRunner, aloneArgs, readStream, hers } = await import('../../src/work/alone.mjs');
const { readRun, tokensOf } = await import('../../src/work/runs.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const log = path.join(t.root, 'tool.log');
process.env.FAKE_TOOL_LOG = log;
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 1 }), minuteMs: 400, killGraceMs: 200 });
test.after(() => runner.close());
const statusOf = (id) => readDoc(place().file).doc.items.find((x) => x.id === id).status;
let n = 0;
const task = async (note) => (await store().add({ title: `Door ${++n}`, project: 'shop', note })).item.id;

test('the cost and the tokens come from the tool\'s own result line, never from its words', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"type":"result","total_cost_usd":0}' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } }),
  ];
  // One record of what the tool reported: the run's `used` (runs.mjs usedOf); a mission reads its cost and tokens from it.
  const r = readStream(lines).result;
  assert.equal(r.used.costUsd, 0.25);
  assert.equal(tokensOf(r.used), 115);
  const none = readStream([JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })]).result;
  assert.equal(none.used, null);
  assert.equal(tokensOf(none.used), null);
});

test('a mission\'s run is "by: mission", reports its usage, and its review run leaves the task\'s status alone', async () => {
  const id = await task('Files: a.txt');
  const fin = await (await runner.startAlone({ item: id, provider: 'key', by: 'mission', restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], commit: true })).done;
  assert.equal(fin.state, 'done', fin.reason);
  assert.equal(fin.by, 'mission');
  assert.deepEqual(fin.usage, { cost: 0.01, tokens: 1000 });
  assert.equal(readRun(place(), fin.id).by, 'mission');
  assert.equal(statusOf(id), 'review');
  const rev = await (await runner.startAlone({ item: id, provider: 'key', by: 'mission', review: true, restricted: ['Read', 'Glob', 'Grep'], prompt: 'You review work another session did.' })).done;
  assert.equal(rev.state, 'done');
  assert.equal(statusOf(id), 'review', 'a review changes no status');
  // review: true is a mission's only: a schedule's job with it is refused as before
  await assert.rejects(runner.startAlone({ item: id, provider: 'key', review: true }), /waits for your review/);
});

test('a mission\'s run is always restricted: a closed list of tools, no tool server, never bypass; only a mission\'s job may name tools', async () => {
  const a = aloneArgs({ restricted: ['Read', 'Edit'], allowed: ['Bash(rm:*)'], denied: ['Bash'], mode: 'bypassPermissions', dirs: ['/state/review'] });
  assert.ok(a.includes('--restricted') && a.includes('--strict-mcp-config'), a.join(' '));
  assert.equal(a[a.indexOf('--mcp-config') + 1], '{"mcpServers":{}}', 'no tool server of anyone\'s');
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Edit', 'the tools that exist for the session at all');
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read,Edit', 'and no other is allowed by a word');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!a.includes('--allow-dangerously-skip-permissions'), 'a restricted run never runs in bypass');
  assert.equal(a[a.indexOf('--add-dir') + 1], '/state/review');
  const plain = aloneArgs({ allowed: ['Read'], dirs: ['/x'] });
  assert.ok(!plain.includes('--restricted') && !plain.includes('--tools') && !plain.includes('--add-dir'), 'a run that is not a mission\'s is as it was');
  fs.writeFileSync(log, '');
  const id = await task('Files: b.txt');
  await (await runner.startAlone({ item: id, provider: 'key', by: 'schedule', allowed: ['Bash(rm:*)'], restricted: ['Bash'], dirs: ['/'] })).done;
  const id2 = await task('Files: c.txt');
  await (await runner.startAlone({ item: id2, provider: 'key', by: 'mission', restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], denied: ['Bash'], dirs: ['/', '/etc'] })).done;
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
  assert.ok(!calls[0].includes('--allowedTools') && !calls[0].includes('--restricted') && !calls[0].includes('--add-dir'), 'a schedule cannot name tools, the mode or a folder');
  assert.equal(calls[1][calls[1].indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert.equal(calls[1][calls[1].indexOf('--disallowedTools') + 1], 'Bash');
  assert.ok(!calls[1].includes('--add-dir'), 'a folder outside the dashboard\'s own state is never added');
  // A mission's job without its role's tools, or with a shell line among them, is not started at all.
  const id3 = await task('Files: d.txt');
  await assert.rejects(runner.startAlone({ item: id3, provider: 'key', by: 'mission' }), /always restricted/);
  await assert.rejects(runner.startAlone({ item: id3, provider: 'key', by: 'mission', restricted: ['Read', 'Bash(git status:*)'] }), /always restricted/);
  await assert.rejects(runner.startAlone({ item: id3, provider: 'key', by: 'mission', restricted: [] }), /always restricted/);
});

test('a session whose own first line names another tool, a tool server or bypass is ended at once, and nothing it did is committed', async () => {
  const head = () => t.git(shop, 'rev-parse', 'refs/heads/main');
  for (const [env, why] of [[{ FAKE_EXTRA_TOOLS: 'Bash' }, /did not start restricted \(it had Bash\)/], [{ FAKE_NO_FIRST_LINE: '1' }, /never said which tools the session had/]]) {
    const id = await task('Files: e.txt');
    Object.assign(process.env, env);
    let fin;
    try {
      fin = await (await runner.startAlone({ item: id, provider: 'key', by: 'mission', restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], commit: true })).done;
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
    assert.equal(fin.state, 'failed', JSON.stringify(env));
    assert.match(fin.reason, why);
    assert.deepEqual(fin.commits, [], 'nothing was committed for it');
  }
  assert.ok(head());
});

test('a restricted run is not started when the installed coding tool does not know the mode: never unrestricted instead', async () => {
  fs.writeFileSync(log, '');
  const id = await task('Files: f.txt');
  const r2 = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 1 }), minuteMs: 400, killGraceMs: 200, restrictedKnown: async () => false });
  test.after(() => r2.close());
  // A run that never started has no end to wait for: its record says why at once.
  const started = await r2.startAlone({ item: id, provider: 'key', by: 'mission', restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], commit: true });
  assert.equal(started.done, undefined);
  const fin = started.run;
  assert.equal(fin.state, 'failed');
  assert.match(fin.reason, /does not know the restricted mode/);
  assert.equal(fs.readFileSync(log, 'utf8'), '', 'the coding tool was never started');
});

test('a mission\'s run that has to wait is told why and not queued; stop() ends one run', async () => {
  const a = await task('DO:hang');
  const b = await task('Files: d.txt');
  const ra = await runner.startAlone({ item: a, provider: 'key', by: 'mission', restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], minutes: 30 });
  const rb = await runner.startAlone({ item: b, provider: 'key', by: 'mission', restricted: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] });
  assert.equal(rb.waiting, true);
  assert.deepEqual(runner.waiting(), [], 'nothing of a mission waits in the dashboard\'s list');
  assert.equal(runner.stop(ra.run.id, 'Tia OFF was pressed'), true);
  const fin = await ra.done;
  assert.equal(fin.state, 'stopped');
  assert.equal(fin.reason, 'Tia OFF was pressed');
  assert.equal(runner.stop('20260101-000000-00000000', 'x'), false);
  assert.equal(t.trapped(), '', 'no trapped program was called');
});

test('one predicate says which sessions are Tia\'s own, and each of them is always restricted (a mission\'s run and a look)', async () => {
  assert.equal(hers({ by: 'mission' }), true);
  assert.equal(hers({ by: 'look' }), true);
  for (const by of ['owner', 'schedule', undefined, 'Mission', 'looks']) assert.equal(hers({ by }), false, String(by));
  assert.equal(hers(null), false);
  const look = { by: 'look', look: { id: 'op-unknown-1', label: 'A look at a failed run' }, project: 'shop', provider: 'key', prompt: 'Look only.' };
  // without its tools, with a tool that writes, on a task of Work or committing: refused before anything starts
  await assert.rejects(runner.startAlone(look), /always restricted/);
  await assert.rejects(runner.startAlone({ ...look, restricted: ['Read', 'Write'] }), /a look only reads/);
  await assert.rejects(runner.startAlone({ ...look, restricted: ['Read', 'Bash'] }), /a look only reads/);
  await assert.rejects(runner.startAlone({ ...look, restricted: ['Read'], commit: true }), /changes nothing/);
  fs.writeFileSync(log, '');
  const fin = await (await runner.startAlone({ ...look, restricted: ['Read', 'Glob', 'Grep'], budget: 1.5 })).done;
  assert.equal(fin.by, 'look');
  const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).args;
  assert.ok(args.includes('--restricted') && args.includes('--strict-mcp-config'), args.join(' '));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.5');
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
  assert.equal(t.trapped(), '', 'no trapped program was called');
});
