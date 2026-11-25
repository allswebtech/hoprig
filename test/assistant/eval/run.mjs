#!/usr/bin/env node
// Tia's real-model eval: the real engine (headless Claude Code through the hoprig launcher, under a profile)
// + the real `hoprig mcp` + the real core behind a FAKE dashboard that records every operation. Each case is
// graded on the recorded operations, cards and jobs (cases.mjs), never on wording.
//
//   node test/assistant/eval/run.mjs --profile api --model haiku [--cases a,b] [--concurrency 3] [--record]
//   … --jsonl [--candidate <folder>] [--case-file <file.jsonl>]     for an outside improvement loop (below)
//   … --max-usd <dollars> [--end-with-stdin]                         for a round of Improve Tia (below)
//   node test/assistant/eval/run.mjs --text skills/<name> | tools/<tool> | prompt/<section>    prints the shipped text, runs nothing
//
// --jsonl prints, on standard output and nothing else, one line per case { id, pass, score, feedback, tokens, ms }
// and a summary line last, and exits 0 when it ran (2 when it could not: a bad option, a candidate it cannot place,
// a case it cannot grade). --candidate takes skills/<name>/SKILL.md, tools/<tool>.description.txt or
// prompt/<section>.md (never a safety section) from that folder in place of the shipped text, for this run only
// (candidate.mjs). --case-file adds cases in the loop's case shape
// (lines.mjs). --cases - runs none of the cases here (only the case file's).
//
// --max-usd is the whole budget of the run (gate.mjs Budget): a case starts only with its share of what is left, as its
// turn's own limit, so the run never spends more than that (Claude Code may pass a turn's limit a little). The cases
// it could not run are left out of the case lines; the summary names them (not_run) and says what the run cost (cost).
// --end-with-stdin: the run ends, with every program it started, when its standard input closes (the dashboard that
// started it is gone).
//
// A case that fails is run once more at the end of the run. One that passes then is a slip of the model: its line
// and its row say "passed on the second run", the summary counts it apart, and it is not a regression. Only a case
// that fails twice is a FAIL, and only those make REGRESSION lines and the exit code. --jsonl runs each case once.
//
// Without --record it compares the pass counts with baseline.json and exits 1 when any category drops below it
// or any injection case fails twice. --record writes the counts as the new baseline: a case that passed on its second
// run counts as a pass there (the gate's meaning), and is named in the baseline's secondRun and on the screen. Use a
// profile that is NOT a subscription you need: every case is a real model call, and a failed one is called twice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../../src/assistant/engine.mjs';
import { decideMode, wakeMessage } from '../../../src/assistant/jobs.mjs';
import { systemPrompt } from '../../../src/assistant/prompt.mjs';
import { startFakeDashboard, FakeOps } from '../fake-dashboard.mjs';
import { CASES, setupState } from './cases.mjs';
import { TOOL_NAMES } from '../../../src/assistant/tools.mjs';
import { liveText, prepare, readCandidate } from './candidate.mjs';
import { caseLine, readCaseFile, summaryLine } from './lines.mjs';
import { Budget, CASE_USD, baselineOf, counts, endWithStdin, engineProblems, gate, recordNote, regressions, runTwice, summaryText, tableRow, withBudget } from './gate.mjs';

export { counts, regressions };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, 'baseline.json');

function opts(argv) {
  const o = { profile: '', model: '', cases: null, concurrency: 3, record: false, out: '', jsonl: false, candidate: null, caseFile: null, text: null, maxUsd: null, endWithStdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') o.record = true;
    else if (a === '--profile') o.profile = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--cases') o.cases = argv[++i].split(',');
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]) || 1;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--jsonl') o.jsonl = true;
    else if (a === '--candidate') o.candidate = argv[++i];
    else if (a === '--case-file') o.caseFile = argv[++i];
    else if (a === '--text') o.text = argv[++i];
    else if (a === '--tools') o.tools = true;
    else if (a === '--max-usd') {
      o.maxUsd = Number(argv[++i]);
      if (!Number.isFinite(o.maxUsd) || o.maxUsd <= 0) throw new Error('--max-usd is an amount of US dollars above 0');
    } else if (a === '--end-with-stdin') o.endWithStdin = true;
    else throw new Error(`unknown option ${a}`);
  }
  for (const k of ['cases', 'candidate', 'caseFile', 'text', 'out', 'profile', 'model']) if (o[k] === undefined) throw new Error('an option is missing its value');
  if (o.text || o.tools) return o;
  if (o.record && (o.jsonl || o.candidate || o.caseFile)) throw new Error('--record takes the shipped texts and cases only');
  if (!o.profile) throw new Error('--profile is required (use an API or gateway profile, not a subscription you need)');
  return o;
}

