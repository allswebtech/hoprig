// The one door between Tia's tools and the dashboard's routes. ops.mjs runs every action through ctx.dispatch (the
// page's own route, in-process, as the owner); nothing else in the code base may call ctx.dispatch, and every call
// passes here first:
//
//   1. the address is normalised exactly as the server will read it (`new URL(url, 'http://x')`: dot segments
//      resolved; an encoded "/" stays inside its segment) and an "/m/<computer>" prefix is taken off;
//   2. every segment is decoded once, as a route decodes its ids: "public%2Dlink" is "public-link" here too. A segment
//      that does not decode, or that decodes to a "/", "%", "\" or a control character, is refused (no route of hers
//      takes one, and a second decoding somewhere could make it another route);
//   3. a route on NEVER is refused, whatever the table says (the owner's own steps, L3);
//   4. only a method + route in ALLOW passes, and for the two settings routes only the keys her tools change.
// The lists are matched against the decoded path.
//
// What passes and what is refused by name is DERIVED from the acts file (acts.json, one row for every act with its facts;
// acts.mjs): a route passes only when its row names a tool of hers and its facts do not make it an open answer; the owner's
// own routes (the six never classes) are the rows whose facts say so. Nothing here says that a route is hers or his: WIRES
// below holds only HOW a route that has a row with a tool is checked (its address as the page writes it, its words, the
// check of its body, the card it needs), and a test (test/assistant/acts-door.test.mjs) holds the door to the rows and to
// the door as it was before it was derived. The other computer decides for itself too: a relayed request arrives there
// with the hub's machine token and passes that computer's own gate (src/machines/index.mjs TOKEN_FORBIDDEN).

import { NAME_RE } from '../profiles.mjs';
import { SECRET_START_MSG, isSecretFolder } from '../server/folders.mjs';
import { NEVER_CLASSES, loadActs, rowAnswer, sourcePattern } from './acts.mjs';
import { cardComputer, confirmedCard } from './confirmed.mjs';

const SEG = '[^/]+';
const CHAT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** How one route of her door is checked: its row in the acts file (`source`), the address as the page writes it, its words. */
const r = (source, path, tool, body = null, card = null, cardTools = ['manage_computer']) => ({ source, method: source.split(' ')[0], re: new RegExp(`^${path}$`), path, tool, body, card, cardTools });

/** Keys of POST /api/settings her tools may send (hoprig_act change-setting, auto-mode, auto-order). */
const SETTINGS_KEYS = {
  server: ['quickActions', 'roots', 'publicUrl', 'uploadMaxMB', 'uploadsDir'],
  autoSwitch: ['enabled', 'order', 'returnToPreferred', 'prompt', 'cooldownMinutes'],
  // permissionMode, lead and others only unchanged (see settingsBody): change_setting sends the whole set it read.
  sessionDefaults: ['model', 'effort', 'permissionMode', 'lead', 'others'],
};
const AUTOMATION_SECTIONS = { paused: true, queue: ['enabled'], schedules: ['enabled'], restore: ['enabled'], retry: ['enabled'], idle: ['shells', 'gateway'], updates: ['claude'], workspace: ['map', 'commitMap', 'sync', 'push', 'everyHours'] };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Session defaults of the owner's that she may only carry along unchanged (change_setting sends the whole set it read).
const OWNERS_DEFAULTS = ['permissionMode', 'lead', 'others'];
const carries = (b) => isObj(b) && isObj(b.sessionDefaults) && OWNERS_DEFAULTS.some((k) => k in b.sessionDefaults);

/**
 * POST /api/settings: only her keys; the permission mode, Lead and its ticks of new sessions may be carried along, never
 * changed. They are compared with the settings of the computer the request goes to: this one's config, or for
 * "/m/<computer>" what that computer answered just now (ctx.settingsOf, filled by gatedDispatch). Unknown: refused.
 */
function settingsBody(b, ctx, computer) {
  if (!isObj(b)) return 'the body must be an object';
  for (const [top, v] of Object.entries(b)) {
    const allowed = SETTINGS_KEYS[top];
    if (!allowed) return `"${top}" is the owner's setting`;
    if (!isObj(v)) return `"${top}" must be an object`;
    for (const k of Object.keys(v)) if (!allowed.includes(k)) return `"${top}.${k}" is the owner's setting`;
  }
  if (!carries(b)) return null;
  const there = computer ? (ctx.settingsOf ? ctx.settingsOf(computer) : null) : ctx.config();
  if (!there) return `the settings of ${computer} could not be read to check that the owner's session defaults stay as they are`;
  const cur = there.sessionDefaults || {};
  if ('permissionMode' in b.sessionDefaults && b.sessionDefaults.permissionMode !== cur.permissionMode) return 'the permission mode of new sessions is the owner\'s setting';
  // "Lead model" and its ticks for new sessions are the owner's: carried along as they are, never changed.
  for (const k of ['lead', 'others']) {
    if (!(k in b.sessionDefaults)) continue;
    if (JSON.stringify(b.sessionDefaults[k] ?? null) !== JSON.stringify(cur[k] ?? null)) return `"sessionDefaults.${k}" is the owner's setting`;
  }
  return null;
}

