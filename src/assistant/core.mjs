// Tia's core, run INSIDE the dashboard (phase 2 mounts it on /api/assistant/*). Every tool call from any client
// (Tia's own MCP server, the owner's Claude Code or Claude Desktop through `hoprig mcp`) comes here and is
// handled the same way:
//
//   0. Tia is on                           Settings → Tia off → every call refused
//   1. the tool exists                     unknown → error listing the tools
//   2. strict input validation             unknown keys, wrong types → error naming the field
//   3. no secrets in the input             a key/token/password-shaped value → refused (L3 is never by chat)
//   4. ids were shown                      a session/process/conversation/computer/job id this conversation was
//                                          not shown → error naming the tool to call first
//   5. the account                         a start or move uses an account the owner allowed for Tia, picked by
//                                          tia.mjs chooseAccount() when none is named; anything else is refused
//   6. the level                           policy.mjs, from the owner's level (Ask me / Do the work / Hands off)
//                                          and facts looked up here; L2 only STAGES a confirm card, which runs in
//                                          confirm() — reachable only with the owner's login, never Tia's token
//   7. the turn's rules                    a turn woken by a job may act only on that job's sessions, and each
//                                          answer counts against the job's step cap
//
// A result's `audit` (what its act did that the input does not say) goes into the 'done' line of the audit log.
// The core has no I/O of its own: `ops` is the dashboard (OPS in tools.mjs); the card store, job store, skills
// and audit log are injected so tests can drive every rule.
import os from 'node:os';
import { toolOf } from '../automation/cards.mjs';
import { AuditLog } from './audit.mjs';
import { CardError, CardStore } from './cards.mjs';
import { ViewStore, makeCard, shortText, validForm } from './cardkinds.mjs';
import { cardOf, jobProgress, runProgress, needsItems } from './cardmake.mjs';
import { HIDDEN_REMOVED, cleanInput, fence, fenceData, neutralize, stripped } from './fence.mjs';
import { JobStore } from './jobs.mjs';
import { decideLevel } from './policy.mjs';
import { runConfirmed } from './confirmed.mjs';
import { SchemaError, validate } from './schema.mjs';
import { looksSecret, redact, stringsIn } from './secrets.mjs';
import { FIRST_CALL, LOCAL, ShownIds } from './shown.mjs';
import { Skills } from './skills.mjs';
import { namesWord } from './notewords.mjs';
import { nextOf } from './next.mjs';
import { SpendLedger, isPaid, paidName } from './spend.mjs';
import { leftOutOfOrder } from '../autoswitch.mjs';
import { nothingUsableWhy } from '../router.mjs';
import crypto from 'node:crypto';
import { ASSISTANT_NAME, DEFAULTS as TIA_DEFAULTS, autoLeftOut, chooseAccount, freePct, resolveTia, servesTool } from './tia.mjs';
import { OLD_NAMES, ToolError, TOOL_NAMES, byName, statusOf } from './tools.mjs';
import { adminDeletes, wallHeld, wallKind, WALL_TITLE } from '../wall.mjs';
import { sudoArgv } from './adminrefused.mjs';
import { herRightsLevel } from './herrights.mjs';
import { hoprigOwnDirs } from '../paths.mjs';
import { errorDetail, errorText, failedText, toolName } from './toolkit.mjs';
import { wakeMessage, workOf } from './jobs.mjs';
import { placedByRoom, startWhere } from './where-start.mjs';

// A card line is cut here: long enough for the longest value a card shows whole (a Work brief, 4000) with its label.
const LINE_MAX = 4100;
// A card's line and its values for the page hold text from files and sessions (a task's title, a session's report): the
// owner reads them without control characters, direction marks or a forged fence tag, the head kept. Her input is not
// masked: it passed looksSecret, and the card shows what runs on his yes (a brief as the session gets it, MAX_TOKENS=200000
// with its value). What the dashboard read for the card (a process's command line, a chat's OK) is masked (cardLines and
// cardView get a masked copy of the before-state; the before-state itself stays whole for the staleness check and the run).
const deep = (fn) => function each(v) {
  return typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map(each) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, each(x)])) : v;
};
const cardText = (l) => stripped(l).slice(0, LINE_MAX);
const cardValues = deep(cardText);
// What she is told when her input had characters nobody can see and the call ran at once (a card says HIDDEN_REMOVED).
const HIDDEN_TOLD = 'Characters nobody can see were taken out of your input before it was used.';
const maskedRead = deep(redact);
const SESSION_TOOLS = new Set(['send_to_session', 'send_to_chat', 'switch_account', 'stop_session']);
// What a job-woken turn may always do: read, tell the owner, finish the job, stage cards (the owner decides).
const WAKE_OK = new Set(['notify_owner', 'finish_job', 'open_screen', 'watch_session']);

/** Turn an id ref from the schema into the ledger key: sessions and pids are per computer. */
// Everything but a computer, a Claude conversation and a job belongs to one computer: its id is kept with it.
const GLOBAL_KINDS = new Set(['computer', 'conversation', 'job', 'address']);

/**
 * Repository addresses the owner wrote himself (https, ssh, git@host:path, owner/name): his own words, so they may be
 * used as an address argument (a restore). Text from a tool result never adds one this way.
 */
export function addressesIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:https?:\/\/|ssh:\/\/|git@)[^\s<>"'`]+|\b[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\b/g)) out.add(m[0].replace(/[.,;:!?)\]]+$/, ''));
  return [...out].slice(0, 50);
}
const refKey = (r, args) => (GLOBAL_KINDS.has(r.kind) ? r.value : `${args.computer || LOCAL}|${r.value}`);
/** A call names a provider that core picks and checks (a start): a tool's flag, or per action (manage_work start). */
const picks = (tool, args) => (typeof tool.pickAccount === 'function' ? tool.pickAccount(args) : !!tool.pickAccount);
/**
 * The call spends paid usage: it starts or moves work onto a provider billed by use, or types into (or answers in) a
 * session that runs on one. Interrupting, saying no and renaming spend nothing.
 */
function spendsPaid(tool, a, f) {
  const n = tool.name;
  if ((n === 'start_session' || n === 'start_chat' || n === 'switch_account' || (n === 'manage_work' && a.action === 'start')) && f.account && f.account.paid) return true;
  if (!f.session || !f.session.paid) return false;
  if (n === 'send_to_session') return a.text !== undefined || a.continue === true || (a.key !== undefined && a.key !== 'Escape');
  if (n === 'send_to_chat') return a.text !== undefined || (a.answer !== undefined && a.answer !== 'deny');
  // A queued message is typed into the session when it next waits: a message all the same.
  if (n === 'manage_automation') return a.action === 'queue_message';
  return false;
}
// The same start twice (a retry after a timeout, a model that repeats itself) starts once: a start with the very same
// input in the same conversation within REPEAT_MS answers what the first one did. Not a message or a key: the same
// "yes" or "1" to a second question is right, and an answer is tied to the very OK it was judged on (send_to_chat).
const REPEAT_MS = 2 * 60_000;
const REPEATS = new Set(['start_session', 'start_chat']);
const OTHER_COMPUTER_STARTS = new Set(['start_session', 'start_chat']);
// The tools that spend paid usage or send something out of her own context (a message, a start, a move, a note to the
// owner): at most CALLS_PER_HOUR acts of them per conversation an hour, in code (the contract's cap on such tools).
export const CALLS_PER_HOUR = 200;
const CAPPED = new Set(['start_session', 'start_chat', 'send_to_session', 'send_to_chat', 'switch_account', 'notify_owner', 'run_command', 'manage_work']);
/** A call's usual level: an action tool's depends on its action (toolkit.mjs actionTool). */
const baseLevel = (tool, args) => (tool.levelOf ? tool.levelOf(args) : tool.level);

