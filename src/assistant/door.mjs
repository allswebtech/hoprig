// The one door between Tia's tools and the dashboard's routes. ops.mjs runs every action through ctx.dispatch (the
// page's own route, in-process, as the owner); nothing else in the code base may call ctx.dispatch, and every call
// passes here first:
//
//   1. the address is normalised exactly as the server will read it (`new URL(url, 'http://x')`: dot segments
//      resolved; an encoded "/" stays inside its segment) and an "/m/<computer>" prefix is taken off;
//   2. a route on NEVER is refused, whatever the table says (the owner's own steps, L3);
//   3. only a method + route in ALLOW passes, and for the two settings routes only the keys her tools change.
//
// Both lists are data, here, so a reviewer reads in one place what she can reach. The other computer decides for
// itself too: a relayed request arrives there with the hub's machine token and passes that computer's own gate
// (src/machines/index.mjs TOKEN_FORBIDDEN).

const SEG = '[^/]+';
const CHAT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const r = (method, path, tool, body = null) => ({ method, re: new RegExp(`^${path}$`), path, tool, body });

/** Keys of POST /api/settings her tools may send (change_setting, set_auto_mode). */
const SETTINGS_KEYS = {
  server: ['quickActions', 'roots', 'publicUrl', 'uploadMaxMB', 'uploadsDir'],
  autoSwitch: ['enabled', 'order', 'returnToPreferred', 'prompt', 'cooldownMinutes'],
  sessionDefaults: ['model', 'effort', 'permissionMode'], // permissionMode only unchanged: see settingsBody
};
const AUTOMATION_SECTIONS = { paused: true, queue: ['enabled'], schedules: ['enabled'], restore: ['enabled'], retry: ['enabled'], idle: ['shells', 'gateway'], updates: ['claude'], workspace: ['map', 'commitMap', 'sync', 'push', 'everyHours'] };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** POST /api/settings: only her keys; the permission mode of new sessions may be carried along, never changed. */
function settingsBody(b, ctx) {
  if (!isObj(b)) return 'the body must be an object';
  for (const [top, v] of Object.entries(b)) {
    const allowed = SETTINGS_KEYS[top];
    if (!allowed) return `"${top}" is the owner's setting`;
    if (!isObj(v)) return `"${top}" must be an object`;
    for (const k of Object.keys(v)) if (!allowed.includes(k)) return `"${top}.${k}" is the owner's setting`;
  }
  if (b.sessionDefaults && 'permissionMode' in b.sessionDefaults) {
    const cur = ((ctx.config() || {}).sessionDefaults || {}).permissionMode;
    if (b.sessionDefaults.permissionMode !== cur) return 'the permission mode of new sessions is the owner\'s setting';
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

/** Every route her tools use: method, route, the tool (or tools) behind it. */
export const ALLOW = [
  r('GET', '/api/state', 'list_sessions, get_accounts'),
  r('GET', '/api/machines/sessions', 'list_sessions (every computer)'),
  r('GET', `/api/sessions/${SEG}/history`, 'read_session'),
  r('POST', '/api/sessions', 'start_session'),
  // Only the text: `owner: true` marks the owner's own typing (types into whatever runs there); hers is typed only for the coding tool.
  r('POST', `/api/sessions/${SEG}/send`, 'send_to_session', onlyKeys(['text'])),
  // Only the key, as for /send: `owner: true` is the page's own buttons; her keys go only to the coding tool in front.
  r('POST', `/api/sessions/${SEG}/key`, 'send_to_session (key)', onlyKeys(['key'])),
  r('POST', `/api/sessions/${SEG}/rename`, 'rename_session'),
  r('POST', `/api/sessions/${SEG}/kill`, 'stop_session'),
  r('POST', `/api/sessions/${SEG}/switch`, 'switch_account'),
  // A chat (src/chat): only the fields her tools send. The model, effort and permission mode of a chat, its plan
  // approvals and questions, its files and rewinds stay the owner's, in the page. Its provider moves as a terminal's
  // does (switch_account: the same rules, a card unless it is her own chat).
  // A chat she starts takes Settings → New-session defaults (defaults: true), never the folder's last chat of the owner,
  // and is marked hers (byTia: the chat it creates, see src/chat/feature.mjs openChat).
  r('POST', '/api/chats', 'start_chat', (b) => onlyKeys(['dir', 'tool', 'profile', 'sessionId', 'text', 'defaults', 'byTia'])(b) || (b.defaults !== true ? 'a chat Tia starts takes Settings\' defaults (defaults: true)' : null)),
  // Her message says it is hers (byTia: true): a message from anyone else takes her mark off the chat.
  r('POST', `/api/chats/${CHAT_ID}/send`, 'send_to_chat (text)', (b) => onlyKeys(['text', 'byTia'])(b) || (b.byTia !== true ? 'a message Tia sends says it is hers (byTia: true)' : null)),
  r('POST', `/api/chats/${CHAT_ID}/answer`, 'send_to_chat (answer)', onlyKeys(['request', 'allow', 'always'])),
  r('POST', `/api/chats/${CHAT_ID}/stop`, 'send_to_chat (stop)', onlyKeys([])),
  r('POST', `/api/chats/${CHAT_ID}/provider`, 'switch_account (a chat)', (b) => onlyKeys(['profile'])(b) || (typeof b.profile !== 'string' ? 'say which provider' : null)),
  r('GET', '/api/folders/recent', 'list_projects'),
  r('GET', '/api/folders/browse', 'list_projects (folder)'),
  r('GET', '/api/folders/sessions', 'list_projects (folder)'),
  r('GET', '/api/pcsetup/projects', 'list_projects, manage_project'),
  r('GET', '/api/pcsetup/project/preview', 'manage_project new'),
  r('POST', '/api/pcsetup/project/new', 'manage_project new'),
  r('POST', '/api/pcsetup/project/clone', 'manage_project get'),
  r('POST', '/api/pcsetup/project/add', 'manage_project add_repository'),
  r('POST', '/api/pcsetup/project/sync', 'manage_project sync'),
  r('POST', '/api/pcsetup/install', 'manage_project install'),
  r('GET', '/api/pcsetup/job', 'manage_project (job result)'),
  r('GET', '/api/workspace', 'list_projects'),
  r('POST', '/api/workspace/setup', 'manage_project create_folders'),
  r('GET', '/api/workspace/map', 'list_projects (map)'),
  r('POST', '/api/workspace/map', 'manage_project workspace_map'),
  r('GET', '/api/workspace/git', 'list_projects (git)'),
  r('POST', '/api/workspace/restore', 'manage_project workspace_restore'),
  r('POST', '/api/workspace/sync', 'manage_project workspace_sync, workspace_sync_from'),
  r('GET', '/api/workspace/job', 'manage_project (workspace job result)'),
  r('POST', '/api/workspace/settings', 'manage_project workspace_places'),
  r('POST', '/api/workspace/forget', 'manage_project workspace_forget'),
  r('GET', '/api/brain', 'read_brain'),
  r('GET', '/api/brain/item', 'read_brain (item)'),
  r('GET', '/api/machines', 'get_computer_status, manage_computer'),
  r('GET', '/api/pc', 'get_computer_status, manage_computer end_process'),
  r('GET', '/api/claude', 'get_computer_status'),
  r('GET', '/api/pcsetup/status', 'get_computer_status (setup), manage_computer setup_fix'),
  r('GET', '/api/pcsetup/kits', 'get_computer_status (setup), manage_computer set_up'),
  r('POST', '/api/pcsetup/fix', 'manage_computer setup_fix', onlyKeys(['id'])),
  r('POST', '/api/pcsetup/setup', 'manage_computer set_up', onlyKeys(['kits'])),
  r('POST', '/api/claude/update', 'manage_computer update (Claude Code, on a computer without Settings → Updates)', onlyKeys([])),
  // The coding tools and Settings → Updates. Installing, updating and turning a coding tool on or off are cards; how
  // updates run (by themselves or not) stays the owner's (NEVER below), and so does another coding tool's sign-in.
  r('GET', '/api/codetools', 'get_computer_status (coding_tools), manage_computer coding_tool'),
  r('POST', '/api/codetools/[a-z]+', 'manage_computer coding_tool', (b) => onlyKeys(['on'])(b) || (typeof b.on !== 'boolean' ? 'on is true or false' : null)),
  r('GET', '/api/updates', 'get_computer_status (coding_tools), manage_computer update'),
  r('POST', '/api/updates/check', 'manage_computer check_updates', onlyKeys([])),
  r('POST', '/api/updates/run', 'manage_computer update', (b) => onlyKeys(['id'])(b) || (typeof b.id !== 'string' ? 'say which item to update' : null)),
  r('POST', '/api/pc/kill', 'manage_computer end_process'),
  r('POST', '/api/pc/power', 'manage_computer reboot, power_off'),
  r('POST', '/api/machines/ssh', 'manage_computer add'),
  r('POST', '/api/machine/label', 'manage_computer rename (this computer)'),
  r('POST', `/api/machines/${SEG}/rename`, 'manage_computer rename (another computer)'),
  r('GET', '/api/addons', 'manage_computer addon'),
  // Not the public link's: it opens the computer to the internet, through its own route and a card.
  r('POST', `/api/addons/(?!public-link/)${SEG}/(install|update|start|stop)`, 'manage_computer addon'),
  r('GET', '/api/public-link', 'manage_computer public_link'),
  r('POST', '/api/public-link', 'manage_computer public_link', onlyKeys(['on', 'kind'])),
  r('GET', '/api/automation', 'manage_automation'),
  r('POST', '/api/automation/settings', 'manage_automation set_rule, pause, resume', automationBody),
  r('POST', '/api/automation/schedules', 'manage_automation add / change / delete_schedule'),
  r('POST', `/api/automation/queue/${SEG}`, 'manage_automation queue_message, queue_clear'),
  r('GET', '/api/skillhub', 'manage_skills installed, change_setting'),
  r('GET', '/api/skillhub/suggest', 'manage_skills suggested'),
  r('GET', '/api/skillhub/find', 'manage_skills find'),
  r('POST', '/api/skillhub/check', 'manage_skills check_updates'),
  r('POST', '/api/skillhub/review', 'manage_skills review'),
  r('POST', '/api/skillhub/update-review', 'manage_skills update_review'),
  r('POST', '/api/skillhub/approve', 'manage_skills install'),
  r('POST', '/api/skillhub/remove', 'manage_skills remove'),
  r('POST', '/api/skillhub/settings', 'change_setting skills_weekly_check'),
  r('GET', '/api/settings', 'get_computer_status (settings), change_setting'),
  r('POST', '/api/settings', 'change_setting, set_auto_mode', settingsBody),
  r('POST', '/api/pcsetup/projects-dir', 'change_setting projects_folder'),
  r('POST', '/api/pcsetup/rules', 'change_setting claude_working_rules'),
  r('POST', '/api/assistant/run', 'run_command'),
];

/**
 * Routes that are the owner's own (L3), refused even if a mistake put them in ALLOW: the password, login and
 * sign-in links, logout, tokens and pairing, joining, removing or installing on a computer, providers (the wizard,
 * profile files, available-again marks stay with the page), add-on sign-in, notifications, onboarding, recipes,
 * and everything of Tia's own except run (her settings, her token, the cards she may never confirm herself).
 */
export const NEVER = [
  /^\/api\/settings\/password$/,
  /^\/api\/(login|logout|me)(\/|$)/,
  /^\/api\/tokens(\/|$)/,
  /^\/api\/pair(\/|$)/,
  /^\/api\/joins?(\/|$)/,
  /^\/api\/links?(\/|$)/,
  /^\/api\/machines\/url$/,
  /^\/api\/machines\/install$/,
  /^\/api\/machines\/[^/]+\/(remove|test)$/,
  /^\/api\/profiles(\/|$)/,
  /^\/api\/accounts(\/|$)/,
  /^\/api\/addons\/[^/]+\/setup$/,
  /^\/api\/addons\/public-link\//, // the old routes of the public link: Tia uses its own route, with a card
  /^\/api\/public-link\/.+$/, // the Custom set-up (a Cloudflare sign-in) and its extra addresses: the owner's own steps
  /^\/api\/updates\/settings$/, // updates by themselves or not: the owner's choice
  /^\/api\/codetools\/[^/]+\/signin$/, // another coding tool's own sign-in
  /^\/api\/notify(\/|$)/,
  /^\/api\/onboarding(\/|$)/,
  /^\/api\/pcsetup\/recipe$/,
  /^\/api\/workspace\/git\/.+$/, // signing in to GitHub, the commit name, the brain's repository: the owner's own steps
  /^\/api\/assistant(?!\/run$)(\/|$)/,
  /^\/ws(\/|$)/,
];

const MACHINE = /^\/m\/([a-z0-9][a-z0-9_-]{0,31})(\/.*)$/;
const refuse = (message) => Object.assign(new Error(message), { status: 403, code: 'tia-route' });

/**
 * Check one request of Tia's tools. Returns { method, route, computer } or throws a 403 error. `ctx` is needed only
 * for the settings body check (the current permission mode).
 */
export function checkRoute(method, url, body, ctx) {
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
  if (NEVER.some((re) => re.test(p))) throw refuse(`${method} ${p} is the owner's own step, not Tia's`);
  const entry = ALLOW.find((e) => e.method === method && e.re.test(p));
  if (!entry) throw refuse(`${method} ${p} is not a route Tia's tools use`);
  if (entry.body) {
    const why = entry.body(body, ctx);
    if (why) throw refuse(why);
  }
  return { method, route: p, computer, tool: entry.tool };
}

/** The door: check, then dispatch. The only place that calls ctx.dispatch. */
export function gatedDispatch(ctx, method, url, body) {
  checkRoute(method, url, body, ctx);
  return ctx.dispatch(method, url, body);
}