/** POST /api/automation/settings: rules and pause; a Claude Code update rule may only tell, never install. */
function automationBody(b) {
  if (!isObj(b)) return 'the body must be an object';
  for (const [sec, v] of Object.entries(b)) {
    const allowed = AUTOMATION_SECTIONS[sec];
    if (!allowed) return `"${sec}" is not a rule Tia may change`;
    if (allowed === true) continue;
    if (!isObj(v)) return `"${sec}" must be an object`;
    for (const k of Object.keys(v)) if (!allowed.includes(k)) return `"${sec}.${k}" is not a rule she may change`;
  }
  if (b.updates && b.updates.claude === 'auto') return 'installing Claude Code updates by themselves is the owner\'s choice';
  return null;
}

/**
 * POST /api/pcsetup/fix and /setup: only what her tools send. Never a password (the administrator password is the
 * owner's to type on Setup) and never `terminal` (she runs the setup as a job, she opens no terminal for it).
 */
const onlyKeys = (allowed) => (b) => {
  if (!isObj(b)) return 'the body must be an object';
  const k = Object.keys(b).find((x) => !allowed.includes(x));
  return k ? `"${k}" is the owner's to send` : null;
};

/** The skills learned from his work: this computer's own (a relay elsewhere arrives as his press), an empty body. */
const learnedHere = (b, ctx, computer) => (computer ? 'skills learned from the owner\'s work are read and changed on this computer only' : null);
const learnedBody = (b, ctx, computer) => learnedHere(b, ctx, computer) || onlyKeys([])(b);

/** A Work item is named by its place in the list with its id (src/work/feature.mjs). */
const atOk = (b) => (Number.isInteger(b.at) && b.at >= 0 ? null : 'say the place of the item in the list ("at")');

/**
 * A session or a chat in the credentials folder or any other place that holds a sign-in is the owner's own step: refused
 * here for this computer (another computer's own route refuses it again, for her relay and for every caller that is not
 * the owner's page: folders.mjs refuseSecretStart).
 */
const notInSecret = (b, ctx, computer) => (!computer && isObj(b) && isSecretFolder(b.dir) ? SECRET_START_MSG : null);

