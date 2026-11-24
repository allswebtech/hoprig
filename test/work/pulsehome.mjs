// A made-up home with a history, for the progress tests (pulse, the command, the route, the digest): twelve finished
// runs of three kinds, four running, one finished that waits for his look, one failed, a session that waits for his
// answer and a working session with a workflow of two phases and four agents. Everything is written as the product
// writes it: run files in the brain's Work folder, the launcher's records in the state folder, Claude Code's
// workflow records and transcript under CLAUDE_CONFIG_DIR. Made-up names only.
import fs from 'node:fs';
import path from 'node:path';

export async function makeHistory(t) {
  const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  const { resolvePlace } = await import('../../src/work/place.mjs');
  for (const p of ['shop', 'alpha', 'beta']) fs.mkdirSync(path.join(t.projects, p), { recursive: true });
  fs.mkdirSync(path.join(t.brain, 'work'), { recursive: true });
  const place = resolvePlace({}, {});
  const H = 3_600_000;
  const M = 60_000;
  const NOW = Date.parse('2026-11-19T06:00:00Z');

  let n = 0;
  const run = (o) => {
    n += 1;
    const startedAt = new Date(o.start).toISOString();
    const id = newRunId(new Date(o.start)).replace(/-[0-9a-f]{8}$/, `-${String(n).padStart(8, '0')}`);
    const r = {
      v: 1, id, item: o.item || `task-${n}`, title: o.title || `Task ${n}`, writer: writerId(), by: o.schedule ? 'schedule' : 'owner',
      startedAt, endedAt: o.ms === undefined ? null : new Date(o.start + o.ms).toISOString(), project: o.project || 'shop', folder: '.', tool: 'claude',
      provider: 'sub', model: o.model ?? 'opus', effort: o.effort ?? 'medium', session: null, conversation: null, message: null, brief: 'Do it',
      state: o.state || (o.ms === undefined ? 'running' : 'done'), reason: o.reason || null, answer: '', commits: [], changed: [], more: 0, was: 'open',
      statusError: null, branch: o.schedule ? 'work/nightly' : null, schedule: o.schedule || null, ...(o.used ? { used: o.used } : {}),
    };
    writeRun(place, r);
    return r;
  };
  const day = (d, h = 0) => Date.parse(`2026-11-${d}T${String(h).padStart(2, '0')}:00:00Z`);
  // Kind 1: shop, code (opus, medium): four finished, 1 h to 2 h.
  const code = [[10, H], [11, 1.5 * H], [12, 2 * H], [13, 1.25 * H]].map(([d, ms]) => run({ start: day(d, 9), ms }));
  // Kind 2: shop, mechanical (sonnet, low): four finished, 10 to 20 minutes.
  const mech = [[10, 10 * M], [11, 15 * M], [12, 20 * M], [13, 12 * M]].map(([d, ms]) => run({ start: day(d, 14), ms, model: 'sonnet', effort: 'low' }));
  // Kind 3: a schedule's nightly run: four finished, 5 h 30 to 8 h 30, three of them with what they used.
  const used = (k) => ({ input: k, output: 2 * k, cacheRead: 0, cacheWrite: 0, costUsd: null });
  const night = [[14, 5.5 * H, used(1000)], [15, 8.5 * H, used(2000)], [16, 6 * H, used(3000)], [17, 7 * H, null]].map(([d, ms, u]) => run({ start: day(d, 0), ms, schedule: 'nightly1', project: 'alpha', ...(u ? { used: u } : {}) }));
  // Running: one of each kind, and one of a kind with a single finished run (no estimate).
  const lone = run({ start: day(12, 1), ms: H, project: 'beta' });
  const running = [
    run({ start: NOW - 30 * M, title: 'Cart fix' }),
    run({ start: NOW - 5 * M, title: 'Rename files', model: 'sonnet', effort: 'low' }),
    run({ start: NOW - 2 * H, title: 'Nightly', schedule: 'nightly1', project: 'alpha' }),
    run({ start: NOW - 10 * M, title: 'Beta work', project: 'beta' }),
  ];
  // Finished last night and waits for his look; and one that failed with a long error of the tool.
  const looks = run({ start: NOW - 4 * H, ms: H, item: 'add-the-cart', title: 'Add the cart' });
  const failed = run({ start: NOW - 3 * H, ms: 20 * M, state: 'failed', title: 'Pay page', reason: 'The run ended in an error: the tests in checkout failed because the payment stand-in did not answer within the time it was given' });
  const items = [{ id: 'add-the-cart', status: 'review' }];

  // A session of this computer, working, with a workflow of two phases and four agents; a second one that waits for
  // his answer. Their run records are in the state folder, as the launcher writes them.
  const cwd = path.join(t.projects, 'shop');
  const conv = '11111111-2222-3333-4444-555555555555';
  const recs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.mkdirSync(recs, { recursive: true });
  fs.writeFileSync(path.join(recs, 'a.json'), JSON.stringify({ runId: 'a', pid: process.pid, cwd, sessionId: conv, status: 'working', startedAt: NOW - 50 * M, statusAt: NOW - M }));
  fs.writeFileSync(path.join(recs, 'b.json'), JSON.stringify({ runId: 'b', pid: process.pid, cwd: path.join(t.projects, 'beta'), sessionId: null, status: 'attention', startedAt: NOW - 40 * M, statusAt: NOW - 20 * M, askAt: NOW - 18 * M }));
  fs.writeFileSync(path.join(recs, 'c.json'), JSON.stringify({ runId: 'c', pid: 999999999, cwd, sessionId: null, status: 'working', startedAt: NOW - H, statusAt: NOW }));
  const wfDir = path.join(projectDir(cwd), conv, 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const agent = (i, phase, state) => ({ type: 'workflow_agent', index: i, label: `agent ${i}`, phaseIndex: phase, state, startedAt: NOW - (40 - i) * M, lastProgressAt: NOW - (10 - i) * M });
  fs.writeFileSync(path.join(wfDir, 'wf1.json'), JSON.stringify({ taskId: 'wf1', workflowName: 'lane', status: 'running', startTime: NOW - 40 * M, totalTokens: 123456,
    workflowProgress: [{ type: 'workflow_phase', index: 0, title: 'build' }, { type: 'workflow_phase', index: 1, title: 'review' }, agent(0, 0, 'done'), agent(1, 0, 'done'), agent(2, 1, 'progress'), agent(3, 1, 'start')] }));
  // Two finished workflows of the same name in another conversation of the folder: its basis.
  for (const [k, ms] of [['wf0', 50 * M], ['wfz', 70 * M]]) {
    const d = path.join(projectDir(cwd), `conv-${k}`, 'workflows');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${k}.json`), JSON.stringify({ taskId: k, workflowName: 'lane', status: 'completed', startTime: day(15, 3), durationMs: ms, totalTokens: 9 }));
  }
  // The transcript of the working session: two assistant messages with usage, one of them written twice (as Claude
  // Code writes a message per content block): counted once.
  const tline = (id, u) => JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [], usage: u } });
  fs.writeFileSync(path.join(projectDir(cwd), `${conv}.jsonl`), [tline('m1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }), tline('m1', { input_tokens: 10, output_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }), tline('m2', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 40 }), ''].join('\n'));

  fs.writeFileSync(place.file, `${JSON.stringify({ items: [{ id: 'add-the-cart', title: 'Add the cart', date: null, kind: 'task', status: 'review', project: 'shop', by: 'ai', created: '2026-11-18' }] }, null, 2)}\n`);
  return { place, NOW, H, M, day, code, mech, night, lone, running, looks, failed, items, cwd, conv };
}
