// The level of one call, decided by the dashboard from the tool, its input, facts the dashboard looked up itself
// (never from the model) and the owner's Tia level. Pure, so every rule is unit-tested.
//
//   facts: {
//     session:  { status, note, cwd, screen } | null   the session the call is about, as the dashboard sees it
//               now (screen: the bottom of its screen, read only while it asks for permission)
//     mine:     boolean                       Tia started that session for a job
//     account:  { name, kind, allowed } | null    the account a start or move would use
//   }
// Returns { level: "L0" | "L1" | "L2", why } or { refuse, next }.
import { ASSISTANT_NAME, riskyPermission } from './tia.mjs';
import { typedTextRisk } from './tools.mjs';

// Calls that put text or keystrokes into a Claude Code session.
const typing = (tool, a) =>
  (tool === 'send_to_session') || (tool === 'press_key' && a.key !== 'Escape') || (tool === 'start_session' && !!a.message);

export function decideLevel(tool, a, f, tia) {
  const base = tool.levelOf ? tool.levelOf(a) : tool.level;
  if (base === 'L0') return { level: 'L0' };
  const name = tool.name;
  const text = name === 'send_to_session' ? a.text : name === 'start_session' ? a.message : null;
  const risk = text ? typedTextRisk(text) : null;

  if ((name === 'start_session' || name === 'switch_account') && f.account && !f.account.allowed) {
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
  if ((name === 'send_to_session' || name === 'press_key') && a.key !== 'Escape' && f.session && f.session.status === 'needs_ok') {
    if (!f.mine) return { level: 'L2', why: `the session is asking for permission and ${ASSISTANT_NAME} did not start it` };
    if (riskyPermission(`${f.session.note || ''}\n${f.session.screen || ''}`, f.session.cwd || null)) return { level: 'L2', why: 'the session asks permission for something risky (fetching and running code, deleting, secrets, the system, the network, or a path outside its folder)' };
  }
  if (name === 'start_session') {
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