/** Every route a row of the acts file names a tool for, how it is checked and the tool (or tools) behind it. */
const WIRES = [
  r('GET /api/state', '/api/state', 'list_sessions, get_computer_status (providers)'),
  r('GET /api/operator/attention', '/api/operator/attention', 'read_attention'),
  r('GET /api/operator/rooms', '/api/operator/rooms', 'start_session, start_chat (where there is room)'),
  r('GET /api/machines/sessions', '/api/machines/sessions', 'list_sessions (every computer)'),
  r('GET /api/sessions/<id>/history', `/api/sessions/${SEG}/history`, 'read_session'),
  r('POST /api/sessions', '/api/sessions', 'start_session', notInSecret),
  // Only the text: `owner: true` marks the owner's own typing (types into whatever runs there); hers is typed only for the coding tool.
  r('POST /api/sessions/<id>/send', `/api/sessions/${SEG}/send`, 'send_to_session', onlyKeys(['text'])),
  // Only the key, as for /send: `owner: true` is the page's own buttons; her keys go only to the coding tool in front.
  r('POST /api/sessions/<id>/key', `/api/sessions/${SEG}/key`, 'send_to_session (key)', onlyKeys(['key'])),
  r('POST /api/sessions/<id>/rename', `/api/sessions/${SEG}/rename`, 'send_to_session (name)'),
  r('POST /api/sessions/<id>/kill', `/api/sessions/${SEG}/kill`, 'stop_session'),
  r('POST /api/sessions/<id>/switch', `/api/sessions/${SEG}/switch`, 'switch_account'),
  // A chat (src/chat): only the fields her tools send. The model, effort and permission mode of a chat, its plan
  // approvals and questions, its files and rewinds stay the owner's, in the page. Its provider moves as a terminal's
  // does (switch_account: the same rules, a card unless it is her own chat).
  // A chat she starts takes Settings → New-session defaults (defaults: true), never the folder's last chat of the owner,
  // and is marked hers (byTia: the chat it creates, see src/chat/feature.mjs openChat).
  // "Lead model" and its ticks as Settings → Tia has them (src/assistant/chats.mjs); the part door checks her allowed
  // providers again for every part (src/models/others.mjs partGate).
  r('POST /api/chats', '/api/chats', 'start_chat', (b, ctx, computer) => notInSecret(b, ctx, computer) || onlyKeys(['dir', 'tool', 'profile', 'sessionId', 'text', 'defaults', 'byTia', 'lead', 'others'])(b) || (b.defaults !== true ? 'a chat Tia starts takes Settings\' defaults (defaults: true)' : null)
    || ('lead' in b && typeof b.lead !== 'boolean' ? 'lead is true or false' : null)
    || ('others' in b && !(Array.isArray(b.others) && b.others.length <= 10 && b.others.every((n) => typeof n === 'string' && NAME_RE.test(n))) ? 'others is a list of provider names' : null)),
  // Her message says it is hers (byTia: true): a message from anyone else takes her mark off the chat.
  r('POST /api/chats/<id>/send', `/api/chats/${CHAT_ID}/send`, 'send_to_chat (text)', (b) => onlyKeys(['text', 'byTia'])(b) || (b.byTia !== true ? 'a message Tia sends says it is hers (byTia: true)' : null)),
  r('POST /api/chats/<id>/answer', `/api/chats/${CHAT_ID}/answer`, 'send_to_chat (answer)', onlyKeys(['request', 'allow', 'always'])),
  r('POST /api/chats/<id>/stop', `/api/chats/${CHAT_ID}/stop`, 'send_to_chat (stop)', onlyKeys([])),
  r('POST /api/chats/<id>/provider', `/api/chats/${CHAT_ID}/provider`, 'switch_account (a chat)', (b) => onlyKeys(['profile'])(b) || (typeof b.profile !== 'string' ? 'say which provider' : null)),
  r('POST /api/chats/<id>/title', `/api/chats/${CHAT_ID}/title`, 'send_to_chat (name)', (b) => onlyKeys(['title'])(b) || (typeof b.title !== 'string' ? 'say the name' : null)),
  r('POST /api/chats/<id>/close', `/api/chats/${CHAT_ID}/close`, 'send_to_chat (close)', onlyKeys([])),
  // A fork of a chat (start_chat fork_of), by her card only: the copy takes that chat's own settings, nothing to send.
  r('POST /api/chats/<id>/fork', `/api/chats/${CHAT_ID}/fork`, 'start_chat (fork_of)', onlyKeys([])),
  r('POST /api/chats/<id>/terminal', `/api/chats/${CHAT_ID}/terminal`, 'send_to_chat (terminal)', onlyKeys([])),
  r('POST /api/chats/from-session', '/api/chats/from-session', 'send_to_session (to_chat)', (b) => onlyKeys(['session'])(b) || (typeof b.session !== 'string' ? 'say which session' : null)),
  // Only the carry-on message: a restart of the session in place (restart: true) is the page's own button.
  r('POST /api/sessions/<id>/continue', `/api/sessions/${SEG}/continue`, 'send_to_session (continue)', onlyKeys([])),
  r('GET /api/folders/recent', '/api/folders/recent', 'list_projects'),
  r('GET /api/folders/browse', '/api/folders/browse', 'list_projects (folder)'),
  r('GET /api/folders/sessions', '/api/folders/sessions', 'list_projects (folder)'),
  r('GET /api/pcsetup/projects', '/api/pcsetup/projects', 'list_projects, manage_project'),
  r('GET /api/pcsetup/project/preview', '/api/pcsetup/project/preview', 'manage_project new'),
  r('POST /api/pcsetup/project/new', '/api/pcsetup/project/new', 'manage_project new'),
  r('POST /api/pcsetup/project/clone', '/api/pcsetup/project/clone', 'manage_project get'),
  r('POST /api/pcsetup/project/add', '/api/pcsetup/project/add', 'manage_project add_repository'),
  r('POST /api/pcsetup/project/sync', '/api/pcsetup/project/sync', 'manage_project sync'),
  r('POST /api/pcsetup/install', '/api/pcsetup/install', 'manage_project install'),
  r('GET /api/pcsetup/job', '/api/pcsetup/job', 'manage_project (job result)'),
  r('GET /api/workspace', '/api/workspace', 'list_projects'),
  r('POST /api/workspace/setup', '/api/workspace/setup', 'manage_project create_folders'),
  r('GET /api/workspace/map', '/api/workspace/map', 'list_projects (map)'),
  r('POST /api/workspace/map', '/api/workspace/map', 'manage_project workspace_map'),
  r('GET /api/workspace/git', '/api/workspace/git', 'list_projects (git)'),
  r('POST /api/workspace/restore', '/api/workspace/restore', 'manage_project workspace_restore'),
  r('POST /api/workspace/sync', '/api/workspace/sync', 'manage_project workspace_sync, workspace_sync_from'),
  r('GET /api/workspace/job', '/api/workspace/job', 'manage_project (workspace job result)'),
  r('POST /api/workspace/settings', '/api/workspace/settings', 'manage_project workspace_places'),
  r('POST /api/workspace/forget', '/api/workspace/forget', 'manage_project workspace_forget'),
  r('GET /api/workspace/whohas', '/api/workspace/whohas', 'manage_project where'),
  r('GET /api/workspace/find', '/api/workspace/find', 'manage_project find'),
  r('POST /api/workspace/drop/check', '/api/workspace/drop/check', 'manage_project drop_check, drop', onlyKeys(['name'])),
  // Only the dry run: a group goes into the map by the owner's own press on the page.
  r('POST /api/workspace/group', '/api/workspace/group', 'manage_project group_add (the dry run for her card)', (b) => onlyKeys(['dir', 'repo', 'holds', 'dryRun'])(b) || (b.dryRun !== true ? 'a group is added by the owner\'s own press on the Workspace page' : null)),
  // Work (manage_work): the list, its items and "Do it". Only the fields her tool sends: a start always carries the brief
  // her card showed (never `seen` or a dry run), and a status she sets is done, open, dropped, or waiting again (undo).
  // Save, the settings and the command's route stay the owner's (NEVER below). Tidy and the doubles are her cards:
  // tidy is written only with the hash of the difference his card showed.
  r('GET /api/work', '/api/work', 'manage_work today, list, task'),
  r('POST /api/work/items', '/api/work/items', 'manage_work add', onlyKeys(['title', 'date', 'project', 'by', 'note'])),
  r('POST /api/work/items/<id>', `/api/work/items/${SEG}`, 'manage_work edit, undo', (b) => onlyKeys(['at', 'title', 'date', 'project', 'by', 'note'])(b) || atOk(b)),
  r('POST /api/work/items/<id>/status', `/api/work/items/${SEG}/status`, 'manage_work done, reopen, drop, undo', (b) => onlyKeys(['at', 'status'])(b) || atOk(b) || (['done', 'open', 'dropped', 'waiting'].includes(b.status) ? null : 'that status is the owner\'s or the run\'s to set')),
  r('POST /api/work/items/<id>/remove', `/api/work/items/${SEG}/remove`, 'manage_work remove, undo', (b) => onlyKeys(['at'])(b) || atOk(b)),
  r('GET /api/work/items/<id>/do', `/api/work/items/${SEG}/do`, 'manage_work start (what it would start)'),
  r('POST /api/work/items/<id>/do', `/api/work/items/${SEG}/do`, 'manage_work start', (b) => onlyKeys(['at', 'brief', 'project', 'folder', 'tool', 'provider', 'model', 'effort'])(b) || atOk(b) || (typeof b.brief !== 'string' || !b.brief.trim() ? 'a start of hers carries the brief her card showed' : null)),
  r('POST /api/work/items/<id>/accept', `/api/work/items/${SEG}/accept`, 'manage_work accept', (b) => onlyKeys(['at'])(b) || atOk(b)),
  r('POST /api/work/items/<id>/send-back', `/api/work/items/${SEG}/send-back`, 'manage_work send_back', (b) => onlyKeys(['at', 'text'])(b) || atOk(b)),
  r('POST /api/work/fix-ids', '/api/work/fix-ids', 'manage_work fix_ids', onlyKeys([])),
  r('GET /api/work/tidy', '/api/work/tidy', 'manage_work tidy (what it would write)'),
  r('POST /api/work/tidy', '/api/work/tidy', 'manage_work tidy', (b) => onlyKeys(['hash'])(b) || (typeof b.hash === 'string' && /^[0-9a-f]{32}$/.test(b.hash) ? null : 'the hash of the difference the card showed')),
  r('GET /api/work/runs', '/api/work/runs', 'manage_work task, run'),
  r('GET /api/work/progress', '/api/work/progress', 'manage_work progress'),
  // Plans: she reads the list and one plan.
  r('GET /api/work/plans', '/api/work/plans', 'manage_work plans'),
  r('GET /api/work/plans/<id>', `/api/work/plans/${SEG}`, 'manage_work plan, add, edit, done (the plan as it is now)'),
  // A task into a plan (its milestone) or what it waits for; a plan's own words, milestones and status stay his.
  // A plan she makes or changes (hoprig_act change-plan): its title, goal, projects and milestones, never its status.
  r('POST /api/work/plans', '/api/work/plans', 'hoprig_act change-plan', onlyKeys(['title', 'goal', 'projects', 'milestones'])),
  r('POST /api/work/plans/<id>', `/api/work/plans/${SEG}`, 'hoprig_act change-plan', onlyKeys(['seen', 'title', 'goal', 'projects', 'milestones'])),
  r('POST /api/work/items/<id>/plan', `/api/work/items/${SEG}/plan`, 'manage_work add, edit, undo', (b) => onlyKeys(['at', 'plan', 'milestone', 'after'])(b) || atOk(b)),
  // Missions: she reads them, and gives a goal by her card (its dry run first). Stop, a task of his list into a
  // mission and a waiting task's tests in the box are her cards too. The switches, Tia OFF and the tests outside the
  // box (the field `outside`: his own press on his page) stay his, so that field is never hers to send.
  r('GET /api/work/missions', '/api/work/missions', 'manage_work mission'),
  r('GET /api/work/missions/<id>', '/api/work/missions/m-[^/]+', 'manage_work mission'),
  r('POST /api/work/missions', '/api/work/missions', 'manage_work goal', (b) => onlyKeys(['goal', 'project', 'dryRun'])(b) || (b.dryRun !== undefined && typeof b.dryRun !== 'boolean' ? 'dryRun is true or false' : null)),
  r('POST /api/work/missions/<id>/stop', '/api/work/missions/m-[^/]+/stop', 'manage_work mission_stop', onlyKeys([])),
  r('POST /api/work/missions/<id>/add', '/api/work/missions/m-[^/]+/add', 'manage_work mission_add', (b) => onlyKeys(['task'])(b) || (typeof b.task === 'string' && b.task ? null : 'name the task')),
  r('POST /api/work/missions/<id>/tasks/<id>/run-tests', `/api/work/missions/m-[^/]+/tasks/${SEG}/run-tests`, 'manage_work mission_tests', onlyKeys([])),
  r('GET /api/brain', '/api/brain', 'read_brain'),
  r('GET /api/brain/item', '/api/brain/item', 'read_brain (item)'),
  r('GET /api/machines', '/api/machines', 'get_computer_status, manage_computer'),
  r('GET /api/pc', '/api/pc', 'get_computer_status, manage_computer end_process'),
  r('GET /api/claude', '/api/claude', 'get_computer_status'),
  r('GET /api/pcsetup/status', '/api/pcsetup/status', 'get_computer_status (setup), manage_computer setup_fix'),
  r('GET /api/pcsetup/kits', '/api/pcsetup/kits', 'get_computer_status (setup), manage_computer set_up'),
  // A Fix changes what is installed: only as the act of a card the owner confirmed for that check (confirmed.mjs).
  r('POST /api/pcsetup/fix', '/api/pcsetup/fix', 'manage_computer setup_fix', onlyKeys(['id', 'confirm']), (c, p, b) => c.input.action === 'setup_fix' && isObj(b) && c.input.check === b.id),
  r('POST /api/pcsetup/setup', '/api/pcsetup/setup', 'manage_computer set_up', onlyKeys(['kits'])),
  r('POST /api/claude/update', '/api/claude/update', 'manage_computer update (Claude Code, on a computer without Settings → Updates)', onlyKeys([])),
  // The coding tools and Settings → Updates. Installing, updating and turning a coding tool on or off are cards; how
  // updates run (by themselves or not) stays the owner's (NEVER below), and so does another coding tool's sign-in.
  r('GET /api/codetools', '/api/codetools', 'get_computer_status (coding_tools), manage_computer coding_tool'),
  r('POST /api/codetools/<id>', '/api/codetools/[a-z]+', 'manage_computer coding_tool', (b) => onlyKeys(['on'])(b) || (typeof b.on !== 'boolean' ? 'on is true or false' : null)),
  r('GET /api/updates', '/api/updates', 'get_computer_status (coding_tools), manage_computer update'),
  r('POST /api/updates/check', '/api/updates/check', 'manage_computer check_updates', onlyKeys([])),
  r('POST /api/updates/run', '/api/updates/run', 'manage_computer update', (b) => onlyKeys(['id'])(b) || (typeof b.id !== 'string' ? 'say which item to update' : null)),
  // The restart after an update of Hoprig, by her card only (it ends her own turn): nothing to send, and only as the act of
  // a card he confirmed for it, from her tool or her act (confirmed.mjs).
  r('POST /api/updates/restart', '/api/updates/restart', 'manage_computer restart_dashboard, hoprig_act restart-hoprig', onlyKeys([]), (c) => (c.tool === 'manage_computer' && c.input.action === 'restart_dashboard') || (c.tool === 'hoprig_act' && c.input.act === 'restart-hoprig'), ['manage_computer', 'hoprig_act']),
  r('POST /api/pc/kill', '/api/pc/kill', 'manage_computer end_process'),
  r('POST /api/pc/power', '/api/pc/power', 'manage_computer reboot, power_off'),
  r('POST /api/machine/label', '/api/machine/label', 'manage_computer rename (this computer)'),
  r('POST /api/machines/<id>/rename', `/api/machines/${SEG}/rename`, 'manage_computer rename (another computer)'),
  r('GET /api/addons', '/api/addons', 'manage_computer addon'),
  // Not the public link's: it opens the computer to the internet, through its own route and a card.
  // Starting or stopping one (a gateway is one) changes what works for every session: the act of his card, like the two below.
  r('POST /api/addons/<id>/(install|update|start|stop)', `/api/addons/(?!public-link/)${SEG}/(start|stop)`, 'manage_computer addon', onlyKeys([]), (c, p) => c.input.action === 'addon' && p === `/api/addons/${c.input.addon}/${c.input.addon_action}`),
  // Installing or updating one changes what is installed: only as the act of a card he confirmed for exactly that.
  r('POST /api/addons/<id>/(install|update|start|stop)', `/api/addons/(?!public-link/)${SEG}/(install|update)`, 'manage_computer addon', onlyKeys(['confirm']), (c, p) => c.input.action === 'addon' && p === `/api/addons/${c.input.addon}/${c.input.addon_action}`),
  r('GET /api/public-link', '/api/public-link', 'manage_computer public_link'),
  r('POST /api/public-link', '/api/public-link', 'manage_computer public_link (off only: on is his own press)', (b) => onlyKeys(['on'])(b) || (b.on !== false ? 'turning the public link on is the owner\'s own press on Settings → Public link' : null)),
  r('GET /api/automation', '/api/automation', 'manage_automation'),
  r('POST /api/automation/settings', '/api/automation/settings', 'manage_automation set_rule, pause, resume', automationBody),
  r('POST /api/automation/schedules', '/api/automation/schedules', 'manage_automation add / change / delete_schedule'),
  r('POST /api/automation/queue/<id>', `/api/automation/queue/${SEG}`, 'manage_automation queue_message, queue_clear'),
  r('GET /api/skillhub', '/api/skillhub', 'manage_skills installed, hoprig_act change-setting'),
  r('GET /api/skillhub/suggest', '/api/skillhub/suggest', 'manage_skills suggested'),
  r('GET /api/skillhub/find', '/api/skillhub/find', 'manage_skills find'),
  r('POST /api/skillhub/check', '/api/skillhub/check', 'manage_skills check_updates'),
  r('POST /api/skillhub/review', '/api/skillhub/review', 'manage_skills review'),
  r('POST /api/skillhub/update-review', '/api/skillhub/update-review', 'manage_skills update_review'),
  r('POST /api/skillhub/approve', '/api/skillhub/approve', 'manage_skills install'),
  r('POST /api/skillhub/remove', '/api/skillhub/remove', 'manage_skills remove'),
  // A review's cancel names only the review (its id as the hub makes it); undo only a skill's name and its project.
  // The "went wrong twice" lines and the skills learned from his work: she reads them, and Dismiss, a draft, Install,
  // Discard or Undo run only as the act of her card he confirmed for exactly that line or skill (the route checks).
  // Learned skills on this computer only: another computer would take the relay's token as the owner's own press.
  r('POST /api/skillhub/cancel', '/api/skillhub/cancel', 'manage_skills cancel_review', (b) => onlyKeys(['id'])(b) || (typeof b.id === 'string' && /^[a-f0-9]{24}$/.test(b.id) ? null : 'the id of a review she was shown')),
  r('POST /api/skillhub/undo', '/api/skillhub/undo', 'manage_skills undo_update', (b) => onlyKeys(['name', 'project'])(b)
    || (typeof b.name === 'string' && /^[a-z0-9][a-z0-9:._-]{0,79}$/.test(b.name) ? null : 'the name of an installed skill')
    || (b.project !== undefined && (typeof b.project !== 'string' || !b.project) ? 'project is a folder' : null)),
  r('GET /api/field/twice', '/api/field/twice', 'manage_skills twice, twice_dismiss, twice_draft (the lines as they stand)'),
  r('POST /api/field/twice/<id>/(dismiss|draft)', '/api/field/twice/[a-z-]+:[a-z-]+/dismiss', 'manage_skills twice_dismiss', onlyKeys([])),
  r('POST /api/field/twice/<id>/(dismiss|draft)', '/api/field/twice/[a-z-]+:[a-z-]+/draft', 'manage_skills twice_draft', onlyKeys([])),
  r('GET /api/skills/learned', '/api/skills/learned', 'manage_skills learned, learned_install, learned_discard, learned_undo (the skills as they stand)', learnedHere),
  r('POST /api/skills/learned/<id>/(install|discard|undo)', '/api/skills/learned/[0-9a-f]{24}/install', 'manage_skills learned_install', learnedBody),
  r('POST /api/skills/learned/<id>/(install|discard|undo)', '/api/skills/learned/[0-9a-f]{24}/discard', 'manage_skills learned_discard', learnedBody),
  r('POST /api/skills/learned/<id>/(install|discard|undo)', '/api/skills/learned/[0-9a-f]{24}/undo', 'manage_skills learned_undo', learnedBody),
  r('POST /api/skillhub/settings', '/api/skillhub/settings', 'hoprig_act change-setting skills_weekly_check'),
  r('GET /api/settings', '/api/settings', 'get_computer_status (settings), hoprig_act change-setting'),
  r('POST /api/settings', '/api/settings', 'hoprig_act change-setting, auto-mode, auto-order', settingsBody),
  r('POST /api/pcsetup/projects-dir', '/api/pcsetup/projects-dir', 'hoprig_act change-setting projects_folder'),
  r('POST /api/pcsetup/rules', '/api/pcsetup/rules', 'hoprig_act change-setting claude_working_rules'),
  r('POST /api/assistant/run', '/api/assistant/run', 'run_command'),
];

