// steer_work: act on a running chat, terminal session or job: send, key, answer, rename, continue, to_chat, to_terminal, close,
// stop, switch_provider, end_job. One tool for the six she had (send_to_session, send_to_chat, stop_session, switch_account,
// finish_job); the call goes to the one that does it, so its level, its card and its rules stay that tool's. Always allow an
// OK ("allow always") is her own rights and is not an answer here.
import { obj, str } from './schema.mjs';
import { KEYS, account, computer, job, session, tool, toolError } from './toolkit.mjs';

const ACTIONS = ['send', 'key', 'answer', 'rename', 'continue', 'to_chat', 'to_terminal', 'close', 'stop', 'switch_provider', 'end_job'];
const isChat = (s) => typeof s === 'string' && s.startsWith('chat:');
const need = (a, ...keys) => {
  for (const k of keys) if (a[k] === undefined) throw toolError(`steer_work ${a.action} needs ${k}`, `add ${k} and call steer_work again`);
};

export const steer_work = tool({
  name: 'steer_work',
  level: 'L1',
  card: 'maybe',
  description: 'Act on running work. send: text into a chat or terminal. key: one key into a terminal. answer: yes or no to the OK a chat waits for. rename, continue (after a usage limit), to_chat, to_terminal, close (a chat), stop, switch_provider (provider), end_job (job, outcome, report). Some stage a card he taps.',
  input: obj({
    action: str({ enum: ACTIONS }),
    target: session,
    job,
    text: str({ max: 8000, desc: 'For send.' }),
    key: str({ enum: KEYS, desc: 'For key.' }),
    answer: str({ enum: ['yes', 'no'], desc: 'For answer.' }),
    name: str({ max: 200, oneLine: true, desc: 'For rename.' }),
    provider: account,
    outcome: str({ enum: ['done', 'stuck'], desc: 'For end_job.' }),
    report: str({ max: 1000, desc: 'For end_job: two or three plain lines.' }),
    computer,
  }, { required: ['action'] }),
  check(a) {
    if (a.action === 'end_job') need(a, 'job', 'outcome', 'report');
    else need(a, 'target');
    const typed = { send: 'text', key: 'key', answer: 'answer', rename: 'name', switch_provider: 'provider' }[a.action];
    if (typed) need(a, typed);
    if (a.action === 'key' && isChat(a.target)) throw toolError('a chat has no keys', 'use send or answer for a chat');
    if (['continue', 'to_chat'].includes(a.action) && isChat(a.target)) throw toolError(`${a.action} is for a terminal session`, 'a chat: send, answer, close, stop');
    if (['to_terminal', 'close'].includes(a.action) && !isChat(a.target)) throw toolError(`${a.action} is for a chat (chat:<id>)`, 'a terminal: send, key, stop');
    if (a.action === 'answer' && !isChat(a.target)) throw toolError('answer is for a chat; a terminal menu is answered with key', 'call steer_work key');
  },
  forwards(a) {
    const where = a.computer ? { computer: a.computer } : {};
    const s = { session: a.target, ...where };
    const chat = isChat(a.target);
    switch (a.action) {
      case 'send': return [{ tool: chat ? 'send_to_chat' : 'send_to_session', args: { ...s, text: a.text } }];
      case 'key': return [{ tool: 'send_to_session', args: { ...s, key: a.key } }];
      case 'answer': return [{ tool: 'send_to_chat', args: { ...s, answer: a.answer === 'yes' ? 'allow' : 'deny' } }];
      case 'rename': return [{ tool: chat ? 'send_to_chat' : 'send_to_session', args: { ...s, name: a.name } }];
      case 'continue': return [{ tool: 'send_to_session', args: { ...s, continue: true } }];
      case 'to_chat': return [{ tool: 'send_to_session', args: { ...s, to_chat: true } }];
      case 'to_terminal': return [{ tool: 'send_to_chat', args: { ...s, terminal: true } }];
      case 'close': return [{ tool: 'send_to_chat', args: { ...s, close: true } }];
      case 'stop': return [{ tool: chat ? 'send_to_chat' : 'stop_session', args: chat ? { ...s, stop: true } : s }];
      case 'switch_provider': return [{ tool: 'switch_account', args: { ...s, account: a.provider } }];
      default: return [{ tool: 'finish_job', args: { job: a.job, state: a.outcome, report: a.report } }];
    }
  },
});
