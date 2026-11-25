// A stand-in for Tia's eval runner (test/assistant/eval/run.mjs --jsonl), for the tests of "Improve Tia": no model, no
// engine, no dashboard. It prints one line per case and a summary line, as the real runner does, and decides each case
// by a mark in the candidate's text ("MARK:better", "MARK:tie", "MARK:drop", "MARK:inject"; none: the shipped texts).
// Every start is written as one line to STANDIN_LOG: its arguments, the candidate's files, its pid.
//   STANDIN_COST   the cost of each case (default 0.0001)    STANDIN_TRACE  a tool the failing cases called
//   STANDIN_CAND_COST  the cost of each case in a run with a candidate (default STANDIN_COST)
//   STANDIN_SLOW   the baseline waits a minute before it prints (for Stop)
import fs from 'node:fs';
import path from 'node:path';
import { Budget, endWithStdin, withBudget } from './eval/gate.mjs';

const argv = process.argv.slice(2);
const val = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const cand = val('--candidate');
const files = [];
let text = '';
if (cand) {
  for (const rel of fs.readdirSync(cand, { recursive: true }).sort()) {
    const f = path.join(cand, rel);
    if (fs.statSync(f).isFile()) {
      files.push(rel.split(path.sep).join('/'));
      text += fs.readFileSync(f, 'utf8');
    }
  }
}
if (process.env.STANDIN_LOG) fs.appendFileSync(process.env.STANDIN_LOG, `${JSON.stringify({ argv, files, pid: process.pid })}\n`);
const mark = (/MARK:([a-z]+)/.exec(text) || [])[1] || 'live';
const whole = !val('--cases');

const CASES = [
  ['happy-one', 'happy'], ['happy-two', 'happy'], ['happy-three', 'happy'], ['happy-four', 'happy'], ['happy-five', 'happy'], ['happy-six', 'happy'],
  ['fails-first', 'happy'], ['fails-second', 'happy'], ['accounts-one', 'accounts'], ['inject-one', 'injection'], ['inject-two', 'injection'],
];

function passes(id) {
  if (id.startsWith('fails-')) return ['better', 'drop', 'inject'].includes(mark) || (mark === 'tie' && id === 'fails-first');
  if (whole && mark === 'tie' && id === 'happy-six') return false; // one fixed, one broken: a tie
  if (whole && mark === 'drop' && id === 'accounts-one') return false; // two fixed, a category below the baseline
  if (mark === 'inject' && id === 'inject-one') return false;
  return true;
}

// --max-usd: the real runner's budget (gate.mjs Budget, withBudget), one case at a time; a case that would cost more
// than its share is cut at it, as Claude Code ends a turn at --max-budget-usd. --end-with-stdin: as the real runner.
async function main() {
  const wanted = val('--cases') ? new Set(val('--cases').split(',')) : null;
  const cost = Number((cand && process.env.STANDIN_CAND_COST) || process.env.STANDIN_COST || 0.0001);
  const max = val('--max-usd') ? Number(val('--max-usd')) : null;
  const budget = max ? new Budget(max, 1) : null;
  const all = [];
  for (const [id, category] of CASES.filter(([x]) => !wanted || wanted.has(x))) {
    const run = async (limit) => {
      const pass = passes(id) && cost <= limit;
      return { id, category, pass, costUsd: Math.min(cost, limit) };
    };
    all.push(budget ? await withBudget(budget, { id, category }, run) : await run(Infinity));
  }
  const lines = all.filter((r) => !r.skipped).map(({ id, category, pass, costUsd }) => ({
    id, pass, score: pass ? 1 : 0, feedback: pass ? '' : 'it started no chat for the task; it answered in words only', tokens: 100, ms: 5, category, message: `the request of ${id}`,
    trace: !pass && process.env.STANDIN_TRACE ? [{ call: process.env.STANDIN_TRACE, input: {} }] : [], cost: costUsd,
  }));
  const passed = lines.filter((l) => l.pass).length;
  const summary = {
    summary: true, cases: lines.length, passed, failed: lines.length - passed, score: lines.length ? passed / lines.length : 0, safety_failed: [], tokens: 100 * lines.length, ms: 5 * lines.length, candidate: files,
    ...(budget ? { not_run: all.filter((r) => r.skipped).map((r) => r.id), cost: Math.round(all.reduce((n, r) => n + (r.costUsd || 0), 0) * 1e6) / 1e6 } : {}),
  };
  process.stdout.write(`${[...lines, summary].map((l) => JSON.stringify(l)).join('\n')}\n`, () => process.exit(0));
}

if (argv.includes('--end-with-stdin')) endWithStdin();
if (process.env.STANDIN_SLOW && !cand) setTimeout(main, 60_000);
else main();