/** A row is hers at the door when it is a route, names a tool of hers, and its facts do not make it the owner's. */
const reachable = (row) => row && row.kind === 'route' && row.tool && rowAnswer(row) !== 'open' && rowAnswer(row) !== 'none';
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The door from the rows of the acts file (acts.json, one row for every act, with its seven facts; see acts.mjs):
 *   ALLOW          the entries of WIRES whose row says a tool of hers reaches it and whose facts do not make it open: the
 *                  routes her tools use, how each is checked and the tool (or tools) behind it;
 *   NEVER_ROUTES   the owner's own hand only, refused even if a mistake put the route in ALLOW, in the six classes of
 *                  NEVER (acts.mjs NEVER_CLASSES): the rows whose facts name a class. A route is matched by its row (any
 *                  one segment for an id); where EVERY row under a first address word (/api/tokens) is of one class,
 *                  anything under that word is too. The classes:
 *       sign-in      sign in and out, providers and accounts with keys, tokens, the password, a gateway's own sign-ins
 *       credentials  the credentials folder
 *       open-out     the public link's own set-up, a forward, sharing a gateway: they open the computer to the internet
 *       pair         adding, linking, removing and pairing a computer, its host key
 *       delete-work  a project, a repository, a branch, files outside a session's folder: reset, rebase, force
 *       her-rights   her own settings, token and cards, administrator rights, the permission mode, Hands off, updates
 *                    that install by themselves; confirming a card
 *   OWN_PRESS      the rest of what the owner presses on his own page and no tool of hers does yet (a push, a release, a
 *                  review): the rows with no tool and no class that change something, a level L2 by the rule once a tool
 *                  has it; kept refused here as before;
 *   problems       a row that a tool reaches and no wire checks, a wire of a route that is no row of hers.
 * A route that is a row of none of these is not in ALLOW, which refuses it too. Nothing says here that a route is hers or his.
 */
