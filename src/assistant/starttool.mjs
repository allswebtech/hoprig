// start_work: start a coding chat or a terminal session. One tool for the two starts she had (start_chat, start_session): it
// sends the call to the one that does it, so every check, level, card, provider pick and hold stays exactly that tool's
// (core.mjs runs it as a part of the call; the old names still answer, see tools.mjs OLD_TOOLS).
import { codingTool, computer, conversation, folder, job, account, tool, toolError } from './toolkit.mjs';
import { EFFORTS } from '../config.mjs';
import { bool, obj, ref, str } from './schema.mjs';
import { MODEL_NAME } from './startoptions.mjs';
const CHAT_ID = /^chat:[0-9a-f-]{36}$/;

export const start_work = tool({
  name: 'start_work',
  level: 'L1',
  card: 'maybe',
  description: 'Start coding work: kind chat (the default: he follows it on Home) or terminal (only when he asks for one), in a folder, with his words as message and goal. Leave provider out and the dashboard picks an allowed one and says why. The result names the session; a start may stage a card he taps.',
  input: obj({
    kind: str({ enum: ['chat', 'terminal'], desc: 'Default chat.' }),
    folder,
    computer,
    provider: account,
    tool: codingTool,
    message: str({ max: 8000, desc: 'The first message: the task, in his words.' }),
    goal: str({ max: 500, desc: 'What done means; makes it a job she is woken for.' }),
    job,
    conversation,
    mode: str({ enum: ['new', 'continue', 'resume'], desc: 'Terminal only. Default new.' }),
    model: str({ max: 120, pattern: MODEL_NAME, desc: 'Chat only: a model, when he named one; else his defaults.' }),
    effort: str({ enum: EFFORTS, desc: 'Chat only: an effort, when he named one; else his defaults.' }),
    worktree: bool({ desc: 'Chat only: true works in a worktree of its own.' }),
    watch: str({ enum: ['none', 'needs-me', 'ends', 'fails'], desc: 'Chat only: tell him (a push) when it needs him, ends or fails.' }),
    fork_of: ref('session', str({ max: 41, pattern: CHAT_ID, desc: 'Chat only: a chat to fork.' })),
  }, { required: ['folder'] }),
  check(a) {
    if ((a.kind || 'chat') === 'chat' && a.mode !== undefined) throw toolError('mode goes only with kind terminal', 'leave mode out for a chat');
    if (a.kind === 'terminal') for (const k of ['model', 'effort', 'worktree', 'watch']) if (a[k] !== undefined) throw toolError(`${k} goes only with a chat`, `leave ${k} out for a terminal, or start a chat`);
    if (a.kind === 'terminal' && a.fork_of !== undefined) throw toolError('fork_of goes only with a chat', 'leave fork_of out for a terminal');
  },
  forwards(a) {
    const { kind, provider, tool: coding, mode, fork_of: fork, watch, ...rest } = a;
    const common = { ...rest, ...(provider ? { account: provider } : {}), ...(coding ? { coding_tool: coding } : {}) };
    if (kind === 'terminal') return [{ tool: 'start_session', args: { ...common, ...(mode ? { mode } : {}) } }];
    return [{ tool: 'start_chat', args: { ...common, ...(watch && watch !== 'none' ? { watch } : {}), ...(fork ? { fork_of: fork } : {}) } }];
  },
});