/** The most a result she reads may hold (the contract: at most 20,000 characters, cut in code). */
export const RESULT_MAX = 20_000;
// What call() and confirm() add after a result is rendered (the hidden-characters note, the card line, a repeat's
// sentence): kept free under RESULT_MAX, so the whole text she reads stays within it.
const TAIL_ROOM = 800;
const CUT = (n) => `\n…(${n} more characters cut: ask for less, a narrower filter or fewer lines)\n`;

/**
 * Cut the parts of a result to `max` characters in all: the largest fenced part first, from its end, keeping its
 * opening and closing tags (a cut never breaks a fence). The summary, the first part, is never cut.
 */
export function capParts(parts, max = RESULT_MAX) {
  const out = [...parts];
  const total = () => out.reduce((n, p) => n + p.length, 0) + out.length - 1;
  const emptied = new Set(); // parts cut to nothing: the next largest is cut then
  while (total() > max) {
    let i = -1;
    for (let k = 1; k < out.length; k++) if (!emptied.has(k) && (i < 0 || out[k].length > out[i].length)) i = k;
    if (i < 0) break;
    const p = out[i];
    const open = p.indexOf('>') + 1;
    const close = p.lastIndexOf('</');
    const body = p.slice(open, close);
    const over = total() - max;
    const keep = Math.max(0, body.length - over - 120);
    if (keep >= body.length) {
      emptied.add(i);
      continue;
    }
    out[i] = `${p.slice(0, open)}${body.slice(0, keep)}${CUT(body.length - keep)}${p.slice(close)}`;
    if (keep === 0) emptied.add(i);
  }
  return out;
}

export function render(result, tool, args = null) {
  // The one step that usually follows (next.mjs), in the summary's own part, which a cut never shortens.
  const next = nextOf(tool, args, result);
  const parts = [next ? `${result.summary} Next: ${next}.` : result.summary];
  if (result.data !== undefined) parts.push(fenceData({ tool }, result.data));
  if (result.terminal) parts.push(fence('terminal_output', { session: result.terminal.session }, result.terminal.text));
  if (result.output) parts.push(fence('command_output', { tool }, result.output.text));
  // A brain file and a skill review are someone's text: data, fenced like a screen.
  if (result.file) parts.push(fence('file', { name: result.file.name }, result.file.text, 16_000));
  if (result.review) parts.push(fence('review', { skill: result.review.name }, result.review.text, 16_000));
  if (result.skill) {
    // Skills come from the owner's folder or the shipped pack, never from a session: they are instructions. A
    // forged fence tag inside is still neutralised.
    parts.push(`<skill name="${result.skill.name}">\n${neutralize(result.skill.text, 16_000)}\n</skill>`);
  }
  return capParts(parts, RESULT_MAX - TAIL_ROOM).join('\n');
}

/** A Map that forgets its oldest entry past `max`. */
class BoundedMap extends Map {
  constructor(max) {
    super();
    this.max = max;
  }
  set(k, v) {
    if (!this.has(k) && this.size >= this.max) this.delete(this.keys().next().value);
    return super.set(k, v);
  }
}

/**
 * The line a result ends with when the owner sees it as a card (feature.mjs finds the card by it, in this
 * conversation only). It tells her not to say again in words what the card shows.
 */
// Only the result's LAST line counts: a fenced screen or file before it that holds such a line is never taken for one.
export const VIEW_LINE = /\n\(The owner sees this result as card (v_[0-9a-f]{12}), a [a-z]+ card[^\n]*\)$/;
const viewLine = (card) => `(The owner sees this result as card ${card.id}, a ${card.kind} card that shows it whole and stays up to date. Still answer what he asked, and name what he asked about; only do not read out every item or figure of the card.)`;

