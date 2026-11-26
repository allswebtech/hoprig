// More of the stand-in Claude Code (fake-claude.mjs): thinking, a diff, subagents, background tasks and workflows,
// in the shapes Claude Code 2.1.325 gives them (task_started / task_progress / task_updated / task_notification,
// background_tasks_changed, workflow_progress), and the turn it starts by itself when a background task ended.
//   "think"          a thinking block, then text
//   "edit <file>"    Edit of an existing file (no OK asked): its result carries the patch (tool_use_result)
//   "agent"          a foreground subagent that runs a command: its lines carry parent_tool_use_id
//   "bgagent <ms>"   a background subagent (model sonnet, effort low): the turn ends at once; after <ms> it ends,
//                    and Claude Code goes on by itself (a new turn: init, text, result)
//   "bgsleep"        a background command that runs until stop_task
//   "workflow <ms>"  a background workflow of two phases and three agents, then the turn of its own
//   "limits"         a plan-limit line (rate_limit_event), then text
//   "compact"        compacting: status, compact_boundary
//   "title <words>"  the conversation gets a title
//   "slow <ms>"      answers after <ms> (a turn that runs a while)
//   "waitfor <file>" answers by itself once <file> exists (looked at every 50 ms), at the latest after 60 s: a turn
//                    that runs exactly until a test lets it end
//   "clear"          the conversation gets a new id (conversation_reset), as /clear does
//   "commit <file>"  writes <file>, commits it (git) and leaves <file>.draft not committed; its report names the
//                    folder by its full path and carries a key
//   "fail <words>"   a turn that ends in an error whose words are <words>
//   "hitlimit"       a 5000-character reply, then a usage-limit result, then it exits (as "big", in a longer message)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function tasks({ out, assistant, user, tool, result, sessionId, ownTurn }) {
  const sys = (subtype, o) => out({ type: 'system', subtype, ...o, session_id: sessionId, uuid: `s${Math.random()}` });
  const running = new Map(); // task id → () => end it as stopped
  const later = (ms, fn) => setTimeout(fn, ms);
  let t = 0;
  const taskId = (p) => `${p}${(++t).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  async function more(text) {
    let m;
    if (text === 'think') {
      assistant([{ type: 'thinking', thinking: 'First the question, then the answer.', signature: 'c2ln' }, { type: 'text', text: 'Forty-two.' }]);
      return result(true) || true;
    }
    if ((m = /^edit (\S+)/.exec(text))) {
      const file = path.resolve(m[1]);
      const before = fs.readFileSync(file, 'utf8');
      const input = { file_path: file, old_string: before.split('\n')[0], new_string: 'changed' };
      const id = tool('Edit', input);
      fs.writeFileSync(file, before.replace(input.old_string, 'changed'));
      user([{ type: 'tool_result', tool_use_id: id, content: `The file ${file} has been updated successfully.` }], {
        result: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${input.old_string}`, '+changed'] }] },
      });
      assistant([{ type: 'text', text: 'Edited.' }]);
      return result(true) || true;
    }
    if (text === 'agent') {
      const id = tool('Agent', { description: 'Look around', prompt: 'look around', subagent_type: 'Explore', run_in_background: false });
      const task = taskId('a');
      sys('task_started', { task_id: task, tool_use_id: id, description: 'Look around', subagent_type: 'Explore', is_backgrounded: false, spawn_depth: 1, task_type: 'local_agent', prompt: 'look around' });
      user([{ type: 'text', text: 'look around' }], { parent: id });
      sys('task_progress', { task_id: task, tool_use_id: id, description: 'Running ls', usage: { total_tokens: 900, tool_uses: 1, duration_ms: 40 }, last_tool_name: 'Bash' });
      assistant([{ type: 'tool_use', id: `${id}_sub`, name: 'Bash', input: { command: 'ls', description: 'list' } }], { parent: id, noRecord: true });
      user([{ type: 'tool_result', tool_use_id: `${id}_sub`, content: 'a.txt' }], { parent: id });
      assistant([{ type: 'text', text: 'There is a.txt.' }], { parent: id, noRecord: true });
      sys('task_updated', { task_id: task, patch: { status: 'completed', end_time: Date.now() } });
      sys('task_notification', { task_id: task, tool_use_id: id, status: 'completed', summary: 'There is a.txt.', usage: { total_tokens: 1000, tool_uses: 1, duration_ms: 60 } });
      user([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'There is a.txt.' }] }]);
      assistant([{ type: 'text', text: 'The helper looked.' }]);
      return result(true) || true;
    }
    if ((m = /^bgagent (\d+)/.exec(text))) {
      const id = tool('Agent', { description: 'Background hi', prompt: 'say hi', subagent_type: 'general-purpose', run_in_background: true, model: 'sonnet', effort: 'low' });
      const task = taskId('a');
      sys('background_tasks_changed', { tasks: [{ task_id: task, task_type: 'local_agent', description: 'Background hi' }] });
      sys('task_started', { task_id: task, tool_use_id: id, description: 'Background hi', subagent_type: 'general-purpose', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent', prompt: 'say hi' });
      user([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${task}` }] }]);
      assistant([{ type: 'text', text: 'It runs in the background.' }]);
      result(true);
      later(Number(m[1]), () => {
        assistant([{ type: 'text', text: 'hi from the background' }], { parent: id, noRecord: true });
        sys('task_updated', { task_id: task, patch: { status: 'completed', end_time: Date.now() } });
        sys('task_notification', { task_id: task, tool_use_id: id, status: 'completed', summary: 'hi from the background', usage: { total_tokens: 500, tool_uses: 0, duration_ms: 30 } });
        sys('background_tasks_changed', { tasks: [] });
        ownTurn(async () => {
          assistant([{ type: 'text', text: 'The background helper said hi.' }]);
          result(true);
        });
      });
      return true;
    }
    if (text === 'bgsleep') {
      const id = tool('Bash', { command: 'sleep 600', description: 'wait in the background', run_in_background: true });
      const task = taskId('b');
      sys('background_tasks_changed', { tasks: [{ task_id: task, task_type: 'local_bash', description: 'wait in the background' }] });
      sys('task_started', { task_id: task, tool_use_id: id, description: 'wait in the background', is_backgrounded: true, task_type: 'local_bash' });
      user([{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}.` }]);
      assistant([{ type: 'text', text: 'It waits in the background.' }]);
      running.set(task, () => {
        sys('task_updated', { task_id: task, patch: { status: 'killed', end_time: Date.now() } });
        sys('task_notification', { task_id: task, tool_use_id: id, status: 'stopped', summary: 'wait in the background' });
        sys('background_tasks_changed', { tasks: [] });
      });
      return result(true) || true;
    }
    if ((m = /^workflow (\d+)/.exec(text))) {
      const id = tool('Workflow', { script: "export const meta = { name: 'checks', phases: [{ title: 'Look' }, { title: 'Fix' }] }" });
      const task = taskId('w');
      const agents = (state) => [
        { type: 'workflow_phase', index: 1, title: 'Look' }, { type: 'workflow_phase', index: 2, title: 'Fix' },
        { type: 'workflow_agent', index: 1, label: 'tests', phaseIndex: 1, phaseTitle: 'Look', agentId: 'wa1', model: 'claude-sonnet-5-5', state: 'done', tokens: 300, toolCalls: 2, durationMs: 20, resultPreview: 'green' },
        { type: 'workflow_agent', index: 2, label: 'lint', phaseIndex: 1, phaseTitle: 'Look', agentId: 'wa2', model: 'claude-haiku-5-5', state, tokens: 100, toolCalls: 1 },
        { type: 'workflow_agent', index: 3, label: 'fix', phaseIndex: 2, phaseTitle: 'Fix', model: 'claude-opus-5-5', state: state === 'done' ? 'done' : 'queued' },
      ];
      sys('background_tasks_changed', { tasks: [{ task_id: task, task_type: 'local_workflow', description: 'checks' }] });
      sys('task_started', { task_id: task, tool_use_id: id, description: 'checks', task_type: 'local_workflow', workflow_name: 'checks' });
      sys('task_progress', { task_id: task, tool_use_id: id, description: 'Look: lint', usage: { total_tokens: 400, tool_uses: 3, duration_ms: 30 }, workflow_progress: agents('start') });
      user([{ type: 'tool_result', tool_use_id: id, content: `Workflow launched in background. Task ID: ${task}` }]);
      assistant([{ type: 'text', text: 'The workflow runs.' }]);
      result(true);
      later(Number(m[1]), () => {
        sys('task_progress', { task_id: task, tool_use_id: id, description: 'Fix: fix', usage: { total_tokens: 900, tool_uses: 6, duration_ms: 80 }, workflow_progress: agents('done') });
        sys('task_updated', { task_id: task, patch: { status: 'completed', end_time: Date.now() } });
        sys('task_notification', { task_id: task, tool_use_id: id, status: 'completed', summary: 'checks done' });
        sys('background_tasks_changed', { tasks: [] });
        ownTurn(async () => {
          assistant([{ type: 'text', text: 'The workflow is done.' }]);
          result(true);
        });
      });
      return true;
    }
    if (text === 'limits') {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1900000000, rateLimitType: 'five_hour', utilization: 0.81 }, session_id: sessionId });
      assistant([{ type: 'text', text: 'Mind the limit.' }]);
      return result(true) || true;
    }
    if (text === 'compact') {
      sys('status', { status: 'compacting' });
      sys('compact_boundary', { compact_metadata: { trigger: 'manual', pre_tokens: 5000, post_tokens: 900 } });
      sys('status', { status: null });
      return result(true) || true;
    }
    if ((m = /^title (.+)/.exec(text))) {
      sys('session_title_changed', { title: m[1] });
      assistant([{ type: 'text', text: 'Named.' }]);
      return result(true) || true;
    }
    if ((m = /^slow (\d+)/.exec(text))) {
      await new Promise((r) => setTimeout(r, Number(m[1])));
      assistant([{ type: 'text', text: `slow: done after ${m[1]} ms` }]);
      return result(true) || true;
    }
    if ((m = /^waitfor (.+)/.exec(text))) {
      const file = m[1].trim();
      const until = Date.now() + 60_000;
      while (!fs.existsSync(file) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      assistant([{ type: 'text', text: `waitfor: done (${fs.existsSync(file) ? 'the file is there' : 'after 60 s'})` }]);
      return result(true) || true;
    }
    if (text === 'clear') {
      out({ type: 'conversation_reset', new_conversation_id: crypto.randomUUID(), trigger: 'clear', session_id: sessionId });
      return result(true) || true;
    }
    if ((m = /^commit (\S+)/.exec(text))) {
      // Work's "Do it": a commit in the folder's repository, a file left changed and not committed, and a report that
      // names the folder by its full path and carries a key (the run masks both).
      const file = m[1];
      fs.writeFileSync(file, 'made by the stand-in\n');
      execFileSync('git', ['add', '--', file], { stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', `Add ${file}`, '--', file], { stdio: 'ignore' });
      fs.writeFileSync(`${file}.draft`, 'not committed\n');
      assistant([{ type: 'text', text: `Report: added ${file} in ${process.cwd()}, checked it with the key ${'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz'}, left ${file}.draft.` }]);
      return result(true) || true;
    }
    if (/^hitlimit\b/.test(text)) {
      // As "big" (fake-claude.mjs), for a message with more lines than the one word: a long reply, then a usage-limit
      // result, then it exits at once.
      assistant([{ type: 'text', text: `${'y'.repeat(5000)}` }]);
      const last = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit · resets 5pm", session_id: sessionId, total_cost_usd: 0.01, num_turns: 1 }) + '\n';
      process.stdout.write(last, () => process.exit(1));
      return new Promise(() => {});
    }
    if ((m = /^fail (.+)/.exec(text))) {
      assistant([{ type: 'text', text: 'Something went wrong.' }]);
      out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: m[1], session_id: sessionId, total_cost_usd: 0.01, num_turns: 1 });
      return true;
    }
    return null;
  }

  return {
    more,
    stopTask(id) {
      const end = running.get(id);
      if (!end) return false;
      running.delete(id);
      end();
      return true;
    },
  };
}
