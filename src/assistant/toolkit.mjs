// What every tool definition shares (tools.mjs and domains.mjs): the input parts that name a computer, a session,
// a provider or a folder; the result helpers; the recovery error; and `actionTool`, which makes one tool out of a
// small set of actions on one domain object (a project, a computer, the automations, the skills), each action
// with its own level, fields, card and handler. That keeps the eager tool list at 25 or fewer while the owner's
// whole dashboard is reachable.
import { obj, ref, str } from './schema.mjs';
import { isCodingCard } from '../automation/cards.mjs';
import { OFFERED } from '../codetools/offered.mjs';
import { LOCAL } from './shown.mjs';
import { fenceData } from './fence.mjs';

// A terminal session's name, or a chat's (src/chat: "chat:<conversation id>", 41 characters).
export const SESSION = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,39}|chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const ACCOUNT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const COMPUTER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ABS = /^(\/|~\/|~$|[A-Za-z]:[\\/])/;
export const NAME = /^[A-Za-z0-9._-]{1,100}$/; // a project or repository name, as the setup routes take it
export const VERSION = /^\d{1,6}(\.\d{1,6}){0,3}([-+][0-9A-Za-z.-]{1,30})?$/;

/**
 * What a summary or an error message may say of a value another computer gave (the checklist in tools.mjs): the
 * value itself only when it is of this code's own form (`re`: a pattern, or a list of the ids this code knows);
 * anything else is `word`, fixed words. What a computer says in its own words (a title, a why, a name, an error)
 * goes into the fenced data, never here: a summary and an error message sit outside the fence.
 */
export function said(v, re, word) {
  if (typeof v !== 'string') return word;
  const ok = Array.isArray(re) ? re.includes(v) : re.test(v);
  return ok ? v : word;
}
/** How many items a list a computer gave holds, for a summary (an object with its own "length" is no list). */
export const countOf = (v) => (Array.isArray(v) ? v.length : 0);
/** A number a computer gave, for a summary: a finite number or "?". */
export const saidNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');

export const computer = ref('computer', str({ max: 32, pattern: COMPUTER, desc: `Computer name from get_computer_status; omit for this computer ("${LOCAL}").` }));
export const session = ref('session', str({ max: 41, pattern: SESSION, desc: 'Session name exactly as list_sessions showed it.' }));
export const account = str({ max: 32, pattern: ACCOUNT, desc: 'Provider name from get_accounts, or "auto" while Auto mode is on.' });
export const job = ref('job', str({ max: 12, pattern: /^j_[0-9a-f]{10}$/, desc: 'Job id from start_session, start_chat, watch_session or list_sessions.' }));
export const conversation = ref('conversation', str({ max: 36, pattern: UUID, desc: 'Conversation id from list_projects with folder.' }));
export const folder = str({ max: 1024, pattern: ABS, oneLine: true, desc: 'Absolute folder path (or ~/...) inside the folders the dashboard allows.' });

// The coding tools this version offers (src/codetools/offered.mjs, the one switch), by their names in the page.
export const CODING_TOOL_NAMES = Object.freeze({ claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' });
export const toolName = (id) => CODING_TOOL_NAMES[id] || id;
/** A coding tool's name for a summary, from an id another computer gave: only an offered one is named. */
export const saidTool = (id) => (OFFERED.includes(id) ? toolName(id) : 'another coding tool');
/** "a Claude Code …" / "an OpenCode …" */
export const aTool = (id) => `${/^[AEIOU]/.test(toolName(id)) ? 'an' : 'a'} ${toolName(id)}`;
export const codingTool = str({ enum: [...OFFERED], desc: `The coding tool: ${OFFERED.map((id) => `"${id}" (${toolName(id)})`).join(', ')}. Leave it out for Claude Code; give it only when the owner named a coding tool.` });

/**
 * A start of another coding tool may be refused by the computer (not turned on, not installed, no provider for it):
 * the dashboard's own sentence, and where to look next.
 */
export async function startOf(promise, tool) {
  try {
    return await promise;
  } catch (e) {
    if (!tool || tool === 'claude' || e.status !== 400) throw e;
    throw toolError(`${toolName(tool)} could not start (the computer's answer is in the data)`, 'get_computer_status with coding_tools: true shows which coding tools are on and installed there; manage_computer coding_tool turns one on and manage_computer update installs it (both cards), or leave coding_tool out for Claude Code', { error: short(e.message || 'refused', 200) });
  }
}

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
/**
 * After a provider's name in the summary of a start or a move: why it was picked, and where the owner's own name for
 * it is. The owner knows a provider by its label ("Main"), not by its short name; the label is text from the
 * computer's settings, so it stays in the fenced data and the summary only points to it.
 */
export const providerNote = (ctx) => `${ctx.accountWhy ? ` (${ctx.accountWhy})` : ''}${ctx.accountLabel ? '; name it to the owner by its label (account_label in the data)' : ''}`;

export const sessKey = (c, s) => `${c}|${s}`;
export const short = (s, n = 160) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
export const minsAgo = (t, now) => (Number.isFinite(t) && t > 0 ? Math.max(0, Math.round((now - t) / 60_000)) : null);

/** A session card as the dashboard keeps it → its status in the words the model sees. */
export function statusOf(c) {
  if (!isCodingCard(c) && c.kind !== 'chat') return 'shell';
  if (c.limit || c.runLimit) return 'limit';
  if (c.status === 'attention') return 'needs_ok';
  return ['starting', 'working', 'waiting', 'ended'].includes(c.status) ? c.status : 'unknown';
}

/**
 * An error her tools tell her about. `message` and `next` are fixed words and validated ids only (they sit outside
 * the fence); `detail`, when given, is what a computer said in its own words (its error text, a title, a why) and
 * is told inside the fence (core.mjs errorText).
 */
export class ToolError extends Error {
  constructor(message, next, detail) {
    super(message);
    this.next = next;
    if (detail !== undefined) this.detail = detail;
  }
}
export const toolError = (message, next, detail) => new ToolError(message, next, detail);

/** An error as she reads it: this code's own words outside, what a computer said (`detail`) inside the fence. */
export const errorText = (message, next, detail, tool) => `Error: ${message}.${next ? ` Next: ${next}.` : ''}${detail !== undefined ? `\n${fenceData({ tool, said: 'error' }, detail)}` : ''}`;
/** What an error that is not a ToolError said (a route's answer, as a rule): data, never words of the message. */
export const errorDetail = (e) => ({ error: String((e && e.message) || 'unknown error').slice(0, 300) });
/** Any error of a tool's run, as she reads it: a ToolError with its words, any other one only inside the fence. */
export const failedText = (e, tool) => (e instanceof ToolError ? errorText(e.message, e.next, e.detail, tool) : fenceData({ tool, said: 'error' }, errorDetail(e)));

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