export function createAssistantCore({
  ops,
  now = Date.now,
  cards = new CardStore({ now }),
  audit = new AuditLog({ now }),
  skills = new Skills(),
  shown = new ShownIds(),
  jobs = null,
  spend = new SpendLedger({ file: null, now }), // the dashboard passes the one kept in its state folder (feature.mjs)
  views = new ViewStore(),
} = {}) {
  let lastTia = { ...TIA_DEFAULTS };
  jobs ||= new JobStore({ now });
  jobs.settings = () => lastTia; // new jobs take the owner's current caps
  const turns = new Map(); // conversation → { origin: "owner" | "job", job, mode }
  const outcomes = []; // card results waiting to be told to Tia: { conversation, text, card }
  // What a tool showed that a later action of hers relies on (a skill review's name and findings), by computer|id.
  const memo = new BoundedMap(200);
  // The starts she placed by where-start.mjs in the last minutes (in memory): a burst spreads (where.mjs).
  const placed = [];
  // One placement at a time: calls of two conversations (or one turn's parallel calls) overlap, and each must see the
  // starts placed before it, else ten at once all read an empty list and land on the one computer that said "free".
  let placing = Promise.resolve();
  function record(w) {
    if (w && !w.refuse && w.computer) {
      while (placed.length && now() - placed[0].at > 5 * 60_000) placed.shift();
      if (placed.length < 100) placed.push({ name: w.computer, at: now() });
    }
    return w;
  }
  function place(name, args, tia) {
    // Only a start placed by room waits in the chain: every other call, also a start that names its computer, reads no
    // `placed` and goes on at once (a slow lookup on another computer must not hold it back; an undo and a card's Undo
    // at the same moment must not change places). A named start still counts in `placed` once it is known.
    if (!placedByRoom(name, args, tia)) return startWhere({ ops, name, args, tia, placed, now: now() }).then(record);
    const p = placing.then(async () => record(await startWhere({ ops, name, args, tia, placed, now: now() })));
    placing = p.catch(() => {});
    return p;
  }
  const recent = new BoundedMap(500); // conversation|tool|input → { at, text } of an act that ran (REPEATS)
  const counted = new BoundedMap(500); // conversation → times of her capped acts in the last hour (CAPPED)
  // What the owner himself wrote in a conversation (not a tap on an answer she offered, not a job's wake): a start's
  // brief may carry a command or a line of a task's note only when he wrote it (notewords.mjs).
  const heSaid = new BoundedMap(500);
  const repeatKey = (conversation, name, args) => `${conversation}|${name}|${JSON.stringify(args)}`;
  /** A start under way: its key holds the promise of its result text; null when it failed (the key is free again). */
  function underWay(key) {
    let done;
    recent.set(key, { at: now(), text: new Promise((r) => (done = r)) });
    return (text) => {
      if (text === null) recent.delete(key);
      else recent.set(key, { at: now(), text });
      done(text);
    };
  }
  const repeated = (text) => (text === null
    ? { isError: true, text: errorText('the same call came at the same moment as one that failed: nothing was done by this one', 'check the state with list_sessions, then try once more or tell the owner') }
    : { isError: false, text: `${text}\n(The same call came again within ${REPEAT_MS / 60_000} minutes: it was done once, nothing was done again. Next: read_session or list_sessions to see where it is.)` });

  /** Tia's settings, resolved against the accounts of that computer. */
  async function tiaFor(computer = LOCAL) {
    const raw = (await ops.assistantSettings()) || {};
    const accounts = await ops.accounts({ computer });
    lastTia = resolveTia(raw, accounts);
    return lastTia;
  }

  const ctxFor = (conversation, extra = {}) => ({
    now, conversation, skills, jobs, memo, tia: tiaFor, choose: chooseAccount, freePct,
    // A turn a job woke: the owner may not be looking at the conversation (notify_owner pushes its question too).
    woken: turns.get(conversation)?.origin === 'job', heSaid: heSaid.get(conversation) || '', ...extra,
  });

  /**
   * A paid act (`hold`: its ledger id) that went into a chat she started on this computer: its cost is then measured
   * from the chat's own running cost (spend.mjs measureChats) instead of HOLD_USD. A terminal, a chat on another
   * computer, his chat and one on an earlier conversation stay at HOLD_USD.
   */
  function bindSpend(hold, name, args, f, result) {
    try {
      if ((args.computer || LOCAL) !== LOCAL) return;
      const d = (result && result.data) || {};
      if (name === 'start_chat') {
        if (args.conversation || d.already_open || typeof d.session !== 'string') return;
        spend.bind(hold, `${LOCAL}|${d.session}`, 0, true); // a new chat: its only turn so far is this act's
        return;
      }
      // A message (text) carries the chat's id of it: its own turn's end settles its hold (spend.mjs detail()).
      const message = name === 'send_to_chat' && typeof d.message_id === 'string' ? d.message_id : null;
      if (typeof args.session === 'string' && args.session.startsWith('chat:') && f.session && f.session.mine) spend.bind(hold, `${LOCAL}|${args.session}`, f.session.cost || 0, false, message);
    } catch {
      /* the hold stays: the safe side */
    }
  }

  /** The facts policy.mjs needs, looked up by the dashboard (never taken from the model). */
  async function facts(tool, args) {
    const f = { session: null, mine: false, account: null, work: false, herWork: false };
    if (args.session && baseLevel(tool, args) !== 'L0') {
      const list = await ops.listSessions({ computer: args.computer || LOCAL });
      const c = list.find((x) => x.name === args.session && (x.computer || LOCAL) === (args.computer || LOCAL));
      // The session of a Work run (manage_work start) is the owner's: the Work route opened it, and its result is his.
      // By the session itself, not by an active job: the job ends with the run (or at its usage limit), the chat stays.
      f.work = jobs.workSession(args.computer || LOCAL, args.session, c ? c.created : null);
      // The run of a Work task she started (her manage_work start), by its name and when it was made: its OK is hers only
      // while the owner's switch is on (policy.mjs).
      f.herWork = f.work && !!c && jobs.herWorkRun(args.computer || LOCAL, args.session, c.created);
      // codingTool: the session's coding tool (a provider that moves it must serve it); tool, below: the call an OK is about.
      // Its provider is judged by the accounts as the dashboard lists them (paidName), as a start is: a session under Auto
      // spends by use when Auto's order holds a provider billed by use, and one on a stored sign-in when the sign-in
      // check found a Console account's key (the card's own profile does not carry that mark). The card's own facts
      // still count: a provider the list does not hold stays as the card says.
      // A list that cannot be read leaves a session on a provider of its own as its card says (as before); under Auto
      // its order cannot be judged without it, so that error stands.
      let paid = !!(c && c.profile) && c.profile.name !== 'auto' && isPaid(c.profile);
      if (c && c.profile && !paid) {
        const where = { computer: args.computer || LOCAL };
        const acc = c.profile.name === 'auto' ? await ops.accounts(where) : await ops.accounts(where).catch(() => null);
        paid = !!acc && paidName(c.profile.name, acc);
      }
      if (c) f.session = { status: statusOf(c), note: c.note || '', account: c.profile ? c.profile.name : null, paid, cwd: c.cwd || null, screen: '', codingTool: toolOf(c) || 'claude', tool: null, cost: Number.isFinite(c.costTotal) ? c.costTotal : null, mine: c.kind === 'chat' && c.byTia === true };
      // A question of the coding tool itself (trust this folder, Bypass permissions, external imports: askcard.mjs) is
      // read from the screen, not judged: policy.mjs keeps every answer to it for the owner.
      if (f.session && c.askCard && c.askCard.kind === 'notice') f.session.notice = true;
      // A chat (src/chat) has no screen: its card carries the OK it waits for, with what it is really about (the
      // whole command or path, not the model's label of it), whether the chat keeps it for the owner, and its request
      // id (send_to_chat answers that one and no other).
      if (f.session && c.kind === 'chat' && c.ask) {
        f.session.screen = String(c.ask.subject || '');
        f.session.cut = c.ask.cut === true; // only a part of it came: never judged by that part
        f.session.owner = c.ask.owner === true;
        f.session.known = c.ask.known === true; // a call her rules can judge; else (or not said) the OK is the owner's
        f.session.tool = typeof c.ask.tool === 'string' ? c.ask.tool : null; // with its strings, for her allow-list
        f.session.input = c.ask.judged && typeof c.ask.judged === 'object' ? c.ask.judged : null;
        f.session.request = c.ask.request || null;
      }
      // What a permission prompt asks is on the screen, not in the notification: read it, so policy.mjs can judge
      // the request itself (deterministically, not by the model).
      if (f.session && f.session.status === 'needs_ok' && c.kind !== 'chat') {
        try {
          f.session.screen = String(await ops.capture({ computer: args.computer || LOCAL, session: args.session, lines: 15 })).split('\n').slice(-15).join('\n');
        } catch {
          /* gone meanwhile */
        }
      }
      // Hers: a chat by its own mark (a chat id comes back when the owner opens that conversation later, so a mark
      // by name would hand her his chat); a terminal session by the jobs' marks of this very terminal (its name and
      // when it was made: the name of a session that ended is used again).
      f.mine = c && c.kind === 'chat' ? c.byTia === true : !!c && jobs.startedByTia(args.computer || LOCAL, args.session, c.created);
    }
    // An administrator command of run_command (sudo and the other escalators): the owner's Tia administrator-rights
    // level decides it (policy.mjs). Which commands are administrator commands is the wall's
    // one reader (wallKind), and the forms refused at every level are adminRefusal's — no second reader
    // here. The Hoprig folders those forms protect are the dashboard's own, read at call time so adminrefused reads
    // no real path of its own.
    if (tool.name === 'run_command' && typeof args.command === 'string' && wallKind(args.command) === 'admin') {
      // What is refused at every level, with no card: a form of the list (adminRefusal), a line that joins the
      // administrator command with another, and a form that is not a plain `sudo <program> <arguments>` (an
      // administrator command inside another command's text, or behind a program in front of sudo). sudoArgv asks
      // all three, so no card is ever made for a command its own tap could not run.
      const cwd = typeof args.folder === 'string' ? args.folder : null;
      const refusedWhy = sudoArgv(args.command, { hoprigDirs: hoprigOwnDirs(), home: os.homedir(), cwd }).refuse || null;
      const level = herRightsLevel(await ops.settings({ computer: args.computer || LOCAL }));
      // What the command is BESIDE an administrator command, by the wall's own reading of it: a release, a pull
      // request, a deploy, a delete. An administrator command never hides what it does, so each stays the owner's
      // card at Full, as it is in a session of hers.
      const held = wallHeld({ tool: 'Bash', input: { command: args.command }, cwd });
      const also = held ? [...new Set((held.acts || [held]).filter((a) => a.kind !== 'admin').map((a) => WALL_TITLE[a.why] || WALL_TITLE[a.kind] || a.kind))] : [];
      // A delete as administrator (or a program that destroys what it is pointed at) is the owner's at every level:
      // the policy makes it his card at Full too, as the wall does in a session of hers.
      f.admin = { isAdmin: true, refusedWhy, level, deletes: adminDeletes(args.command), also };
      // Ask and Full look up whether this computer's sudo asks a password (the Ask card's field; Full runs
      // cardless only where it does not). Full also counts her administrator run_command acts in the audit log of the
      // last hour, so beyond the hour's limit (FULL_ADMIN_PER_HOUR) a command falls back to the owner's card even at
      // Full — a runaway of hers cannot cost the work. Looked up by the dashboard, never from the model, and only where
      // it matters so Off and a refused form read nothing.
      if (!refusedWhy && (level === 'ask' || level === 'full')) {
        f.admin.needsPassword = await ops.adminNeedsPassword({ computer: args.computer || LOCAL });
        if (level === 'full') {
          // The window is wall-clock: it counts the done administrator runs whose `at` is within the last hour of
          // now(). This assumes the clock is not moved. At Full a cardless `sudo date -s` into the future would push
          // the earlier runs out of the window and let more than FULL_ADMIN_PER_HOUR run in a real hour. It is a soft
          // runaway guard, not a safety floor (the forms that could escalate are refused at every level), so it is
          // left as wall-clock; a clock-proof window would have to persist a start that cannot move backward.
          const hourAgo = now() - 3600_000;
          f.admin.ranLastHour = audit.since(hourAgo).filter((e) => e && e.tool === 'run_command' && e.outcome === 'done'
            && e.level === 'L1'
            && e.input && typeof e.input.command === 'string' && wallKind(e.input.command) === 'admin').length;
        }
      }
    }
    return f;
  }

  /** start_session / start_chat / switch_account: fill in the account (Tia's choice when none is named) and its facts. */
  async function pickAccount(tool, args, f, tia) {
    const accounts = await ops.accounts({ computer: args.computer || LOCAL });
    // The coding tool the provider must serve: the one a start names (else Claude Code), or the moving session's own.
    const need = args.coding_tool || (f.session && f.session.codingTool) || 'claude';
    let why = null;
    if (!args.account) {
      const current = f.session && f.session.account;
      const pool = current ? { ...accounts, profiles: (accounts.profiles || []).map((p) => (p.name === current ? { ...p, limited: p.limited || { until: null } } : p)) } : accounts;
      const tiaPool = current ? { ...tia, allowed: tia.allowed.filter((n) => n !== current) } : tia;
      const pick = chooseAccount(tiaPool, pool, need);
      if (pick.error) {
        // The way out names the cause: Auto mode's own (the router's words after its reason), more providers, and a
        // reset only where a limit holds.
        const autoOut = need === 'claude' && tiaPool.allowed.includes('auto') ? autoLeftOut(pool) : null;
        const autoWhy = autoOut && nothingUsableWhy(leftOutOfOrder(pool));
        const autoWay = autoOut ? (autoWhy ? autoWhy.slice(autoOut.length + 2) : 'run: hoprig auto order <provider> <provider>') : null;
        const ways = [autoWay, 'allow more providers in Settings → Tia (open_screen "settings/tia")', / at its limit/.test(pick.error) ? 'wait for a reset' : null];
        throw new ToolError(pick.error, `tell the owner; he can ${ways.filter(Boolean).join(', or ')}`);
      }
      args.account = pick.account;
      why = `picked by ${ASSISTANT_NAME}: ${pick.why}`;
    }
    const p = args.account === 'auto' ? { name: 'auto', kind: 'auto' } : (accounts.profiles || []).find((x) => x.name === args.account);
    if (!p) throw new ToolError(`there is no provider "${args.account}"`, 'call get_computer_status with providers: true for the names, or leave account out');
    // A new session or chat runs the coding tool it names; a session that moves stays in its coding tool.
    if (!servesTool(p, need)) throw new ToolError(`the provider "${p.name}" does not serve ${toolName(need)}`, `pick a provider whose tools in get_computer_status providers include ${need}, or leave account out`);
    f.account = { name: p.name, kind: p.kind, paid: paidName(p.name, accounts), label: p.label || null, allowed: tia.allowed.includes(p.name), why };
    // Under Auto mode, the labels of his own providers for the card's sentence: the first of its order the session starts
    // on, and the ones billed by use it may move onto at a limit (never fixed names).
    if (p.name === 'auto') {
      const byName = new Map((accounts.profiles || []).map((x) => [x.name, x]));
      // The order the router really uses (autoswitch.mjs leftOutOfOrder by this computer's list): a provider that is
      // gone, does not serve Claude Code, or is billed by use while "Also use pay-per-use providers" is off is not in it.
      const out = new Set(leftOutOfOrder(accounts).map((x) => x.name));
      const order = (accounts.autoSwitch && Array.isArray(accounts.autoSwitch.order) ? accounts.autoSwitch.order : []).filter((n) => !out.has(n)).map((n) => byName.get(n)).filter(Boolean);
      const labelOf = (x) => String(x.label || x.name).slice(0, 60);
      // The provider the session starts on, only when it comes before every paid one: the router serves the first
      // request with the first of the order it may use, so a paid key first spends from the start. One at its limit
      // (`limited` is set only while the limit holds) is passed over by the router, so it is not the one named.
      const firstPaid = order.findIndex((x) => paidName(x.name, accounts));
      const first = (firstPaid < 0 ? order : order.slice(0, firstPaid)).find((x) => !paidName(x.name, accounts) && !x.limited);
      f.account.order = { first: first ? labelOf(first) : null, paid: order.filter((x) => paidName(x.name, accounts)).map(labelOf) };
    }
    return why;
  }

  function wakeRule(conversation, tool, args, level) {
    const turn = turns.get(conversation);
    if (!turn || turn.origin !== 'job') return null;
    if (level === 'L0' || WAKE_OK.has(tool.name)) return null;
    const job = jobs.get(turn.job);
    const inJob = job && args.session && job.sessions.some((e) => e.session === args.session && e.computer === (args.computer || LOCAL));
    if (!SESSION_TOOLS.has(tool.name)) return level === 'L2' ? null : [`during a job wake-up ${ASSISTANT_NAME} may only act on that job's sessions`, 'notify_owner with what you suggest'];
    // A job that follows a Work run only reads and reports: the run's session is the owner's, and a turn typed into it
    // after the run was settled is in no run record.
    // With the owner's switch on, a wake for the run's OK (mode "answer") may allow it, nothing else; policy.mjs judges
    // that answer again.
    const herAnswer = job && job.work && turn.mode === 'answer' && tool.name === 'send_to_chat' && args.answer === 'allow';
    if (job && job.work && !herAnswer) return [`the session of a Work run is the owner's: ${ASSISTANT_NAME} does not act on it`, 'read the run (manage_work action run) and tell the owner'];
    if (!inJob) return [`during this wake-up you may only act on the sessions of job ${turn.job}`, 'notify_owner about anything else'];
    if (turn.mode !== 'answer') return [`job ${turn.job} used all its answers`, 'notify_owner with the question and your suggested answer'];
    if (level !== 'L2' && !jobs.step(turn.job)) return [`job ${turn.job} used all its ${job.maxSteps} answers`, 'notify_owner and let the owner decide'];
    return null;
  }

  /**
   * Handle one tool call. opts: { conversation, actor }. Returns { text, isError, card?, ui? } — never throws for
   * anything the caller did; a failure in a handler becomes a plain error result too.
   */
  async function call(name, rawArgs, { conversation = 'direct', actor = 'assistant', undoOf = null, door: via = 'team' } = {}) {
    // An old name answers as the tool it became, through this same door (its input is cleaned and checked there).
    const old = OLD_NAMES.get(name);
    if (old) {
      const r = await call(old.tool, old.args(rawArgs), { conversation, actor });
      return { ...r, text: `${r.text}\n${old.note}` };
    }
    const tool = byName.get(name);
    if (!tool) return { isError: true, text: errorText(`there is no tool "${String(name).slice(0, 40)}"`, `use one of: ${TOOL_NAMES.join(', ')}`) };
    let args;
    let refs;
    // Her input is cleaned once, here: the card shows and the run sends that one value, byte for byte (a text with
    // hidden characters cannot say one thing to the owner and another to a session). A card says when it was cleaned.
    const door = cleanInput(rawArgs);
    try {
      ({ value: args, refs } = validate(tool.input, door.value));
      if (tool.check) tool.check(args, ctxFor(conversation));
    } catch (e) {
      // A tool may name the one call that recovers from a wrong field (recover); else the generic step.
      if (e instanceof SchemaError) return { isError: true, text: errorText(`invalid input for ${name}: ${e.message}`, tool.recover?.(e.path, rawArgs) || 'fix that field and call again (see the tool schema)') };
      if (e instanceof ToolError) return { isError: true, text: errorText(e.message, e.next, e.detail, name) };
      throw e;
    }
    // A question with answers as buttons shows her words as they are: one with characters nobody can see is refused,
    // as Do it's brief refuses one, so the owner never taps an answer that says more than he sees.
    if (door.changed && tool.refuseHidden?.(args)) return { isError: true, text: errorText(`${name}: a text of yours has characters nobody can see (direction marks, zero-width or tag characters)`, 'write it again in plain characters and call again') };
    const log = (outcome, extra = {}) => (extra.level || baseLevel(tool, args)) !== 'L0' && audit.append({ actor, door: via, conversation, tool: name, level: extra.level || baseLevel(tool, args), input: args, outcome, ...extra });

    if (stringsIn(args).some(looksSecret)) {
      log('refused', { error: 'secret-shaped input' });
      return { isError: true, text: errorText('that input looks like a key, token or password; secrets never go through the assistant', 'the owner enters secrets himself: open_screen "providers" (sign-ins and keys) or "settings/security" (the password)') };
    }
    const miss = shown.missing(conversation, refs.map((r) => ({ ...r, value: refKey(r, args) })));
    if (miss) {
      const raw = refs.find((r) => refKey(r, args) === miss.value)?.value ?? miss.value;
      // A name the owner said may be a session's and was taken for a computer's: the step that recovers shows both.
      const first = miss.kind === 'computer'
        ? 'call list_sessions with no computer first: it shows every session with its computer (the name may be a session\'s, not a computer\'s); get_computer_status with no computer lists the computers'
        : `call ${FIRST_CALL[miss.kind]} first`;
      return { isError: true, text: errorText(`${miss.kind} "${String(raw).slice(0, 60)}" was not shown to you in this conversation (ids only come from tool results, never from screen text)`, first) };
    }

    try {
      let tia = await tiaFor(args.computer || LOCAL);
      if (!tia.enabled) return { isError: true, text: errorText(`${ASSISTANT_NAME} is turned off`, 'the owner can turn her on in Settings → Tia') };
      // Where a start goes, only while he chose computers for her (Settings → Tia): else exactly as before.
      const where = await place(name, args, tia);
      if (where && where.refuse) {
        log('refused', { error: where.refuse });
        return { isError: true, text: errorText(where.refuse, where.next) };
      }
      // Placed by room on a computer he chose under Settings → Tia: that list is his choice of computer.
      let byRoom = false;
      if (where) {
        if (where.computer !== LOCAL && args.computer !== where.computer) {
          args.computer = where.computer;
          byRoom = true;
          tia = await tiaFor(args.computer);
        }
      }
      const f = await facts(tool, args);
      // What only the dashboard knows for this call (a project's unpublished commits …), for policy.mjs.
      // heLast: his message of this turn (none in a job's turn), for a rule that asks whether he named what is changed.
      if (tool.facts) f.extra = await tool.facts(ops, args, ctxFor(conversation, { heLast: turns.get(conversation)?.origin === 'owner' ? turns.get(conversation).text : null }));
      const accountWhy = picks(tool, args) ? await pickAccount(tool, args, f, tia) : null;
      // undoOf: Undo from a card takes back the act that card names and no other (worktool.mjs checks it right before it acts).
      // heLast: his message of the turn this call is made in (none in a job's turn or at his tap on a card).
      const turn = turns.get(conversation);
      const ctx = ctxFor(conversation, { accountWhy, accountKind: f.account ? f.account.kind : null, accountLabel: f.account ? f.account.label : null, heLast: turn && turn.origin === 'owner' ? turn.text : null, ...(undoOf ? { undoOf } : {}) });
      // The computer a start on another computer names, looked up here, before the repeat check: an await between that
      // check and the mark below would let two identical starts both pass it.
      const otherComputer = OTHER_COMPUTER_STARTS.has(name) && args.computer && args.computer !== LOCAL && turn?.origin === 'owner' && !byRoom
        ? { c: (await ops.computers().catch(() => [])).find((x) => x.name === args.computer) }
        : null;
      // The same start again (a retry, two at once): answered from the first one before any hold, count or card, so a
      // repeat never takes a second hold and never becomes a card whose tap would start it twice. From here to the
      // run nothing awaits: the check, the hold and the mark of a start under way are one step.
      const key = REPEATS.has(name) ? repeatKey(conversation, name, args) : null;
      const was = key && recent.get(key);
      if (was && now() - was.at < REPEAT_MS) return repeated(await was.text);
      let d = decideLevel(tool, args, f, tia);
      if (d.refuse) {
        log('refused', { error: d.refuse });
        return { isError: true, text: errorText(d.refuse, d.next) };
      }
      const rule = wakeRule(conversation, tool, args, d.level);
      if (rule) {
        log('refused', { error: rule[0] });
        return { isError: true, text: errorText(rule[0], rule[1]) };
      }
      // The call cap before the hold: a refused act holds nothing.
      const capped = CAPPED.has(name) && d.level !== 'L0' && d.level !== 'L2';
      const times = capped ? (counted.get(conversation) || []).filter((t) => t > now() - 3600_000) : [];
      if (capped && times.length >= CALLS_PER_HOUR) {
        log('refused', { error: 'call cap' });
        return { isError: true, text: errorText(`${ASSISTANT_NAME} made ${CALLS_PER_HOUR} starts, messages and notes in this conversation in the last hour, the most she may`, 'notify_owner is refused too: stop and tell the owner in your answer what you would do next') };
      }
      // Paid usage without his tap only inside the daily limit for paid use he set (the contract's paid-cap): checked and
      // held here, where the request is made, in one step; no such limit, or the limit reached, and the act is a card.
      // A start on another computer that the owner did not name in this conversation (she found a project there by
      // herself): his tap first, so work never begins on a computer he did not choose.
      if (d.level !== 'L2' && otherComputer) {
        const { c } = otherComputer;
        const words = heSaid.get(conversation) || '';
        if (![args.computer, c && c.label].some((w) => w && namesWord(words, w))) d = { level: 'L2', why: `the owner did not name the computer ${args.computer} in this conversation` };
      }
      let hold = null;
      if (d.level !== 'L2' && spendsPaid(tool, args, f)) {
        hold = `act-${crypto.randomBytes(6).toString('hex')}`;
        const why = spend.take(tia.dailyCapUsd, { id: hold });
        if (why) {
          d = { level: 'L2', why };
          hold = null;
        }
      }
      if (d.level !== 'L2') {
        if (capped) counted.set(conversation, [...times, now()]);
        const settle = key ? underWay(key) : null;
        ctx.judged = f.session; // what the level was decided on (an answer goes to that OK, no other)
        const undoBefore = undoTop(conversation);
        let result;
        try {
          result = await tool.run(ops, args, ctx);
        } catch (e) {
          settle?.(null);
          throw e;
        }
        if (hold) bindSpend(hold, name, args, f, result);
        if (result.shown) shown.add(conversation, result.shown);
        if (where && result.summary) {
          result.summary = `${result.summary} Where: ${where.place}, because ${where.why}; say so to the owner in one clause, with the computer's name as written here.`;
          result.data = { ...(result.data || {}), where_why: where.why, where_computer: args.computer || LOCAL };
        }
        // An answer of hers in the run of a Work task she started (the owner's switch): Activity says so, with what it
        // asked, in the dashboard's own words (shortText masks paths and secrets).
        const herOk = f.herWork && name === 'send_to_chat' && args.answer && f.session ? { herWork: true, asked: shortText(f.session.screen, 200) } : null;
        const audited = herOk ? { ...(result.audit || {}), ...herOk } : result.audit;
        log('done', { level: d.level, ...(where ? { result: { ...(audited || {}), computer: args.computer || LOCAL, where: where.why } } : audited ? { result: audited } : {}) });
        const view = viewOf(name, args, result, conversation, undoBefore);
        const text = `${render(result, name, args)}${door.changed ? `\n${HIDDEN_TOLD}` : ''}${view ? `\n${viewLine(view)}` : ''}`;
        settle?.(text);
        return { isError: false, text, ...(result.ui ? { ui: result.ui } : {}), ...(view ? { view } : {}) };
      }
      const before = await tool.before(ops, args, ctx);
      const read = maskedRead(before);
      const lines = [...(d.why ? [`Why a card: ${d.why}`] : []), ...(where ? [`Where: ${where.place}, because ${where.why}`] : []), ...(accountWhy ? [`Provider ${f.account && f.account.label ? `${f.account.label} (${args.account})` : args.account}: ${accountWhy}`] : []), ...tool.cardLines(args, read), ...(door.changed ? [HIDDEN_REMOVED] : [])].map(cardText);
      // The values the page says in its own words (a Work card: the task's title, the brief whole); the lines stay the record.
      const view = tool.cardView ? cardValues(tool.cardView(args, read)) : null;
      // A value the owner may change before his OK (change_setting): a form, checked again at the tap.
      const form = tool.cardForm ? tool.cardForm(args, read) : null;
      const card = cards.stage({ tool: name, input: args, lines, before, conversation, ...(view ? { view } : {}), ...(form && validForm(form) ? { form } : {}) });
      // A card about a task (Work) names it by its title in Activity, as the card does: its id may be cut off.
      log('staged', { card: card.id, level: 'L2', ...(view && typeof view.title === 'string' && view.title ? { result: { title: view.title } } : {}) });
      return {
        isError: false,
        card,
        text: `Waiting for the owner's OK (card ${card.id}, expires in ${Math.round((card.expiresAt - card.createdAt) / 60_000)} min). Nothing has been done yet. Next: tell the owner in one line what you proposed and why; you will be told the outcome.\n${fenceData({ tool: name }, { card: card.id, shows: lines })}`,
      };
    } catch (e) {
      if (e instanceof ToolError) {
        log('failed', { error: e.message });
        return { isError: true, text: errorText(e.message, e.next, e.detail, name) };
      }
      log('failed', { error: e.message });
      return { isError: true, text: errorText(`${name} failed (what the dashboard said is in the data)`, e.status === 404 ? 'call list_sessions or get_computer_status to see what exists now' : 'check the state with a read tool, then try once more or tell the owner', errorDetail(e), name) };
    }
  }

  /**
   * The owner tapped Confirm. Re-validates the stored input, re-reads the before-state, and runs the action only
   * when the card is pending, unexpired, unused and the state hashes the same. Only the owner's own login may
   * reach this (phase 2: cookie session, never a bearer token).
   */
  async function confirm(id, values = null) {
    const card = cards.get(id);
    if (!card) return { ok: false, error: 'there is no such card' };
    const tool = byName.get(card.tool);
    // The owner changed a value of a form card: it is checked as her input is (the schema, the tool's own check, no
    // secret), and only a field the form offers to change can change; else nothing runs and the card stays as it was.
    // The changed input stays in this call until the card is taken: a second confirm (another tab) never rewrites a card
    // this one is already running, and the card's record says the value that ran.
    let input = card.input;
    let line = null;
    let adminPassword = null;
    // A secret field (an administrator password) is never an ordinary form value: it must reach no `input`,
    // no "changed by the owner" line, no audit entry and no card record. Pull it out of the confirm values here, before
    // the form merge, check it is a bounded string, and carry it only on ctx to the act (ctx.adminPassword below); the
    // rest of the values flow on as before. The act (run_command) gives it to sudo's input and scrubs it (adminrun.mjs).
    if (values && card.form && card.form.fields.some((f) => f.type === 'password')) {
      const secret = new Set(card.form.fields.filter((f) => f.type === 'password').map((f) => f.name));
      const plain = {};
      for (const [k, val] of Object.entries(values)) {
        if (!secret.has(k)) { plain[k] = val; continue; }
        if (val != null && (typeof val !== 'string' || val.length > 1024)) return { ok: false, error: 'that value is not allowed', code: 'refused' };
        if (k === 'admin_password' && typeof val === 'string' && val.length) adminPassword = val;
      }
      values = plain;
    }
    if (values && card.form) {
      const changed = Object.entries(values).filter(([k]) => card.form.fields.some((f) => f.name === k && f.type !== 'readonly'));
      if (changed.length !== Object.keys(values).length) return { ok: false, error: 'only the fields the card offers can change', code: 'refused' };
      if (changed.length) {
        try {
          const next = { ...card.input };
          for (const [k, v] of changed) next[k] = tool.formValue ? tool.formValue(k, v, card.input) : v;
          const ok = validate(tool.input, next).value;
          if (tool.check) tool.check(ok, ctxFor(card.conversation));
          if (stringsIn(ok).some(looksSecret)) throw new ToolError('that value looks like a key, token or password', 'enter secrets on their own page');
          input = ok;
          line = `Changed by the owner before his OK: ${changed.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}`.slice(0, LINE_MAX);
        } catch (e) {
          if (e instanceof SchemaError || e instanceof ToolError) return { ok: false, error: `that value is not allowed: ${e.message}`, code: 'refused' };
          throw e;
        }
      }
    }
    const conversation = card.conversation;
    const log = (outcome, extra = {}) => audit.append({ actor: 'owner', conversation, tool: card.tool, level: 'L2', input, outcome, card: id, ...extra });
    let args;
    let before;
    let ctx;
    try {
      args = validate(tool.input, input).value;
      ctx = ctxFor(conversation);
      if (tool.check) tool.check(args, ctx);
      if (picks(tool, args)) {
        // The account must still exist and still be allowed; its kind is part of the before-state.
        const tia = await tiaFor(args.computer || LOCAL);
        const f = await facts(tool, args);
        await pickAccount(tool, args, f, tia);
        if (!f.account.allowed) throw new Error(`provider ${args.account} is no longer allowed for ${ASSISTANT_NAME}`);
        ctx = ctxFor(conversation, { accountKind: f.account.kind, accountLabel: f.account.label });
      }
      before = await tool.before(ops, args, ctx);
      ctx.before = before; // what the card showed and the owner confirmed (an answer goes to that OK, no other)
      // The secret pulled from the confirm values (an administrator password) reaches the act only here,
      // on ctx: never in input, the audit, the card record or a "changed" line. null for every other card.
      ctx.adminPassword = adminPassword;
    } catch (e) {
      if (cards.get(id)?.status === 'pending') cards.markStale(id);
      log('stale', { error: e.message });
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}), but it could not run. Nothing was done.\n${failedText(e, card.tool)}`);
      return { ok: false, error: e.message, code: 'stale' };
    }
    // A paid act of his tap is counted in today's sum (never checked against the cap: his tap is the approval). The
    // facts are read before the card is taken, so nothing awaits between taking it and running its act.
    let paidTap = null;
    try {
      const pf = await facts(tool, args);
      if (picks(tool, args)) await pickAccount(tool, args, pf, await tiaFor(args.computer || LOCAL));
      if (spendsPaid(tool, args, pf)) paidTap = pf;
    } catch {
      paidTap = null; // what it would spend cannot be told: the act's own checks below decide whether it runs
    }
    const key = REPEATS.has(card.tool) ? repeatKey(conversation, card.tool, args) : null;
    const was = key && recent.get(key);
    if (was && now() - was.at < REPEAT_MS) {
      if (cards.get(id)?.status === 'pending') cards.markStale(id);
      log('stale', { error: 'the same start ran a moment ago' });
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}), but the very same start ran a moment ago: nothing was started again.`);
      return { ok: false, error: 'the same start ran a moment ago: nothing was started again', code: 'stale' };
    }
    try {
      cards.take(id, before, line ? { input, line } : null);
    } catch (e) {
      if (!(e instanceof CardError)) throw e;
      log(e.code === 'stale' ? 'stale' : e.code, { error: e.message });
      if (e.code === 'stale') tell(conversation, id, `Card ${id} (${card.tool}) did not run: the state changed after it was made. Nothing was done; look again before proposing it anew.`);
      return { ok: false, error: e.message, code: e.code };
    }
    log('confirmed');
    const settle = key ? underWay(key) : null;
    try {
      const undoBefore = undoTop(conversation);
      if (paidTap) spend.tapped(id);
      const result = await runConfirmed({ id, tool: card.tool, input: args }, () => tool.run(ops, args, ctx));
      if (paidTap) bindSpend(id, card.tool, args, paidTap, result);
      settle?.(render(result, card.tool, args));
      if (result.shown) shown.add(conversation, result.shown);
      cards.finish(id, { ok: true, summary: result.summary });
      log('done', result.audit ? { result: result.audit } : {});
      // What the act did, as a card under the one he confirmed (a start: its progress, which follows the job or run).
      const view = viewOf(card.tool, args, result, conversation, undoBefore);
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}). ${render(result, card.tool, args)}${view ? `\n${viewLine(view)}` : ''}`);
      // A card whose act is to open a sheet for the owner (manage_project drop, group_add): the page opens it.
      return { ok: true, summary: result.summary, ...(view ? { view } : {}), ...(result.ui && result.ui.open ? { open: result.ui.open } : {}) };
    } catch (e) {
      settle?.(null);
      // A wrong password ran nothing and is tried again on the same card: keep it pending with its full time, rather
      // than finishing it and sending the owner back to Tia; he only types the password again.
      // The reset expiry goes back with the answer so the page's countdown matches the server's new window (else it
      // keeps the old expiry and can read 'expired' while the retyped password still works).
      if (e.wrongPassword) {
        const kept = cards.keepPending(id);
        if (kept) {
          log('failed', { error: e.message });
          return { ok: false, error: e.message, code: 'wrong-password', expiresAt: kept.expiresAt };
        }
      }
      cards.finish(id, { ok: false, error: e.message });
      log('failed', { error: e.message });
      tell(conversation, id, `The owner confirmed card ${id} (${card.tool}), but it failed.\n${failedText(e, card.tool)}`);
      return { ok: false, error: e.message };
    }
  }

  /** Her newest act of this conversation that undo would take back (worktool.mjs keeps them in memo). */
  function undoTop(conversation) {
    const s = memo.get(`undo|${conversation}`);
    return s && s.length ? s[s.length - 1] : null;
  }

  /** The card a result shows the owner (cardmake.mjs), checked (cardkinds.mjs) and kept; null: plain text. */
  function viewOf(name, args, result, conversation, undoBefore) {
    // Only a conversation of the dashboard's page shows cards: her tools in the owner's own MCP client do not.
    if (conversation === 'direct' || conversation.startsWith('client-')) return null;
    try {
      const made = cardOf(name, args, result, { now, jobs, undoTop: () => undoTop(conversation), undoBefore });
      const card = made && makeCard(made.kind, made.fields, now());
      return card ? views.add(conversation, card, made.hidden || {}) : null;
    } catch {
      return null; // a card is a help, never a reason for a result to fail
    }
  }

  /**
   * The dynamic cards `ids` as they are NOW, read from their subjects: a job from the job store, a Work run from its
   * route, attention items from the list (by id; one that left the list is marked gone). A session's and a computer's
   * card follow the page's own poller (web/store.js) and are not read here. → { <id>: card | null (no such card) }; a
   * card whose subject could not be read now comes as it was last read (its `at`) with `unread: true`.
   */
  async function refreshViews(ids) {
    const out = {};
    // The attention list once per kind a card was read with: the route filters by kind before it cuts to its first items,
    // so a card of one kind is never re-read against the first items of the whole list.
    const attention = new Map();
    const listOf = (kind) => {
      if (!attention.has(kind)) attention.set(kind, ops.attention({ computer: LOCAL, kind }));
      return attention.get(kind);
    };
    for (const id of ids) {
      const v = views.get(id);
      if (!v) {
        out[id] = null;
        continue;
      }
      const c = v.card;
      let fields = null;
      try {
        if (c.kind === 'progress' && c.subject.type === 'job') {
          const j = jobs.get(c.subject.id);
          fields = j ? jobProgress(j) : { ...stripCard(c), state: 'gone' };
        } else if (c.kind === 'progress' && c.subject.type === 'run') {
          const r = ((await ops.workRuns({ computer: c.subject.computer, id: c.subject.id })).runs || []).find((x) => x.id === c.subject.id);
          fields = r ? runProgress(r, c.subject.computer) : { ...stripCard(c), state: 'gone' };
        } else if (c.kind === 'needs') {
          const list = await listOf(v.hidden.kind || null);
          const now2 = list.items || [];
          // Not among the items sent while the route held more back: not known to be gone, so it stays as it was.
          const cut = Number.isInteger(list.more) && list.more > 0;
          const items = c.items.map((it) => {
            const cur = now2.find((x) => x.id === it.id);
            return cur ? needsItems([cur], list.acts || {})[0] : cut ? it : { ...it, gone: true };
          });
          fields = { items, total: Number.isInteger(list.count) ? list.count : now2.length, all: c.all };
        }
      } catch {
        // Not readable now: the card as it was last read, marked so; the page says it could not be read and when it was.
        out[id] = { ...v.card, unread: true };
        continue;
      }
      const card = fields && makeCard(c.kind, fields, now());
      if (card) {
        card.id = c.id;
        v.card = card;
      }
      out[id] = v.card;
    }
    return out;
  }
  const stripCard = (c) => {
    const { kind, id, at, ...fields } = c;
    return fields;
  };

  /**
   * The owner tapped Undo on a result card: it takes back her act the card is about, only while that act is still her
   * newest one in that conversation and the task is still as she left it (worktool.mjs), once.
   */
  async function undoView(id) {
    const v = views.get(id);
    if (!v || v.card.kind !== 'result' || !v.hidden.undo) return { ok: false, code: 'none', error: 'this card has no Undo' };
    if (v.hidden.used) return { ok: false, code: 'used', error: 'it was taken back already', card: v.card };
    // Taken back already (by her own undo): the tap says so, and the card turns into "Taken back" (worktool.mjs).
    if (!v.hidden.undo.undone && undoTop(v.conversation) !== v.hidden.undo) return { ok: false, code: 'stale', error: `${ASSISTANT_NAME} changed something after this, so it is not taken back from here`, card: v.card };
    v.hidden.used = true; // before the first await: a second tap, also from another tab, finds it used
    // Undo itself finds the computer of the act it takes back (worktool.mjs).
    const r = await call('manage_work', { action: 'undo' }, { conversation: v.conversation, actor: 'owner', undoOf: v.hidden.undo });
    const why = r.isError ? r.text.split('\n')[0].replace(/^Error: /, '').replace(/\. Next: .*$/, '').replace(/\.$/, '') : '';
    // Spent only when it is over: taken back, or the record was dropped because the task changed. A failure that passes
    // (she is off, the settings or the task list could not be read) leaves the card's Undo as it was, for another tap.
    const over = !r.isError || !(memo.get(`undo|${v.conversation}`) || []).includes(v.hidden.undo);
    if (!over) {
      v.hidden.used = false;
      return { ok: false, code: 'failed', error: why, card: v.card };
    }
    const { undo, ...rest } = stripCard(v.card);
    const card = makeCard('result', { ...rest, ok: !r.isError, title: r.isError ? `Not taken back: ${rest.title}`.slice(0, 160) : `Taken back: ${rest.title}`.slice(0, 160), changed: r.isError ? [shortText(why, 160)].filter(Boolean) : [] }, now());
    if (card) {
      card.id = v.card.id;
      v.card = card;
    }
    tell(v.conversation, null, `The owner tapped Undo on card ${id}. ${r.text.split('\n')[0]}`);
    return r.isError ? { ok: false, code: 'stale', error: why, card: v.card } : { ok: true, card: v.card };
  }

  function reject(id) {
    try {
      const c = cards.reject(id);
      audit.append({ actor: 'owner', conversation: c.conversation, tool: c.tool, level: 'L2', input: c.input, outcome: 'declined', card: id });
      tell(c.conversation, id, `The owner declined card ${id} (${c.tool}). Do not propose it again unless he asks.`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** The owner stops a job from the Tia tab. */
  function stopJob(id) {
    const j = jobs.get(id);
    if (!j) return { ok: false, error: 'there is no such job' };
    jobs.finish(id, 'stopped', 'stopped by the owner');
    audit.append({ actor: 'owner', conversation: j.conversation, tool: 'stop_job', level: 'L1', input: { job: id }, outcome: 'done' });
    tell(j.conversation, null, `The owner stopped job ${id}. Do not continue it.`);
    return { ok: true };
  }

  function tell(conversation, card, text) {
    outcomes.push({ conversation, card, text });
    if (outcomes.length > 500) outcomes.shift();
  }

  /** Card outcomes for one conversation, oldest first, removed as they are taken (the engine tells Tia). */
  function takeOutcomes(conversation) {
    const mine = outcomes.filter((o) => o.conversation === conversation);
    for (const o of mine) outcomes.splice(outcomes.indexOf(o), 1);
    return mine;
  }

  /**
   * One watcher tick: which jobs need Tia. Returns [{ conversation, job, reason, mode, message }]; the engine
   * starts each turn with beginTurn(conversation, { origin: "job", job, mode }) and sends `message` as the user
   * turn. The job's session counts as shown to that conversation. Nothing runs while Tia is off.
   */
  async function jobTick(sessionCards, screenOf = async () => '') {
    const tia = await tiaFor(LOCAL);
    if (!tia.enabled) return [];
    const out = [];
    for (const ev of jobs.tick(sessionCards, { answersHers: tia.answersHers === true })) {
      const conv = ev.job.conversation;
      if (ev.entry) shown.add(conv, { session: [`${ev.entry.computer}|${ev.entry.session}`], computer: [ev.entry.computer], job: [ev.job.id] });
      // A job that follows a Work run: its task and its run are hers to read (the wake names them).
      const w = workOf(ev.job.work);
      if (w) shown.add(conv, { task: [`${w.computer}|${w.task}`], run: [`${w.computer}|${w.run}`] });
      let screen = '';
      if (ev.entry && ev.reason !== 'ended') {
        try {
          screen = await screenOf(ev.entry);
        } catch {
          /* gone meanwhile */
        }
      }
      // How the run ended decides what she reports (jobs.mjs WORK_RULE): read now, by the run's id.
      let run = null;
      if (w && ev.reason !== 'needs_ok' && ev.reason !== 'notice') {
        try {
          const r = ((await ops.workRuns({ computer: w.computer, id: w.run })).runs || []).find((x) => x.id === w.run);
          if (r) run = { state: r.state };
        } catch {
          /* not known: the rule then says what to do either way */
        }
      }
      out.push({ conversation: conv, job: ev.job.id, reason: ev.reason, mode: ev.mode, message: wakeMessage({ ...ev, run, answersHers: tia.answersHers === true }, ev.mode, screen) });
    }
    return out;
  }

  return {
    call,
    confirm,
    reject,
    stopJob,
    takeOutcomes,
    jobTick,
    refreshViews,
    undoView,
    views,
    tiaSettings: tiaFor,
    /** The engine marks who started a turn: the owner's message, or a job wake-up. */
    beginTurn(conversation, turn) {
      // An owner's turn: the addresses he wrote count as shown (see addressesIn). One that is an answer of a choice card
      // she made here is her words, not his: a tap on it (the page sends it as his message) never unlocks it.
      if (turn.origin !== 'job' && turn.text) {
        const choices = views.of(conversation).filter((c) => c.kind === 'choice');
        const hers = new Set(choices.flatMap((c) => c.options.flatMap(addressesIn)));
        shown.add(conversation, { address: addressesIn(turn.text).filter((x) => !hers.has(x)) });
        // A tap on an answer she offered is her words sent in his name: it is not counted as his.
        if (!choices.some((c) => c.options.some((o) => String(o).trim() === String(turn.text).trim()))) heSaid.set(conversation, `${heSaid.get(conversation) || ''}\n${String(turn.text).slice(0, 20_000)}`.slice(-60_000));
      }
      turns.set(conversation, turn.origin === 'job' ? { origin: 'job', job: turn.job, mode: turn.mode } : { origin: 'owner', text: String(turn.text || '').slice(0, 20_000) });
    },
    endTurn(conversation) {
      turns.delete(conversation);
    },
    cards,
    jobs,
    audit,
    skills,
    shown,
    spend,
  };
}
