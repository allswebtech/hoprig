// Tia's Activity in plain words: one sentence for each entry of her audit log (src/assistant/audit.mjs), the way
// the Jobs tab reads. What she did or proposed, and what the owner did there, by the tool and its action: a provider
// by the name the owner gave it, a coding tool by its name, a chat by its title or its folder, a folder by its last
// part, a computer by its name. No key of a tool's input and no "null" reaches the page: a value is said in words or
// left out. A new tool or action reads "made a change" until it has words here (a test checks every one there is).
import { APP_NAME } from './brand.js';
import { TOOL_NAMES } from './lib.js';

/** A folder's last part ("/home/x/projects/shop" → "shop"). */
export const folderName = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
const TIA = 'Tia';
const codingTool = (id) => TOOL_NAMES[id] || 'another coding tool';
const said = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v, word) => (Array.isArray(v) ? v.map(word).join(', ') : '');
const human = (id) => String(id || '').replace(/[_-]+/g, ' ');

/**
 * Starting a coding tool, in the owner's words (also a confirm card's question): "start a chat in shop", "start a
 * chat with OpenCode in blog", "start Claude Code in a terminal in shop". A chat names its coding tool when it is not
 * Claude Code or when `named` (more than one coding tool is on); a terminal always does. `continues` ('newest' |
 * 'earlier'): a start on an existing conversation, said as such ("continue an earlier Claude Code conversation in a
 * terminal in shop"), since its history and its cost go on from there.
 */
export function startWords({ kind, tool, folder, named = false, continues = null }) {
  const t = tool || 'claude';
  const where = folderName(folder);
  const at = where ? ` in ${where}` : '';
  const withTool = kind !== 'chat' || named || t !== 'claude';
  if (continues) {
    return `continue ${continues === 'newest' ? 'the newest' : 'an earlier'} ${withTool ? `${codingTool(t)} ` : ''}conversation in ${kind === 'chat' ? 'the App' : 'the Terminal'}${at}`;
  }
  const what = kind === 'chat' ? (withTool ? `a session in the App with ${codingTool(t)}` : 'a session in the App') : `${codingTool(t)} in the Terminal`;
  return `start ${what}${at}`;
}
/** Which conversation a start_session or start_chat input goes on with: 'earlier' (a named one), 'newest' (the
 * folder's newest), or null (a new one). */
export const continuesOf = (a) => (a.conversation || a.mode === 'resume' ? 'earlier' : a.mode === 'continue' ? 'newest' : null);

/**
 * A session as the owner reads it: one in the App by its title, else its folder ("the App session \"Fix it\"", "the App session in shop";
 * never its id), a terminal by its name. `sessions`: the page's list of that computer's sessions.
 */
export function sessionWords(name, sessions = []) {
  if (!/^chat:/.test(String(name || ''))) return name ? `the session ${name}` : 'a session';
  const s = sessions.find((x) => x.name === name);
  const where = s && folderName(s.cwd);
  return s && said(s.title) ? `the App session "${s.title.trim()}"` : where ? `the App session in ${where}` : 'a session in the App';
}

// Tia's settings, by the labels of Settings → Tia.
const LEVEL = { ask: 'Ask me', work: 'Do the work', handsoff: 'Hands off' };
function tiaSettingsWords(a, p) {
  const parts = [];
  for (const [k, v] of Object.entries(a)) {
    if (k === 'enabled') parts.push(v ? 'turned her on' : 'turned her off');
    else if (k === 'level') parts.push(`how far she may go: ${LEVEL[v] || 'another level'}`);
    else if (k === 'accounts') parts.push(Array.isArray(v) ? (v.length ? `providers she may use: ${list(v, p.provider)}` : 'no provider she may use') : 'providers she may use: the default');
    else if (k === 'runsOn') parts.push(`she runs on: ${v ? p.provider(v) : 'Automatic'}`);
    else if (k === 'model') parts.push(`her model: ${said(v) || 'the provider\'s default'}`);
    else if (k === 'maxSteps' && Number.isFinite(v)) parts.push(`${v} answers per job`);
    else if (k === 'maxMinutes' && Number.isFinite(v)) parts.push(`${v} minutes per job`);
  }
  return { what: `change ${TIA}'s settings`, detail: parts.join(' · ') };
}

