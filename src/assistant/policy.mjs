// The level of one call, decided by the dashboard from the tool, its input, facts the dashboard looked up itself
// (never from the model) and the owner's Tia level. Pure but for the home folder's real path, so every rule is
// unit-tested.
//
//   facts: {
//     session:  { status, note, cwd, screen, owner?, known?, tool?, input?, request? } | null   the session the call is
//               about, as the dashboard sees it now (screen: the bottom of its screen, read only while it asks for
//               permission; for a chat: what its OK is about, the whole command or path; owner: the chat keeps that OK
//               for the owner; known: false for a chat's OK of a call her rules cannot judge; tool, input: a known call's
//               name and strings, for the allow-list)
//     mine:     boolean                       Tia started that very session (a chat: by its own mark; a terminal: by its name and when it was made)
//     account:  { name, kind, allowed } | null    the account a start or move would use
//   }
// Returns { level: "L0" | "L1" | "L2", why } or { refuse, next }.
import fs from 'node:fs';
import os from 'node:os';
import { allowsHerself } from './allowlist.mjs';
import { ASSISTANT_NAME, riskyPermission } from './tia.mjs';
import { typedTextRisk } from './tools.mjs';

// Calls that put text or keystrokes into a Claude Code session (a terminal or a chat), or give an OK in it. Interrupting
// (Escape, a chat's stop) and saying no to an OK are not: they only hold Claude back.
const typing = (tool, a) =>
  (tool === 'send_to_session' && a.key !== 'Escape') || (tool === 'send_to_chat' && (a.text !== undefined || (!!a.answer && a.answer !== 'deny')))
  || ((tool === 'start_session' || tool === 'start_chat') && !!a.message);
// Calls that would answer (or type over) an OK the session waits for.
const answering = (tool, a) => (tool === 'send_to_session' && a.key !== 'Escape') || (tool === 'send_to_chat' && (a.text !== undefined || (!!a.answer && a.answer !== 'deny')));
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

export function decideLevel(tool, a, f, tia) {
  const base = tool.levelOf ? tool.levelOf(a) : tool.level;
  if (base === 'L0') return { level: 'L0' };
  const name = tool.name;
  const text = name === 'send_to_session' || name === 'send_to_chat' ? a.text : STARTS.has(name) ? a.message : null;
  const risk = text ? typedTextRisk(text) : null;

  if ((STARTS.has(name) || name === 'switch_account') && f.account && !f.account.allowed) {
    return {
      refuse: `provider "${f.account.name}" is not one ${ASSISTANT_NAME} may use (allowed: ${tia.allowed.join(', ') || 'none'})`,
      next: `leave account out to let ${ASSISTANT_NAME} choose among the allowed ones; only the owner can allow more providers (open_screen "settings/tia")`,
    };
  }
  if (risk) return { level: 'L2', why: risk };
  // A domain tool's own rule for this action (a sync that would publish commits, text a schedule will type …).
  if (tool.policy) {
    const own = tool.policy(a, f, tia);
    if (own) return own;
  }
  if (typing(name, a) && tia.level === 'ask') return { level: 'L2', why: 'the owner set "Ask me": everything typed into a session needs his OK' };
  // "Do not ask again" leaves a standing rule in the chat: later calls it covers run with no OK, so her allow-list never
  // sees them. Only the owner gives that.
  if (name === 'send_to_chat' && a.answer === 'allow_always') return { level: 'L2', why: '"do not ask again" lets later calls run without an OK: only the owner gives that' };
  if (answering(name, a) && f.session && f.session.status === 'needs_ok') {
    if (f.session.owner) return { level: 'L2', why: 'the chat keeps this OK for the owner (his permission settings, a hook or a safety check ask him)' };
    if (!f.mine) return { level: 'L2', why: `the session is asking for permission and ${ASSISTANT_NAME} did not start it` };
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
    if (f.account && f.account.kind === 'api' && tia.level !== 'handsoff') return { level: 'L2', why: `${f.account.name} is an API provider: it is paid per token` };
    return { level: 'L1' };
  }
  if (name === 'switch_account') {
    if (tia.level === 'ask' || !f.mine) return { level: 'L2', why: f.mine ? 'the owner set "Ask me"' : `${ASSISTANT_NAME} did not start this session` };
    if (f.account && f.account.kind === 'api' && tia.level !== 'handsoff') return { level: 'L2', why: `${f.account.name} is an API provider: it is paid per token` };
    return { level: 'L1' };
  }
  if (name === 'stop_session') {
    if (tia.level !== 'ask' && f.mine) return { level: 'L1' };
    return { level: 'L2', why: f.mine ? 'the owner set "Ask me"' : `${ASSISTANT_NAME} did not start this session` };
  }
  return { level: base };
}