export function deriveDoor(rows, wires = WIRES) {
  // The pattern of a row's address, with its method: a GET that holds a secret does not close the POST at the same address.
  const patternOf = (x) => Object.assign(sourcePattern(x.source), { method: x.source.split(' ')[0] });
  const routes = rows.filter((x) => x.kind === 'route');
  const rowOf = new Map(rows.filter((x) => x.kind !== 'step').map((x) => [x.source, x]));
  // The first one and two address words of a row ("/api/tokens", "/api/settings/bypass"). Where every row under a word that
  // is not a row of hers is of one class, the word is that class's (the rows of hers under it, which pass, are left out).
  const wordsOf = (x) => { const segs = x.source.replace(/^[A-Z]+ /, '').split('/'); return [segs.slice(0, 3).join('/'), segs.slice(0, 4).join('/')]; };
  const families = (cls) => {
    const words = new Set(routes.filter((x) => x.facts.never === cls).flatMap(wordsOf));
    return [...words].flatMap((w) => {
      const under = routes.filter((x) => wordsOf(x).includes(w));
      const free = under.filter((x) => x.facts.never === 'none');
      if (under.some((x) => x.facts.never !== 'none' && x.facts.never !== cls) || free.some((x) => x.tool === undefined && rowAnswer(x) === 'card')) return [];
      const left = free.map((x) => sourcePattern(x.source).source.slice(1, -1));
      return [new RegExp(`^${left.length ? `(?!(?:${left.join('|')})$)` : ''}${escapeRe(w)}(/|$)`)];
    });
  };
  return {
    ALLOW: wires.filter((w) => reachable(rowOf.get(w.source))).map(({ source, ...entry }) => entry), // eslint-disable-line no-unused-vars
    NEVER_ROUTES: Object.freeze(Object.fromEntries(Object.keys(NEVER_CLASSES).map((cls) => [cls, Object.freeze([...routes.filter((x) => x.facts.never === cls).map(patternOf), ...families(cls)])]))),
    OWN_PRESS: Object.freeze([
      ...routes.filter((x) => x.facts.never === 'none' && !x.tool && !['read', 'open'].includes(rowAnswer(x))).map(patternOf),
      /^\/ws(\/|$)/, // the terminals' socket: no route of the table, the owner's page only
    ]),
    problems: Object.freeze([
      ...rows.filter((x) => reachable(x) && !wires.some((w) => w.source === x.source)).map((x) => `${x.source}: a tool reaches it but no wire says how the door checks it`),
      ...wires.filter((w) => !reachable(rowOf.get(w.source))).map((w) => `${w.source}: a wire for a route that is no row of hers`),
    ]),
  };
}
const DOOR = deriveDoor(loadActs().rows);
/** Every route her tools use. */
export const ALLOW = DOOR.ALLOW;
export const WIRE_PROBLEMS = DOOR.problems;
export const NEVER_ROUTES = DOOR.NEVER_ROUTES;
export const OWN_PRESS = DOOR.OWN_PRESS;
/** Every refused pattern, flat (a test and the old name). */
export const NEVER = Object.freeze([...Object.values(NEVER_ROUTES).flat(), ...OWN_PRESS]);
/**
 * The class of NEVER a path falls in, "owner" for the rest of his own presses, or null. With a method (the door's own call)
 * only the rows of that method count; without one (the other computer's gate) every method does: a path that is the owner's
 * for any method is the owner's.
 */
