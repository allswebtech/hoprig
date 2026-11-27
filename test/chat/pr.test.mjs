// The pull request line of the session rail (src/chat/pr.mjs): gh's answer read into passing, failing or running; no gh
// and no pull request give no line; the merge needs the owner's confirmation. gh is never run: o.run is a stand-in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checksOf, mergeWhenReady, prState } from '../../src/chat/pr.mjs';

const run = (answers) => async (argv) => {
  const line = argv.join(' ');
  const key = Object.keys(answers).find((k) => line === k || line.startsWith(`${k} `));
  const a = answers[key];
  if (key === undefined) return { ok: false, code: 1, stdout: '', stderr: 'unexpected', error: null };
  return typeof a === 'function' ? a(argv) : a;
};
const good = (o) => ({ ok: true, code: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o), stderr: '', error: null });

test('checks: any failure is failing, else anything still going is running, else passing; none is nothing', () => {
  assert.equal(checksOf([]), null);
  assert.equal(checksOf(undefined), null);
  assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'running');
  assert.equal(checksOf([{ status: 'QUEUED' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failing', 'a failure outranks a check still running');
  assert.equal(checksOf([{ state: 'PENDING' }]), 'running');
  assert.equal(checksOf([{ state: 'ERROR' }]), 'failing');
  assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'failing');
});

test('the state: a pull request with its checks; no gh, no pull request, a closed one: no line', async () => {
  const row = { number: 12, title: 'Cart totals', url: 'https://example.com/o/r/pull/12', state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const base = { 'git remote': good('origin\n'), 'git rev-list --count': good('2\n') };
  const r = await prState('/x', { run: run({ ...base, 'gh pr view': good(row) }) });
  assert.deepEqual(r, { remote: true, ahead: 2, gh: true, pr: { number: 12, title: 'Cart totals', url: 'https://example.com/o/r/pull/12', checks: 'passing' } });
  const none = await prState('/x', { run: run({ ...base, 'gh pr view': { ok: false, code: 1, stdout: '', stderr: 'no pull requests found for branch "x"', error: null } }) });
  assert.deepEqual([none.gh, none.pr], [true, null], 'gh is there, the branch has no pull request');
  const noGh = await prState('/x', { run: run({ ...base, 'gh pr view': { ok: false, code: null, stdout: '', stderr: '', error: 'ENOENT' } }) });
  assert.deepEqual([noGh.gh, noGh.pr], [false, null], 'no gh: no line, and no Create PR either');
  const closed = await prState('/x', { run: run({ ...base, 'gh pr view': good({ ...row, state: 'MERGED' }) }) });
  assert.equal(closed.pr, null);
  const junk = await prState('/x', { run: run({ ...base, 'gh pr view': good('not json') }) });
  assert.equal(junk.pr, null);
  const bare = await prState('/x', { run: run({ 'git remote': good(''), 'git rev-list --count': { ok: false, code: 128, stdout: '', stderr: 'no upstream', error: null } }) });
  assert.deepEqual(bare, { remote: false, ahead: null, gh: false, pr: null }, 'no remote: gh is not asked at all');
});

test('a title is plain text and bounded', async () => {
  const row = { number: 3, title: `${'x'.repeat(500)}\u0007`, url: 'javascript:alert(1)', state: 'OPEN', statusCheckRollup: [] };
  const r = await prState('/x', { run: run({ 'git remote': good('origin\n'), 'git rev-list --count': good('0\n'), 'gh pr view': good(row) }) });
  assert.ok(r.pr.title.length <= 200 && !r.pr.title.includes('\u0007'));
  assert.equal(r.pr.url, null, 'only an http or https address is a link');
  assert.equal(r.pr.checks, null);
});

const VIEW = (o) => good({ number: 12, state: 'OPEN', mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], ...o });

test('merge when ready: gh pr merge <number> --auto --squash, and its failure says why', async () => {
  const seen = [];
  const ok = await mergeWhenReady('/x', { number: 12, run: async (argv) => (seen.push(argv), argv[2] === 'view' ? VIEW() : good('')) });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(seen[1].slice(0, 6), ['gh', 'pr', 'merge', '12', '--auto', '--squash']);
  const bad = await mergeWhenReady('/x', { number: 12, run: async (argv) => (argv[2] === 'view' ? VIEW() : { ok: false, code: 1, stdout: '', stderr: 'Pull request is not mergeable\nmore', error: null }) });
  assert.deepEqual(bad, { ok: false, error: 'Pull request is not mergeable' });
});

test('merge when ready never merges at once while the checks run or fail (a repository without required checks)', async () => {
  for (const [rollup, word] of [[[{ status: 'IN_PROGRESS' }], 'still running'], [[{ status: 'COMPLETED', conclusion: 'FAILURE' }], 'failing']]) {
    const seen = [];
    const r = await mergeWhenReady('/x', { number: 12, run: async (argv) => (seen.push(argv), argv[2] === 'view' ? VIEW({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: rollup }) : good('')) });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(word));
    assert.ok(!seen.some((a) => a[2] === 'merge'), 'gh pr merge was not called');
  }
  // with required checks waiting (BLOCKED) gh --auto really waits: that is what the confirmation says
  const seen = [];
  const w = await mergeWhenReady('/x', { number: 12, run: async (argv) => (seen.push(argv), argv[2] === 'view' ? VIEW({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }) : good('')) });
  assert.deepEqual(w, { ok: true });
});

test('merge when ready acts on the pull request the owner saw, never on another one of the branch', async () => {
  const seen = [];
  const r = await mergeWhenReady('/x', { number: 12, run: async (argv) => (seen.push(argv), argv[2] === 'view' ? VIEW({ number: 13 }) : good('')) });
  assert.equal(r.ok, false);
  assert.match(r.error, /another pull request now/);
  assert.ok(!seen.some((a) => a[2] === 'merge'));
  assert.equal((await mergeWhenReady('/x', { run: async () => good('') })).ok, false, 'no number: refused');
  assert.match((await mergeWhenReady('/x', { number: 12, run: async () => VIEW({ state: 'MERGED' }) })).error, /not open any more/);
});
