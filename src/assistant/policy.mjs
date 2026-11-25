// The level of one call, decided by the dashboard from the tool, its input, facts the dashboard looked up itself
// (never from the model) and the owner's Tia level. Pure but for the home folder's real path, so every rule is
// unit-tested.
//
//   facts: {
//     session:  { status, note, cwd, screen, codingTool, owner?, known?, tool?, input?, request? } | null   the session the call is
//               about, as the dashboard sees it now (screen: the bottom of its screen, read only while it asks for
//               permission; for a chat: what its OK is about, the whole command or path; owner: the chat keeps that OK
//               for the owner; known: false for a chat's OK of a call her rules cannot judge; tool, input: a known call's
//               name and strings, for the allow-list; codingTool: the session's coding tool, "claude" when not known)
//     mine:     boolean                       Tia started that very session (a chat: by its own mark; a terminal: by its name and when it was made)
//     account:  { name, kind, allowed } | null    the account a start or move would use
//     work:     boolean                       the session is a Work run's (a job follows it with `work`): the owner's
//     herWork:  boolean                       that very session is the run of a Work task she started (her manage_work
//               start, matched by its name and when it was made): its OK is hers only with tia.answersHers on (below)
//     (session.notice: the card is a question of the coding tool itself, askcard.mjs: always the owner's)
//   }
// Returns { level: "L0" | "L1" | "L2", why } or { refuse, next }.
import fs from 'node:fs';
import os from 'node:os';
import { allowsHerself } from './allowlist.mjs';
import { FULL_ADMIN_PER_HOUR } from './herrights.mjs';
import { ASSISTANT_NAME, riskyPermission } from './tia.mjs';
import { toolName } from './toolkit.mjs';
import { typedTextRisk } from './tools.mjs';

// Calls that put text or keystrokes into a Claude Code session (a terminal or a chat), or give an OK in it. Interrupting
// (Escape, a chat's stop), saying no to an OK and a new name (it types nothing) are not: they only hold Claude back.
const keys = (tool, a) => tool === 'send_to_session' && a.key !== 'Escape' && a.name === undefined && a.to_chat !== true;
const typing = (tool, a) =>
  keys(tool, a) || (tool === 'send_to_chat' && (a.text !== undefined || (!!a.answer && a.answer !== 'deny')))
  || ((tool === 'start_session' || tool === 'start_chat') && !!a.message);
// Calls that would answer (or type over) an OK the session waits for.
const answering = (tool, a) => keys(tool, a) || (tool === 'send_to_chat' && (a.text !== undefined || (!!a.answer && a.answer !== 'deny')));
const STARTS = new Set(['start_session', 'start_chat']);
// This computer's home folder as written and by its real path: a chat's folder is a real path, so a home reached
// through a link (HOME=/home/me where /home links elsewhere) is seen only by the second. The allow-list touches no disk.
function homes() {
  const home = os.homedir();
  try {
    return [home, fs.realpathSync(home)];
  } catch {
    return [home];
  }
}


/**
 * Why a start or a move onto a paid provider waits for his tap (Auto: its order holds a key billed by use). Under Auto,
 * order.first is the provider before every paid one that the session starts on, null when there is none: then the
 * router serves the first request with the first paid key, so money is spent from the start, not at a limit.
 */