async function runCase(c, o, i, attempt = 1, usd = CASE_USD) {
  const ops = new FakeOps(setupState(c));
  // The real model knows the real time: the fake progress of this case is read now (to the minute), as on a real
  // dashboard, so its "as of" and her clock agree. Kept per case: four run at once.
  const progressNow = Math.floor(Date.now() / 60_000) * 60_000;
  ops.s.work.progressNow = progressNow;
  const dash = await startFakeDashboard({ ops, ...(o.prep.skills ? { skills: o.prep.skills() } : {}) });
  const conversation = `eval-${i}${attempt > 1 ? `r${attempt}` : ''}-${c.id}`.slice(0, 64);
  // The fake dashboard's token goes to a file, as the real dashboard does (the engine passes the file, not the token).
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-eval-'));
  const tokenFile = path.join(tokenDir, 'assistant-token');
  fs.writeFileSync(tokenFile, dash.token, { mode: 0o600 });
  const engine = new Engine({
    profile: o.profile, model: o.model || null, maxBudgetUsd: usd,
    systemPrompt: systemPrompt(dash.core.skills.index(), o.prep.prompt), url: dash.url, tokenFile, conversation,
    dir: path.join(tokenDir, 'conv'),
    ...(o.prep.mcpCommand ? { mcpCommand: o.prep.mcpCommand } : {}),
    // Tests only: a stand-in for Claude Code (no model, no provider), given as a script to run with node.
    ...(process.env.HOPRIG_EVAL_ENGINE ? { command: { command: process.execPath, args: [process.env.HOPRIG_EVAL_ENGINE] }, resolveEnv: async () => ({ ...process.env }) } : {}),
  });
  const events = [];
  engine.on('event', (e) => events.push(e));
  let message = c.message;
  if (c.wake) {
    // A job Tia started earlier now wakes her: the session belongs to the job and counts as shown. wake.mine false:
    // the job watches a session she did not start as hers (one on an earlier conversation).
    const job = dash.core.jobs.create({ conversation, goal: c.wake.goal, ...(c.wake.work ? { work: c.wake.work } : {}) });
    const made = ops.s.sessions.find((x) => x.computer === 'this' && x.name === c.wake.session);
    dash.core.jobs.attach(job.id, { computer: 'this', session: c.wake.session, startedByTia: c.wake.mine !== false, created: made ? made.created : null });
    dash.core.shown.add(conversation, { session: [`this|${c.wake.session}`], job: [job.id] });
    // A job that follows a Work run: its run and its task count as shown, as the dashboard's wake does (core.mjs).
    if (c.wake.work) dash.core.shown.add(conversation, { run: [`this|${c.wake.work.run}`], task: [`this|${c.wake.work.task}`] });
    const j = dash.core.jobs.get(job.id);
    const screen = ops.s.screens[`this|${c.wake.session}`] || '';
    // As the dashboard's wake (core.mjs jobTick): a Work job's wake says how its run ended, and its mode follows the job.
    const run = c.wake.work ? ops.s.work.runs.find((x) => x.id === c.wake.work.run) : null;
    const ev = { job: j, entry: j.sessions[0], reason: c.wake.reason, ...(run ? { run: { state: run.state } } : {}) };
    const mode = decideMode(ev);
    message = wakeMessage(ev, mode, screen);
    dash.core.beginTurn(conversation, { origin: 'job', job: job.id, mode });
  } else dash.core.beginTurn(conversation, { origin: 'owner', text: message });
  const started = Date.now();
  let res;
  try {
    res = await engine.send(message, { timeoutMs: 4 * 60_000 });
  } finally {
    engine.cleanup();
    dash.core.endTurn(conversation);
    await dash.close();
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }
  const init = events.find((e) => e.kind === 'init');
  const r = {
    calls: ops.calls,
    reads: ops.reads, // what she looked at (a check that changes nothing is graded on its read)
    cards: dash.core.cards.pending(),
    jobs: dash.core.jobs.list(),
    finalText: events.filter((e) => e.kind === 'text').map((e) => e.text).join('\n'),
    tools: events.filter((e) => e.kind === 'tool_call').map((e) => e.rawName),
    trace: events.filter((e) => e.kind === 'tool_call').map((e) => ({ call: e.name, input: e.input })),
    progressNow, // the clock of this case's progress (graders compare with it)
    results: events.filter((e) => e.kind === 'tool_result').map((e) => String(e.text || '')), // what her tools told her (a grader checks her figures against it)
  };
  const problems = [];
  if (!res.done.ok) problems.push(`the turn did not finish: ${res.done.subtype} ${res.done.text.slice(0, 200)}`);
  problems.push(...engineProblems(init, r.tools));
  problems.push(...c.grade(r));
  return {
    id: c.id, category: c.category, tags: c.tags || null, message, ms: Date.now() - started, pass: problems.length === 0, problems,
    tools: r.tools.map((t) => t.replace('mcp__hoprig__', '')), ops: r.calls.map((x) => x.op), cards: r.cards.map((x) => x.tool),
    costUsd: res.done.costUsd, usage: res.done.usage || null, requests: Number.isFinite(res.done.turns) ? res.done.turns : null, seconds: Math.round((Date.now() - started) / 1000),
    model: init ? init.model : null, reply: r.finalText.slice(0, 400),
    trace: events.filter((e) => e.kind === 'tool_call' || e.kind === 'tool_result').map((e) => (e.kind === 'tool_call' ? { call: e.name, input: e.input } : { result: e.text.slice(0, 600), isError: e.isError })),
  };
}

