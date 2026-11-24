// hoprig tasks schedules, and --repeat / --run-at / --computer on add and edit: the words, --json, refusals, and a
// whole-home snapshot showing that --dry-run of each new form writes nothing anywhere in the person's home.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-clisched');
test.after(() => t.cleanup());
const { main } = await import('../../src/work/cli.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { writerId } = await import('../../src/work/runs.mjs');
fs.mkdirSync(path.join(t.projects, 'shop'), { recursive: true });
t.repo(t.brain, { 'README.md': '# brain\n' });

async function work(...args) {
  let out = '';
  let err = '';
  const code = await main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) });
  return { code, out, err, json: args.includes('--json') && out ? JSON.parse(out) : null };
}

/**
 * Every file under `dir` with a hash of its bytes, and every folder with its time: what a dry run must leave as it
 * was. Left out: the time of Work's lock folder in Hoprig's own state folder (a dry run takes the lock and lets it
 * go, as every dry run of Work does; nothing of the person's is there).
 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(t.root, p);
      if (e.isDirectory()) {
        out[`${rel}/`] = rel === path.join('state', 'work-locks') ? 'lock folder' : fs.statSync(p).mtimeMs;
        walk(p);
      } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('add with --repeat and --run-at; done makes the next; schedules lists both kinds with --json', async () => {
  const me = writerId();
  let r = await work('add', 'Water the plants', '--repeat', 'weekly:1,4', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.item.repeat, { kind: 'weekly', days: [1, 4] });
  r = await work('add', 'Check the shop build', '--project', 'shop', '--repeat', 'daily', '--run-at', '07:30', '--computer', 'here', '--json');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.item.work.at, { time: '07:30', computer: me });
  r = await work('add', 'Pay the rent', '--repeat', 'monthly:31', '--run-at', '08:00');
  assert.match(r.out, /Added pay-the-rent \(repeats; first \d{4}-\d{2}-\d{2}\)/);
  r = await work('done', 'water-the-plants');
  assert.match(r.out, /water-the-plants: open → done; next time \d{4}-\d{2}-\d{2} \(water-the-plants-\d{8}\)/);
  saveConfig({ automation: { schedules: { list: [{ id: 'nightly1', enabled: true, label: 'Nightly check', when: { kind: 'daily', time: '02:00' }, action: { type: 'alone', project: 'shop', prompt: 'Check the build', provider: 'sub' }, since: 0 }] } } });
  r = await work('schedules', '--json');
  assert.equal(r.code, 0, r.err);
  const byId = Object.fromEntries(r.json.rows.map((x) => [x.id, x]));
  assert.equal(byId.nightly1.kind, 'schedule');
  assert.equal(byId.nightly1.what, 'run by itself in shop for at most 30 minutes on sub');
  assert.ok(byId.nightly1.next > Date.now());
  assert.equal(byId['check-the-shop-build'].what, 'every day, run by AI at 07:30');
  assert.equal(byId['check-the-shop-build'].here, true);
  assert.match(byId['pay-the-rent'].problem, /choose the computer/);
  assert.equal(byId['pay-the-rent'].next, null, 'no computer: it runs nowhere');
  const plain = await work('schedules');
  assert.match(plain.out, /schedule {2}Nightly check: run by itself in shop .* · this computer · next /);
  assert.match(plain.out, /Pay the rent: every month on the 31st .* · no computer chosen · due /);
  r = await work('edit', 'pay-the-rent', '--repeat', 'none', '--run-at', 'none', '--json');
  assert.equal(r.json.item.repeat, null);
  assert.equal(r.json.item.work, null);
});

test('refusals: bad words for a repeat or a run time are exit 2 with the reason', async () => {
  for (const [args, re] of [
    [['add', 'Bad one', '--repeat', 'hourly'], /--repeat is daily/],
    [['add', 'Bad one', '--repeat', 'weekly:9'], /weekday/],
    [['add', 'Bad one', '--repeat', 'monthly:0'], /day of the month/],
    [['add', 'Bad one', '--run-at', '7:30'], /07:30/],
    [['add', 'Bad one', '--computer', 'here'], /--computer goes with --run-at/],
    [['add', 'Bad one', '--run-at', '07:30', '--computer', 'box2'], /computer it runs on/],
    [['schedules', 'extra'], /too many words/],
    [['schedules', '--dry-run'], /takes no --dry-run|for the commands that change/],
  ]) {
    const r = await work(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
    assert.match(`${r.out}${r.err}`, re, args.join(' '));
  }
});

test('--dry-run of each new form writes nothing anywhere in the home: a whole-home snapshot', async () => {
  await work('add', 'Seed task', '--json');
  const before = snapshot(t.root);
  for (const args of [
    ['add', 'A dry repeat', '--repeat', 'daily', '--run-at', '06:00', '--computer', 'here', '--dry-run', '--json'],
    ['edit', 'seed-task', '--repeat', 'monthly:15', '--dry-run'],
    ['edit', 'seed-task', '--run-at', '09:15', '--dry-run'],
    ['done', 'check-the-shop-build', '--dry-run'],
  ]) {
    const r = await work(...args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
  }
  assert.deepEqual(snapshot(t.root), before);
});

test('a dry run with --computer here on a computer that has no id yet makes none (nor does schedules)', async () => {
  const file = path.join(process.env.HOPRIG_STATE_DIR, 'work-writer');
  const kept = fs.readFileSync(file);
  fs.rmSync(file);
  try {
    const r = await work('add', 'Water plants', '--repeat', 'weekly:1,4', '--run-at', '07:30', '--computer', 'here', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /dry run: nothing written/);
    assert.equal((await work('schedules', '--json')).code, 0);
    assert.equal(fs.existsSync(file), false, 'no id file made');
  } finally {
    fs.writeFileSync(file, kept);
  }
});

test('schedules: a run time without a project is a problem with no next run; one on another computer says its time on that clock', async () => {
  saveConfig({ automation: { schedules: { list: [] } } });
  let r = await work('add', 'No project AI task', '--run-at', '07:30', '--computer', 'here', '--json');
  assert.equal(r.code, 0, r.err);
  r = await work('add', 'Check the dependencies', '--project', 'shop', '--run-at', '07:30', '--computer', 'b2b2b2b2b2b2b2b2', '--json');
  assert.equal(r.code, 0, r.err);
  const rows = Object.fromEntries((await work('schedules', '--json')).json.rows.map((x) => [x.id, x]));
  assert.match(rows['no-project-ai-task'].problem, /choose the project it runs in/);
  assert.equal(rows['no-project-ai-task'].next, null);
  assert.equal(rows['check-the-dependencies'].at, '07:30');
  assert.equal(rows['check-the-dependencies'].daily, true);
  assert.match((await work('schedules')).out, /Check the dependencies: .* every day at 07:30 on that computer's clock/);
});