const SETTING = {
  quick_actions: 'Quick actions', folder_roots: 'Folders the dashboard may open', public_url: 'Public address', upload_max_mb: 'Largest upload',
  uploads_dir: 'Uploads folder', auto_continue_prompt: 'Auto mode\'s message to carry on', auto_cooldown_minutes: 'Auto mode\'s wait after a limit',
  new_session_model: 'Model of new sessions', new_session_effort: 'Effort of new sessions', projects_folder: 'Projects folder',
  claude_working_rules: 'Working rules for Claude Code', skills_weekly_check: 'Weekly check of the skills',
};
// A number's unit, where the setting has one.
const UNIT = { upload_max_mb: 'MB', auto_cooldown_minutes: 'minutes' };
const valueWords = (v, unit) => (v === null ? 'the default' : v === true ? 'on' : v === false ? 'off' : Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}`
  : typeof v === 'object' ? 'a new value' : typeof v === 'number' && unit ? `${v} ${unit}` : String(v));
// The kits of Set up this computer by their titles (src/pcsetup/kits.mjs; a test keeps the two the same).
export const KIT_TITLES = { basics: 'Basics', node: 'Node.js', python: 'Python', github: 'GitHub', extras: 'Terminal extras', docker: 'Docker' };
const kitWords = (id) => KIT_TITLES[id] || human(id);
const ITEM = (id) => (id === 'all' ? 'everything that has an update' : id === 'hoprig' ? APP_NAME : id === 'cloudflared' ? 'the tunnel helper' : TOOL_NAMES[id] || 'an item of Updates');
const RULE = {
  queue: 'the queue', schedules: 'schedules', restore: 'reopen after a restart', retry: 'try again', close_idle_shells: 'close idle terminals',
  stop_idle_gateway: 'stop an idle gateway', claude_update_notice: 'tell me about a Claude Code update', workspace_map_upkeep: 'keep the workspace map',
  workspace_commit_map: 'save a change of the map', workspace_sync_upkeep: 'keep the workspace in step', workspace_push: 'upload the workspace\'s commits',
};

/** manage_computer, manage_project, manage_automation, manage_skills, manage_procedures: per action. */
const ACTIONS = {
  manage_computer: {
    add: (a) => `add the computer ${a.ssh_target || ''}`.trim(),
    rename: (a) => `rename a computer${said(a.label) ? ` to "${a.label}"` : ''}`,
    check_updates: () => 'check for updates',
    update: (a) => `update ${ITEM(a.item)}`,
    coding_tool: (a) => `turn ${codingTool(a.coding_tool)} ${a.turn === 'off' ? 'off' : 'on'}`,
    setup_fix: () => 'fix a setup check',
    set_up: (a) => `set up ${Array.isArray(a.kits) ? a.kits.map(kitWords).join(', ') : 'a part of the computer'}`,
    end_process: (a) => `end process ${Number.isInteger(a.pid) ? a.pid : ''}${a.force ? ' at once' : ''}`.trim(),
    addon: (a) => `${a.addon_action || 'change'} the add-on ${human(a.addon)}`,
    public_link: (a) => `turn the public link ${a.turn === 'off' ? 'off' : 'on'}${a.link_kind ? ` (${a.link_kind})` : ''}`,
    reboot: () => 'restart the computer',
    power_off: () => 'turn the computer off',
  },
  manage_project: {
    new: (a) => `make the project ${a.name || ''}`.trim(),
    get: (a) => `get the project ${a.spec || ''}`.trim(),
    sync: (a) => `bring ${a.project || 'a project'} up to date`,
    add_repository: (a) => `add the repository ${a.repo || ''} to ${a.project || 'a project'}`,
    install: (a) => `install what ${a.project || 'a project'} needs`,
    create_folders: () => 'make the missing workspace folders',
    workspace_map: () => 'write the workspace map',
    workspace_sync: (a) => `bring the workspace up to date${a.push ? ' and upload its commits' : ''}`,
    workspace_sync_from: (a, p) => `get the workspace's commits from ${p.computer(a.from_computer) || 'another computer'}`,
    workspace_restore: () => 'bring the workspace to this computer',
    workspace_places: () => 'move the workspace or the projects folder',
    workspace_forget: (a) => `take ${a.mapped || 'an entry'} out of the workspace map`,
  },
  manage_automation: {
    list: () => 'look at the automations',
    add_schedule: (a) => `add a schedule${said(a.label) ? ` "${a.label}"` : ''}${a.time ? ` at ${a.time}` : ''}`,
    change_schedule: (a) => `change a schedule${a.time ? ` to ${a.time}` : ''}`,
    delete_schedule: () => 'delete a schedule',
    set_rule: (a) => `turn "${RULE[a.rule] || 'a rule'}" ${a.on ? 'on' : 'off'}`,
    set_upkeep_hours: (a) => (Number.isInteger(a.hours) ? `keep the workspace in step every ${a.hours} hour${a.hours === 1 ? '' : 's'}` : 'change how often the workspace is kept in step'),
    pause: () => 'pause the automations',
    resume: () => 'resume the automations',
    queue_message: (a, p) => `queue a message for ${p.chat(a.session)}`,
    queue_clear: (a, p) => `clear the queue of ${p.chat(a.session)}`,
  },
  manage_skills: {
    installed: () => 'look at the installed skills', suggested: () => 'look at the suggested skills', find: () => 'look for a skill',
    check_updates: () => 'check the skills for updates', review: (a) => `review the skill ${a.spec || ''}`.trim(),
    update_review: (a) => `review an update of the skill ${a.skill || ''}`.trim(), install: () => 'install the skill she reviewed', remove: (a) => `remove the skill ${a.skill || ''}`.trim(),
  },
  manage_procedures: { find: () => 'look up how to do it', draft: (a) => `write down how to do "${a.name || 'it'}"` },
};