async function main() {
  const o = opts(process.argv.slice(2));
  if (o.endWithStdin) endWithStdin();
  if (o.text) {
    process.stdout.write(liveText(o.text));
    return 0;
  }
  // The names of the tools Tia's model can call, for an outside improvement loop: it reads them from here, never from a
  // copy of its own, so a tool added or renamed here is the one its threat gate looks for.
  if (o.tools) {
    process.stdout.write(`${JSON.stringify(TOOL_NAMES)}\n`);
    return 0;
  }
  const own = o.cases && o.cases.length === 1 && o.cases[0] === '-' ? [] : o.cases;
  const unknown = (own || []).filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length) throw new Error(`no such case: ${unknown.slice(0, 5).join(', ')}`);
  const extra = o.caseFile ? readCaseFile(o.caseFile) : [];
  const cases = [...(own ? CASES.filter((c) => own.includes(c.id)) : CASES), ...extra];
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('a case id is used twice');
  if (!cases.length) throw new Error('no case to run');
  const cand = o.candidate ? readCandidate(path.resolve(o.candidate)) : null;
  o.prep = prepare(cand);
  const budget = o.maxUsd ? new Budget(o.maxUsd, o.concurrency) : null;
  const one = (c, i, attempt) => (budget ? withBudget(budget, c, (usd) => runCase(c, o, i, attempt, usd)) : runCase(c, o, i, attempt));
  let results;
  try {
    results = await runTwice(cases, o.concurrency, one, (line) => console.error(line), { once: o.jsonl });
  } finally {
    o.prep.cleanup();
  }
  if (o.jsonl) {
    const ran = results.filter((r) => !r.skipped);
    const lines = ran.map(caseLine);
    const spent = { not_run: results.filter((r) => r.skipped).map((r) => r.id), cost: Math.round(results.reduce((n, r) => n + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0) * 1e6) / 1e6 };
    const summary = { ...summaryLine(lines, cand ? cand.parts : null, ran), ...(budget ? spent : {}) };
    const text = `${[...lines, summary].map((l) => JSON.stringify(l)).join('\n')}\n`;
    process.stdout.write(text);
    if (o.out) fs.writeFileSync(o.out, text);
    return 0;
  }
  const by = counts(results);
  console.log('\n| case | category | result | tools called | graded on |');
  console.log('|---|---|---|---|---|');
  for (const r of results) console.log(tableRow(r));
  console.log(`\n${summaryText(results)}`);
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(results, null, 2));
  if (o.record) {
    if (o.cases || o.caseFile) throw new Error('record a baseline from the full case list only');
    const base = baselineOf(results, { model: o.model || null });
    fs.writeFileSync(BASELINE, JSON.stringify(base, null, 2) + '\n');
    console.log(`baseline written: ${path.relative(process.cwd(), BASELINE)}`);
    if (recordNote(base)) console.log(recordNote(base));
    return by.injection && by.injection.pass < by.injection.total ? 1 : 0;
  }
  let base = { categories: {} };
  try {
    base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch {
    console.error('no baseline yet: run with --record once');
  }
  const bad = gate(results, base, { subset: !!o.cases });
  for (const b of bad) console.error(`REGRESSION ${b}`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`eval: ${e.message}`);
    process.exit(2);
  });
}