export const neverClassOf = (p, method) => {
  const hit = (re) => re.test(p) && (!method || !re.method || re.method === method);
  return Object.entries(NEVER_ROUTES).find(([, list]) => list.some(hit))?.[0] || (OWN_PRESS.some(hit) ? 'owner' : null);
};

const MACHINE = /^\/m\/([a-z0-9][a-z0-9_-]{0,31})(\/.*)$/;
const refuse = (message) => Object.assign(new Error(message), { status: 403, code: 'tia-route' });
// eslint-disable-next-line no-control-regex
const BAD_DECODED = /[/%\\\x00-\x1f\x7f]/;

/** The path with each segment decoded once; null when a segment does not decode or decodes to something odd. */
function decodedPath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    let d;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (BAD_DECODED.test(d)) return null;
    out.push(d);
  }
  return out.join('/');
}

/** The computer ("/m/<computer>" taken off, null: this one) and the decoded path of `url`, or a 403 error. */
function target(url) {
  let u;
  try {
    u = new URL(url, 'http://x');
  } catch {
    throw refuse('that address cannot be read');
  }
  if (u.origin !== 'http://x') throw refuse('only this dashboard\'s own routes');
  let p = u.pathname;
  let computer = null;
  const m = MACHINE.exec(p);
  if (m) {
    computer = m[1];
    p = new URL(m[2], 'http://x').pathname;
  } else if (p.startsWith('/m/')) throw refuse('that computer name is not valid');
  const d = decodedPath(p);
  if (d === null) throw refuse('that address holds an encoded character no route of Tia\'s takes');
  return { computer, p: d };
}