const ANSWER = { allow: 'allow what', allow_always: 'allow, and not ask again in this session, what', deny: 'say no to what' };

/** The other tools: the words, the detail line, the quoted text. */
const TOOLS = {
  start_session: (a, p) => ({ what: startWords({ kind: 'terminal', tool: a.coding_tool, folder: a.folder, continues: continuesOf(a) }), goal: a.goal, quote: a.message }),
  start_chat: (a, p) => ({ what: startWords({ kind: 'chat', tool: a.coding_tool, folder: a.folder, named: p.tools > 1, continues: continuesOf(a) }), goal: a.goal, quote: a.message }),
  send_to_session: (a, p) => (a.key !== undefined ? { what: `press ${a.key} in ${p.chat(a.session)}` } : { what: `type into ${p.chat(a.session)}`, quote: a.text }),
  send_to_chat: (a, p) => (a.stop ? { what: `stop the reply in ${p.chat(a.session)}` }
    : a.answer ? { what: `${ANSWER[a.answer] || 'answer what'} ${p.chat(a.session)} asks` } : { what: `write to ${p.chat(a.session)}`, quote: a.text }),
  rename_session: (a, p) => ({ what: `rename ${p.chat(a.session)}${said(a.name) ? ` to ${a.name}` : ''}` }),
  watch_session: (a, p) => ({ what: `watch ${p.chat(a.session)}`, goal: a.goal }),
  finish_job: (a) => ({ what: a.state === 'stuck' ? 'finish a job as stuck' : 'finish a job as done', quote: a.report }),
  notify_owner: (a) => ({ what: 'notify you', quote: a.message }),
  open_screen: (a) => ({ what: `open ${a.screen === 'new' ? 'New session' : a.screen ? String(a.screen).split('/').map((x) => human(x).replace(/^./, (c) => c.toUpperCase())).join(' → ') : 'a screen'}` }),
  stop_session: (a, p) => ({ what: `stop ${p.chat(a.session)}` }),
  switch_account: (a, p) => ({ what: `move ${p.chat(a.session)} to ${p.provider(a.account)}` }),
  set_auto_mode: (a, p) => ({
    what: a.enabled === false ? 'turn Auto mode off' : a.enabled === true ? 'turn Auto mode on' : 'change Auto mode',
    detail: [Array.isArray(a.order) ? `order: ${list(a.order, p.provider)}` : '', a.return_to_preferred === true ? 'back to the first provider once it is free' : a.return_to_preferred === false ? 'stays where it moved' : ''].filter(Boolean).join(' · '),
  }),
  change_setting: (a) => ({ what: `change the setting "${SETTING[a.key] || 'another setting'}" to ${valueWords(a.value, UNIT[a.key])}` }),
  run_command: (a) => ({ what: `run a command${folderName(a.folder) ? ` in ${folderName(a.folder)}` : ''}`, quote: a.command }),
  // Tools of an earlier version, in entries written then.
  draft_skill: (a) => ({ what: said(a.name) ? `add the skill "${a.name}"` : 'add a skill' }),
  kill_process: (a) => ({ what: `end process ${Number.isInteger(a.pid) ? a.pid : ''}`.trim() }),
  press_key: (a, p) => ({ what: `press ${a.key || 'a key'} in ${p.chat(a.session)}` }),
  tia_settings: tiaSettingsWords,
  client_token: () => ({ what: 'make a token for your own Claude Code' }),
  stop_job: () => ({ what: 'stop a job' }),
};

