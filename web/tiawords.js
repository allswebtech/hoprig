// How Tia's work is named on her page: what she did, does and has done, in plain words (the chips under her answer,
// the Activity list, a card's question), and a job's session as a chip that opens it. manage_computer has words per
// action (an update or a coding tool switched reads as that, not as "change a computer").
import { icon } from './icons.js';
import { h, link } from './lib.js';

// What she did, in plain words (the chips under her answer and the Activity list).
export const TOOL_WORDS = {
  list_sessions: 'looked at the sessions', read_session: 'read a session', list_projects: 'looked at the projects', list_conversations: 'looked at earlier conversations',
  get_accounts: 'looked at the providers', get_computer_status: 'looked at the computers', get_settings: 'read the settings', read_attention: 'looked at what needs you', find_skill: 'looked up how to do it',
  start_session: 'start a session', send_to_session: 'type into a session', press_key: 'press a key in a session', rename_session: 'rename a session',
  start_chat: 'start a session in the App', send_to_chat: 'act in a session in the App',
  watch_session: 'watch a session', finish_job: 'finish the job', notify_owner: 'notify you', open_screen: 'open a screen',
  stop_session: 'stop a session', switch_account: 'move a session to another provider', set_auto_mode: 'change Auto mode',
  kill_process: 'end a process', change_setting: 'change a setting', run_command: 'run a command',
  manage_computer: 'change a computer', draft_skill: 'add a skill', read_brain: 'read the AI brain',
  manage_project: 'work on a project', manage_automation: 'change the automations', manage_skills: 'look after the skills', manage_procedures: 'look up how to do it',
  manage_work: 'look after your tasks',
};
// What she is doing right now (the line while she works).
export const DOING = {
  list_sessions: 'looking at the sessions', read_session: 'reading a session', list_projects: 'looking at your projects', list_conversations: 'looking at earlier conversations',
  get_accounts: 'checking the providers', get_computer_status: 'checking the computers', get_settings: 'reading the settings', read_attention: 'looking at what needs you', find_skill: 'looking up how to do it',
  start_session: 'starting a session', send_to_session: 'typing into a session', press_key: 'pressing a key in a session', rename_session: 'renaming a session',
  start_chat: 'starting a session in the App', send_to_chat: 'writing to a session in the App',
  watch_session: 'watching a session', finish_job: 'finishing the job', notify_owner: 'writing to you', open_screen: 'opening a screen',
  stop_session: 'stopping a session', switch_account: 'moving a session to another provider', set_auto_mode: 'changing Auto mode',
  kill_process: 'ending a process', change_setting: 'changing a setting', run_command: 'running a command',
  manage_computer: 'changing a computer', draft_skill: 'writing a skill', read_brain: 'reading the AI brain',
  manage_project: 'working on a project', manage_automation: 'changing the automations', manage_skills: 'looking after the skills', manage_procedures: 'looking up how to do it',
  manage_work: 'looking at your tasks',
};
// The chip once a call has an answer.
export const DID = {
  ...Object.fromEntries(Object.entries(TOOL_WORDS).filter(([, v]) => v.startsWith('looked') || v.startsWith('read'))),
  start_session: 'started a session', send_to_session: 'typed into a session', press_key: 'pressed a key', rename_session: 'renamed a session',
  start_chat: 'started a session in the App', send_to_chat: 'wrote to a session in the App',
  watch_session: 'watches a session', finish_job: 'finished the job', notify_owner: 'notified you', open_screen: 'opened a screen',
  stop_session: 'stopped a session', switch_account: 'moved a session', set_auto_mode: 'changed Auto mode',
  kill_process: 'ended a process', change_setting: 'changed a setting', run_command: 'ran a command', manage_computer: 'changed a computer', draft_skill: 'added a skill',
  manage_project: 'worked on a project', manage_automation: 'changed the automations', manage_skills: 'looked after the skills', manage_procedures: 'looked up how to do it',
  manage_work: 'looked after your tasks',
};

/**
 * A session of a job as a chip that opens it: a chat ("chat:<id>") on its chat page by its id, a terminal on its
 * session page by its name; another computer's through its own address. A chat reads by its folder (kept with the job:
 * the job's log names it so too) and its title (`title`, from the page's list), never by its id. A long title is cut
 * with "…" inside the chip (page-automations.css .tia-jobchip); the whole label is its tooltip.
 */
const chatOf = (s) => (/^chat:([0-9a-f-]{36})$/.exec(s.session) || [])[1] || null;
export const jobLabel = (s, title = null) => (!chatOf(s) ? s.session
  : [s.folder ? `App session in ${s.folder}` : title ? 'App session' : 'A session in the App', title].filter(Boolean).join(': '));
export function jobChip(s, title = null) {
  const chat = chatOf(s);
  const m = s.computer && s.computer !== 'this' ? s.computer : null;
  const href = chat ? link(`#/chat/${chat}`, m) : link(`#/s/${encodeURIComponent(s.session)}`, m);
  const label = jobLabel(s, title);
  return h('a.chip.tia-jobchip', { href, title: label }, icon(chat ? 'text' : 'terminal', { size: 14 }), h('span', label));
}

// manage_computer, per action: [what she would do, what she is doing, what she did].
const COMPUTER = {
  check_updates: ['check for updates', 'checking for updates', 'checked for updates'],
  update: ['update or install on a computer', 'updating', 'updated'],
  coding_tool: ['turn a coding tool on or off', 'turning a coding tool on or off', 'turned a coding tool on or off'],
};
/** The words of `tool` (with its `action`, for manage_computer) from one of the maps above. */
export function wordFor(map, tool, action) {
  // A question with answers to tap is asked in the chat: no push went out.
  if (tool === 'notify_owner' && action === 'ask') return map === DOING ? 'asking you' : map === DID ? 'asked you' : 'ask you';
  const per = tool === 'manage_computer' && COMPUTER[action];
  if (per) return per[map === DOING ? 1 : map === DID ? 2 : 0];
  return map[tool];
}

/** What she is doing, for the line while she works: plain words, and for a tool this page has no words for, never its
 * inside name. */
export const doingLine = (tool, action) => wordFor(DOING, tool, action) || 'working on it';
