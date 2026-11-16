// What every tool definition shares (tools.mjs and domains.mjs): the input parts that name a computer, a session,
// a provider or a folder; the result helpers; the recovery error; and `actionTool`, which makes one tool out of a
// small set of actions on one domain object (a project, a computer, the automations, the skills), each action
// with its own level, fields, card and handler. That keeps the eager tool list at 25 or fewer while the owner's
// whole dashboard is reachable.
import { obj, ref, str } from './schema.mjs';
import { LOCAL } from './shown.mjs';

// A terminal session's name, or a chat's (src/chat: "chat:<conversation id>", 41 characters).
export const SESSION = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,39}|chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const ACCOUNT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const COMPUTER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ABS = /^(\/|~\/|~$|[A-Za-z]:[\\/])/;
export const NAME = /^[A-Za-z0-9._-]{1,100}$/; // a project or repository name, as the setup routes take it

export const computer = ref('computer', str({ max: 32, pattern: COMPUTER, desc: `Computer name from get_computer_status; omit for this computer ("${LOCAL}").` }));
export const session = ref('session', str({ max: 41, pattern: SESSION, desc: 'Session name exactly as list_sessions showed it.' }));
export const account = str({ max: 32, pattern: ACCOUNT, desc: 'Provider name from get_accounts, or "auto" while Auto mode is on.' });
export const job = ref('job', str({ max: 12, pattern: /^j_[0-9a-f]{10}$/, desc: 'Job id from start_session, start_chat, watch_session or list_sessions.' }));
export const conversation = ref('conversation', str({ max: 36, pattern: UUID, desc: 'Conversation id from list_projects with folder.' }));
export const folder = str({ max: 1024, pattern: ABS, oneLine: true, desc: 'Absolute folder path (or ~/...) inside the folders the dashboard allows.' });

export const KEYS = ['Enter', 'Escape', 'Up', 'Down', 'Tab', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
// Slash commands that only report or tidy up. Anything else typed with a leading "/" changes how the session
// runs (model, permissions, login, MCP) and needs the owner's OK; "!" runs a shell command directly.
export const SAFE_SLASH = ['/compact', '/context', '/cost', '/status', '/usage', '/help', '/todos'];

/** Why typing `text` into a Claude Code session needs a card, or null. */
export function typedTextRisk(text) {
  const t = String(text).trimStart();
  if (t.startsWith('!')) return 'it starts with "!", which runs a shell command';
  if (t.startsWith('/')) {
    const cmd = t.split(/\s/, 1)[0].toLowerCase();
    if (!SAFE_SLASH.includes(cmd)) return `"${cmd.slice(0, 30)}" changes how the session runs`;
  }
  return null;
}

export const comp = (a) => a.computer || LOCAL;
export const sessKey = (c, s) => `${c}|${s}`;
export const short = (s, n = 160) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
export const minsAgo = (t, now) => (Number.isFinite(t) && t > 0 ? Math.max(0, Math.round((now - t) / 60_000)) : null);

/** A session card as the dashboard keeps it → its status in the words the model sees. */
export function statusOf(c) {
  if (c.kind !== 'claude' && c.kind !== 'chat') return 'shell';
  if (c.limit || c.runLimit) return 'limit';
  if (c.status === 'attention') return 'needs_ok';
  return ['starting', 'working', 'waiting', 'ended'].includes(c.status) ? c.status : 'unknown';
}

export class ToolError extends Error {
  constructor(message, next) {
    super(message);
    this.next = next;
  }
}
export const toolError = (message, next) => new ToolError(message, next);

export const tool = (def) => def;

/**
 * The session card `a.session` names. A chat (kind "chat") has no terminal: only a tool that says it can read one
 * (`chatOk`) gets it; the others get a plain error that sends the owner to its page.
 */
export async function findSession(ops, a, { chatOk = false } = {}) {
  const list = await ops.listSessions({ computer: comp(a) });
  const c = list.find((x) => x.name === a.session && (x.computer || LOCAL) === comp(a));
  if (!c) throw toolError(`there is no session "${a.session}" on ${comp(a)} any more`, 'call list_sessions to see the current ones');
  if (c.kind === 'chat' && !chatOk) {
    throw toolError(`"${a.session}" is a chat in the dashboard page, not a terminal session: this tool cannot act on it`, 'use send_to_chat to write to it, answer its OK or stop it; read_session shows its status');
  }
  return c;
}

const ORDER = { L0: 0, L1: 1, L2: 2 };

/**
 * One tool for a few actions on one domain object. `actions`: { <name>: { level, need: [fields], allow: [fields],
 * run(ops, a, ctx), before?(ops, a, ctx), cardLines?(a, before), check?(a, ctx), facts?(ops, a, ctx),
 * policy?(a, facts, tia) → { level, why } | null } }. `level` may be a function of the input. `fields`: the
 * schema parts the actions use; each action accepts only its own (plus `computer`), so a stray field is an error.
 */
export function actionTool({ name, description, actions, fields }) {
  const input = obj({ action: str({ enum: Object.keys(actions), desc: 'What to do.' }), ...fields, computer }, { required: ['action'] });
  const levelOf = (a) => {
    const l = actions[a.action].level;
    return typeof l === 'function' ? l(a) : l;
  };
  const top = Object.values(actions).map((x) => (typeof x.level === 'function' ? 'L2' : x.level)).sort((p, q) => ORDER[q] - ORDER[p])[0];
  const act = (a) => actions[a.action];
  return {
    name,
    description,
    input,
    level: top,
    card: Object.values(actions).some((x) => x.level !== 'L2') ? 'maybe' : undefined,
    actions,
    levelOf,
    check(a, ctx) {
      const x = act(a);
      const ok = new Set(['action', 'computer', ...(x.need || []), ...(x.allow || [])]);
      for (const k of Object.keys(a)) if (!ok.has(k)) throw toolError(`"${k}" does not go with the action "${a.action}"`, `for ${a.action} give: ${[...(x.need || []), ...(x.allow || [])].join(', ') || 'nothing else'}`);
      for (const k of x.need || []) if (a[k] === undefined) throw toolError(`the action "${a.action}" needs "${k}"`, `add ${k}`);
      if (x.check) x.check(a, ctx);
    },
    run: (ops, a, ctx) => act(a).run(ops, a, ctx),
    before: (ops, a, ctx) => (act(a).before ? act(a).before(ops, a, ctx) : Promise.resolve({ action: a.action })),
    cardLines: (a, b) => (act(a).cardLines ? act(a).cardLines(a, b) : [`${name}: ${a.action}`]),
    facts: (ops, a, ctx) => (act(a).facts ? act(a).facts(ops, a, ctx) : null),
    policy: (a, f, tia) => (act(a).policy ? act(a).policy(a, f, tia) : null),
  };
}