/**
 * One Activity entry in words: { what, detail, quote }. `what` says what was done (without who: the page puts "You"
 * or her name before it), `detail` the rest in words or '', `quote` her own text (a first message, a command) or ''.
 * `p`: { provider(name) → its label, computer(name) → its name or null (this computer), chat(session) → "the chat
 * "Fix it"" | "the chat in shop" | "the session web", tools: how many coding tools are on there }.
 */
export function activityWords(e, p) {
  const a = (e && e.input && typeof e.input === 'object') ? e.input : {};
  const per = ACTIONS[e.tool];
  const r = per ? { what: (per[a.action] || (() => 'make a change'))(a, p) } : (TOOLS[e.tool] || (() => ({ what: 'make a change' })))(a, p);
  const place = a.computer && a.computer !== 'this' ? p.computer(a.computer) : null;
  const account = (e.tool === 'start_session' || e.tool === 'start_chat') && a.account ? ` on ${p.provider(a.account)}` : '';
  const goal = said(r.goal) ? `done when: ${r.goal.trim()}` : '';
  return {
    what: `${r.what}${account}${place ? `, on the computer ${place}` : ''}`,
    detail: [r.detail || '', goal].filter(Boolean).join(' · '),
    quote: said(r.quote) || '',
  };
}

// What came of an entry. A proposal says "Asked for your OK", which stays true once he answered (his answer is a step
// of the same row, activityRows).
export const OUTCOME = { done: 'Done', staged: 'Asked for your OK', confirmed: 'You confirmed', declined: 'You declined', refused: 'Refused', failed: 'Failed', stale: 'Not run (things changed)', expired: 'Expired' };

/**
 * The Activity list as rows: the entries of one card (her proposal, his confirm or decline, then done or failed) are
 * one row, under her proposal's words, with what came of it as steps ("Asked for your OK · You confirmed · Done");
 * every other entry is a row of its own. `entries`: newest first, as the server gives them; the rows keep that order
 * by each row's newest entry. → [{ e (the first entry: who and what), at (the newest time), steps: [words], error }]
 */
export function activityRows(entries) {
  const rows = [];
  const byCard = new Map();
  for (const e of entries || []) {
    const row = e.card && byCard.get(e.card);
    if (row) {
      row.all.unshift(e); // older than what the row has
      continue;
    }
    const r = { all: [e], at: e.at };
    if (e.card) byCard.set(e.card, r);
    rows.push(r);
  }
  return rows.map(({ all, at }) => {
    const steps = [];
    for (const x of all) {
      const w = OUTCOME[x.outcome] || 'Something else';
      if (steps.at(-1) !== w) steps.push(w);
    }
    const err = all.filter((x) => x.error).at(-1);
    return { e: all[0], at, steps, error: err ? err.error : null };
  });
}

/** A time as the Tia page shows it: the time alone today, else with its day ("Nov 16, 07:14"). */
export function stamp(t, now = Date.now()) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Every tool and action that has its own words here (for the test that keeps them complete). */
export const WORDED = { tools: Object.keys(TOOLS), actions: Object.fromEntries(Object.entries(ACTIONS).map(([t, m]) => [t, Object.keys(m)])) };