const paidWhy = (acc) => {
  if (acc.name !== 'auto') return `${acc.name} is ${acc.kind === 'api' ? 'an API provider' : 'a provider billed by use'}: it is paid per token`;
  const paid = acc.order && acc.order.paid.length ? acc.order.paid : null;
  if (acc.order && !acc.order.first && paid) return `Auto mode runs this session on ${paid[0]} first, which costs money`;
  return `when ${(acc.order && acc.order.first) || 'a provider'} reaches its limit, Auto mode may move this session to ${paid ? paid.join(' or ') : 'a provider billed by use'}, which costs money`;
};
export function decideLevel(tool, a, f, tia) {
  const base = tool.levelOf ? tool.levelOf(a) : tool.level;
  if (base === 'L0') return { level: 'L0' };
  const name = tool.name;
  // An administrator command of hers (run_command with sudo): the owner's Tia administrator-rights level decides it
  // (herrights.mjs). The forms that could raise her rights — a shell or a login as administrator, the
  // account and sudoers tools, a set-user-id bit, Hoprig's own folders, a form the reader cannot break down — are
  // refused at EVERY level with no card. Off, Ask each time and Full decide the rest below, and nothing of
  // hers runs sudo outside this path, so no administrator command reaches the plain shell unconfirmed.
  if (name === 'run_command' && f.admin && f.admin.isAdmin) {
    const his = 'tell the owner the exact command and that he runs it himself in his own terminal (open_screen "desktop/terminal")';
    if (f.admin.refusedWhy) return { refuse: `that command ${f.admin.refusedWhy.why}, which is the owner's own step at every level, never a command of ${ASSISTANT_NAME}'s`, next: his };
    // Off: refused with no card, and she says where the owner turns it on — his own page, per computer.
    if (f.admin.level === 'off') {
      return {
        refuse: `that command is administrator rights, which is the owner's own step while the owner's administrator-rights level for ${ASSISTANT_NAME} is Off; he turns on "Ask each time" or "Full" under Settings → Tia administrator rights on his own page`,
        next: 'tell the owner the exact command and that he either runs it himself in his own terminal (open_screen "desktop/terminal") or raises his administrator-rights level on his own page',
      };
    }
    // Ask each time: one confirmation card per administrator command, at every level of hers (Hands off
    // too). The card shows the exact sudo argv and the computer, and asks for the computer's password where sudo needs
    // one; his tap runs it through the administrator path (owner-tools run → ops.runAdmin), never the plain shell.
    if (f.admin.level === 'ask') return { level: 'L2', why: 'that command runs as administrator; the owner approves it on his page and types the computer\'s password if sudo asks for one' };
    // Full: her administrator commands run with no card (L1) and each is in the audit log and her activity.
    // Full is offered only where sudo needs no password (server/herrights guards the turn-on), so a cardless run never
    // needs a kept password; where sudo would ask one anyway we fall back to the Ask card (his tap), never cardless. An
    // hour's limit (data) caps a runaway: beyond FULL_ADMIN_PER_HOUR administrator commands in the last hour the next
    // one falls back to the Ask card too, so a mistake of hers may cost a day, never the work.
    if (f.admin.level === 'full') {
      // A delete as administrator is his at every level (a delete outside a session's folder is the owner's in every
      // mode, and the wall holds it in a session of hers at Full too): his card, as at Ask.
      if (f.admin.deletes) return { level: 'L2', why: 'that command deletes as administrator; a delete as administrator stays the owner\'s card at every level, Full too, so he approves it on his page' };
      // An administrator command never hides what it does: a release, a pull request or a deploy behind sudo is
      // what it is without sudo, the owner's card at every level.
      if (Array.isArray(f.admin.also) && f.admin.also.length) return { level: 'L2', why: `that command is more than an administrator command (${f.admin.also.map((t) => t.charAt(0).toLowerCase() + t.slice(1)).join(', ')}), and that stays the owner's card at every level, Full too, so he approves it on his page` };
      if (f.admin.needsPassword) return { level: 'L2', why: 'that command runs as administrator; Full runs with no card only where sudo needs no password, so the owner approves this one and types the computer\'s password' };
      if ((f.admin.ranLastHour || 0) >= FULL_ADMIN_PER_HOUR) return { level: 'L2', why: `${ASSISTANT_NAME} has already run ${FULL_ADMIN_PER_HOUR} administrator commands in the last hour at Full, the most with no card: the owner approves this one` };
      return { level: 'L1', why: 'administrator rights are Full: the command runs as administrator and is in the audit log' };
    }
    // Every level is handled above (herRightsLevel returns off/ask/full); the refuse is a fail-closed default so no
    // administrator command of hers ever reaches the plain shell.
    return { refuse: `that command is administrator rights, which is the owner's own step, never a command of ${ASSISTANT_NAME}'s`, next: his };
  }
  const text = name === 'send_to_session' || name === 'send_to_chat' ? a.text : STARTS.has(name) ? a.message : null;
  const risk = text ? typedTextRisk(text) : null;

  // Starting work on a task (manage_work start) opens a session: the providers she may use hold for it too. It is always
  // a card in this part (its level), so the rest of the start rules can only agree.
  const workStart = name === 'manage_work' && a.action === 'start';
  // A move onto the provider it is on already moves nothing: carrying on there after a limit is send_to_session continue.
  if (name === 'switch_account' && f.account && f.session && f.session.account === f.account.name) {
    return { refuse: `${a.session} already runs on ${f.account.name}`, next: 'to carry on on the same provider after its usage limit use send_to_session continue: true; to move it, name another provider' };
  }
  if ((STARTS.has(name) || name === 'switch_account' || workStart) && f.account && !f.account.allowed) {
    return {
      refuse: `provider "${f.account.name}" is not one ${ASSISTANT_NAME} may use (allowed: ${tia.allowed.join(', ') || 'none'})`,
      next: `leave account out to let ${ASSISTANT_NAME} choose among the allowed ones; only the owner can allow more providers (open_screen "settings/tia")`,
    };
  }
  if (risk) return { level: 'L2', why: risk };
  // A Work run's session is the owner's (the Work route opened it, its result is his to accept): nothing is typed into
  // it, answered, refused, interrupted or renamed there without his OK, at any level (a stop ends his paid run part way).
  // One narrowing, behind the owner's switch "She answers the OKs of her Work runs" (tia.answersHers, off at first): in
  // the run of a Work task she started, an answer allow to the OK it waits for goes on to the rules below, which judge it
  // as in any session of hers. Nothing else does: a deny (a no stops his run's step), text, a key, allow_always,
  // continue, a stop stay his card.
  const herWork = f.work && f.herWork === true && tia.answersHers === true && name === 'send_to_chat' && a.answer === 'allow';
  if (f.work && (name === 'send_to_session' || name === 'send_to_chat') && !herWork) return { level: 'L2', why: 'this session runs a Work task: it is the owner\'s' };
  if (herWork) {
    if (tia.level === 'ask') return { level: 'L2', why: 'the owner set "Ask me": every OK in a Work run is his' };
    // Her answer is "yes" to the run's next call only on a provider her level lets her spend on without asking.
    if (f.session && f.session.paid && tia.level !== 'handsoff') return { level: 'L2', why: 'this Work run is on a provider billed by use: an OK there is the owner\'s below "Hands off"' };
    if (!(f.session && f.session.status === 'needs_ok' && f.session.known === true)) return { level: 'L2', why: `this OK is not one ${ASSISTANT_NAME} can judge` };
  }
  // The coding tool asks a question of its own before it starts (trust this folder, Bypass permissions mode, external
  // imports, another first-time choice): what a key accepts there is not a call her rules can judge, so any key or text
  // typed while it stands waits for his tap, at every level and in her own session too.
  if (keys(name, a) && f.session && f.session.notice) return { level: 'L2', why: 'the coding tool asks the owner something before it starts: the answer is his' };
  // A domain tool's own rule for this action (a sync that would publish commits, text a schedule will type …).
  if (tool.policy) {
    const own = tool.policy(a, f, tia);
    if (own) return own;
  }
  if (typing(name, a) && tia.level === 'ask') return { level: 'L2', why: 'the owner set "Ask me": everything typed into a session needs his OK' };
  // "Do not ask again" leaves a standing rule in the chat: later calls it covers run with no OK, so her allow-list never
  // sees them. Only the owner gives that.
  // Closing a chat or moving it into a terminal ends the chat he may be reading: only hers runs at once.
  if (name === 'send_to_chat' && (a.close || a.terminal) && (tia.level === 'ask' || !f.mine)) return { level: 'L2', why: f.mine ? 'the owner set "Ask me"' : `${ASSISTANT_NAME} did not start this chat` };
  // Carrying a session on after its limit, or opening its conversation as a chat, acts in a session he may be working
  // in: in a session or chat she did not start it waits for his tap at every level, "Hands off" too.
  if (name === 'send_to_session' && (a.continue || a.to_chat) && (tia.level === 'ask' || !f.mine)) return { level: 'L2', why: f.mine ? 'the owner set "Ask me"' : `${ASSISTANT_NAME} did not start this session` };
  if (name === 'send_to_chat' && a.answer === 'allow_always') return { level: 'L2', why: '"do not ask again" lets later calls run without an OK: only the owner gives that' };
  if (answering(name, a) && f.session && f.session.status === 'needs_ok') {
    if (f.session.owner) return { level: 'L2', why: 'the chat keeps this OK for the owner (his permission settings, a hook or a safety check ask him)' };
    // Her rules judge only Claude Code's own calls: an OK in another coding tool's session (an OpenCode chat or terminal)
    // is always the owner's, whatever the call says.
    if (f.session.codingTool && f.session.codingTool !== 'claude') return { level: 'L2', why: `${toolName(f.session.codingTool)} asks for this OK: only Claude Code's own OKs are ${ASSISTANT_NAME}'s to answer` };
    if (!f.mine && !herWork) return { level: 'L2', why: `the session is asking for permission and ${ASSISTANT_NAME} did not start it` };
    // A chat's OK for a call that is not the coding tool's own in a shape it knows (an MCP tool, any other input): a
    // deny-list cannot judge an input of unknown shape, whatever it says.
    if (f.session.known === false) return { level: 'L2', why: `this tool's input is not one ${ASSISTANT_NAME} can judge` };
    if (f.session.cut) return { level: 'L2', why: 'what the session asks permission for is too long to judge whole' };
    // Her answer "allow" to a chat's OK of a known call: only what the short allow-list holds (allowlist.mjs); the
    // deny-list below still looks at what passed it. A plain message is not an OK of the call, so it is judged as before
    // the list came. A terminal has no call to judge, only its screen (known is not set).
    if (f.session.known === true && name === 'send_to_chat' && a.answer === 'allow') {
      const own = allowsHerself(f.session.tool, f.session.input, f.session.cwd, homes());
      if (!own.ok) return { level: 'L2', why: own.why };
    }
    if (riskyPermission(`${f.session.note || ''}\n${f.session.screen || ''}`, f.session.cwd || null)) return { level: 'L2', why: 'the session asks permission for something risky (fetching and running code, deleting, secrets, the system, the network, or a path outside its folder)' };
  }
  if (STARTS.has(name)) {
    if (tia.level === 'ask') return { level: 'L2', why: 'the owner set "Ask me"' };
    if (f.account && (f.account.paid || f.account.kind === 'api') && tia.level !== 'handsoff') return { level: 'L2', why: paidWhy(f.account) };
    return { level: 'L1' };
  }
  if (name === 'switch_account') {
    if (tia.level === 'ask' || !f.mine) return { level: 'L2', why: f.mine ? 'the owner set "Ask me"' : `${ASSISTANT_NAME} did not start this session` };
    if (f.account && (f.account.paid || f.account.kind === 'api') && tia.level !== 'handsoff') return { level: 'L2', why: paidWhy(f.account) };
    return { level: 'L1' };
  }
  if (name === 'stop_session') {
    if (tia.level !== 'ask' && f.mine) return { level: 'L1' };
    return { level: 'L2', why: f.mine ? 'the owner set "Ask me"' : `${ASSISTANT_NAME} did not start this session` };
  }
  return { level: base };
}