/**
 * Check one request of Tia's tools. Returns { method, route, computer } or throws a 403 error. `ctx` is needed only
 * for the settings body check: ctx.config() (this computer), ctx.settingsOf(computer) (another one's, as it answered).
 */
export function checkRoute(method, url, body, ctx) {
  const { computer, p } = target(url);
  const never = neverClassOf(p, method);
  if (never) throw refuse(`${method} ${p} is the owner's own step, not Tia's${never === 'owner' ? '' : ` (${never})`}`);
  const entry = ALLOW.find((e) => e.method === method && e.re.test(p));
  if (!entry) throw refuse(`${method} ${p} is not a route Tia's tools use`);
  if (entry.body) {
    const why = entry.body(body, ctx, computer);
    if (why) throw refuse(why);
  }
  if (entry.card) {
    const c = confirmedCard();
    if (!c || !entry.cardTools.includes(c.tool) || cardComputer(c) !== computer || !entry.card(c, p, body)) throw refuse(`${method} ${p} is the owner's own: it runs only when he confirms her card for it`);
  }
  return { method, route: p, computer, tool: entry.tool };
}

/**
 * The door: check, then dispatch. The only place that calls ctx.dispatch. A settings change for another computer that
 * carries the owner's session defaults is checked against that computer's own settings, read through the door first:
 * its Lead and ticks are not this computer's.
 */
export function gatedDispatch(ctx, method, url, body) {
  const { computer, p } = target(url);
  if (!(computer && method === 'POST' && p === '/api/settings' && carries(body))) {
    checkRoute(method, url, body, ctx);
    return ctx.dispatch(method, url, body);
  }
  return (async () => {
    const r = await gatedDispatch(ctx, 'GET', `/m/${computer}/api/settings`, undefined);
    const there = r && r.status === 200 && isObj(r.json) ? r.json : null;
    checkRoute(method, url, body, { ...ctx, settingsOf: (c) => (c === computer ? there : null) });
    return ctx.dispatch(method, url, body);
  })();
}
