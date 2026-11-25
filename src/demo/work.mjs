// The demo's Work: a made-up plan with its tasks, and one finished Lead run of one of them whose helpers did parts of
// it, so a task's run and the plan's page show "Who did what". The run is written as Work writes one (work/runs.mjs),
// the coding tool's records beside its conversation as Claude Code writes them (models/parts.mjs reads them). All
// made up, in the demo's own home; nothing is started and no model is asked.
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = 'shop-frontend';
const CONVERSATION = 'd3e0a1b2-0000-4000-8000-00000000c0de';

/** A line of a transcript: one assistant message with its usage (agent: a helper's name, or none for the lead). */
const line = (agent, id, model, use, at) => JSON.stringify({
  type: 'assistant', timestamp: new Date(at).toISOString(), ...(agent ? { attributionAgent: agent, isSidechain: true } : {}),
  message: { id, model, usage: { input_tokens: use[0], output_tokens: use[1], cache_read_input_tokens: use[2], cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'Done.' }] },
});

/** projects: the demo's projects folder. Writes the Work list only when the demo has none yet. */
export async function demoWork(projects) {
  const { loadConfig } = await import('../config.mjs');
  const { resolvePlace } = await import('../work/place.mjs');
  const { writePlan } = await import('../work/plans.mjs');
  const { newRunId, writeRun, writerId } = await import('../work/runs.mjs');
  const { projectDir } = await import('../sessions.mjs');
  const place = resolvePlace(loadConfig());
  if (fs.existsSync(place.file)) return;
  fs.mkdirSync(place.folder, { recursive: true });
  const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  const plan = {
    v: 1, id: 'faster-checkout', title: 'A faster checkout', goal: 'The checkout page is ready to use in two seconds on a small phone.', projects: [PROJECT],
    milestones: [{ id: 'measure', title: 'Measured', date: day(3) }, { id: 'lighter', title: 'Lighter pages', date: day(10) }], note: null,
    made: { at: new Date(Date.now() - 2 * 86400_000).toISOString(), how: 'hand' }, status: 'active',
  };
  writePlan(place, plan, { projects: [PROJECT] });
  const task = (id, title, o) => ({ id, title, date: null, kind: 'task', status: 'open', project: PROJECT, by: 'ai', created: day(-2), plan: plan.id, ...o });
  const items = [
    task('measure-the-checkout', 'Measure how long the checkout takes to load', { milestone: 'measure', status: 'done', date: day(-1), doneAt: day(-1) }),
    task('shrink-the-images', 'Make the product images smaller', { milestone: 'lighter', date: day(6), after: ['measure-the-checkout'] }),
    task('load-the-map-later', 'Load the store map only when it is opened', { milestone: 'lighter', date: day(9) }),
  ];
  fs.writeFileSync(place.file, `${JSON.stringify({ items }, null, 2)}\n`);

  // The measuring task's run: the lead planned it and handed the parts to its helpers.
  const started = Date.now() - 26 * 3_600_000;
  writeRun(place, {
    v: 1, id: newRunId(new Date(started)), item: items[0].id, title: items[0].title, writer: writerId(), by: 'owner',
    startedAt: new Date(started).toISOString(), endedAt: new Date(started + 38 * 60_000).toISOString(), project: PROJECT, folder: '.', tool: 'claude',
    provider: 'max', model: 'claude-opus-5-5', effort: 'medium', session: null, conversation: CONVERSATION, message: null, brief: `Do it: ${items[0].title}`,
    state: 'done', reason: null, answer: 'Measured on a small phone over a slow line: 5.8 s to the first use. The product images are 3.1 MB of the 3.9 MB the page loads; the store map script is the next largest.',
    commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
  const dir = projectDir(fs.realpathSync(path.join(projects, PROJECT)));
  const sub = path.join(dir, CONVERSATION, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, `${CONVERSATION}.jsonl`), `${line(null, 'lead-1', 'claude-opus-5-5', [2400, 1900, 186000], started + 36 * 60_000)}\n`);
  fs.writeFileSync(path.join(sub, 'agent-runner1.jsonl'), `${line('hoprig-runner', 'run-1', 'claude-haiku-5-5', [9100, 1400, 52000], started + 9 * 60_000)}\n`);
  fs.writeFileSync(path.join(sub, 'agent-coder1.jsonl'), `${line('hoprig-coder', 'code-1', 'claude-sonnet-5-5', [14800, 6200, 98000], started + 24 * 60_000)}\n`);
  fs.writeFileSync(path.join(sub, 'agent-thinker1.jsonl'), `${line('hoprig-thinker', 'think-1', 'claude-opus-5-5', [3900, 2100, 41000], started + 31 * 60_000)}\n`);
}
