// A session or a Work run that ended and needs a look: a session whose coding tool ended in its terminal, a Work
// run that failed, stopped, met a limit or finished with a result to read. Only what ended within the last day.
//
// A session whose coding tool died with no end of its own (no SessionEnd in its run record; board `reopen` says where it
// was: folder, conversation, provider, arguments) also offers "Reopen the session": the same conversation again with
// resume, nothing sent. One the person ended himself (/exit) has no `reopen`.
//
// Reads board.sessions[] (state 'ended', statusAt, provider, providerLabel, reopen) and board.work.runs[]: { id, title, state, endedAt, reason,
// session, project }.

import { act, makeItem } from '../item.mjs';
import { ms, providerName, sessionHref, span } from './util.mjs';

export const ENDED_WINDOW_MS = 24 * 3600_000;
const RUN_WORDS = { done: 'finished', failed: 'failed', limit: 'stopped at a usage limit', stopped: 'was stopped' };

export function detectEnded(board, { now = Date.now(), windowMs = ENDED_WINDOW_MS } = {}) {
  const out = [];
  for (const s of board.sessions ?? []) {
    if (s.state !== 'ended') continue;
    const at = ms(s.statusAt);
    if (at == null || now - at > windowMs) continue;
    out.push(makeItem({
      kind: 'ended',
      cls: 'info',
      subject: `session ${s.name}`,
      since: at,
      state: ['session', at, s.provider || null, s.lastWords || null],
      facts: [`its coding tool ${s.reopen ? 'stopped without ending' : 'ended'} ${span(now - at)} ago`, s.provider ? `provider ${providerName(s.provider, s.providerLabel)}` : null, s.lastWords ? `last words: ${s.lastWords}` : null],
      acts: [...(s.reopen ? ['reopen'] : []), act('open', { href: sessionHref(s.name), label: 'Open the session' })],
      recommended: s.reopen ? 'reopen' : undefined,
      why: s.reopen ? 'The same conversation can go on where it stopped; nothing is sent to it.' : 'Read how it ended before you close it or continue it.',
      target: { session: s.name, ...(s.reopen ? { reopen: true, cwd: s.reopen.cwd, sessionId: s.reopen.sessionId, profile: s.reopen.profile, carryArgs: s.reopen.carryArgs || [], tool: s.reopen.tool || 'claude' } : {}) },
    }));
  }
  for (const r of board.work?.runs ?? []) {
    if (!RUN_WORDS[r.state]) continue;
    const at = ms(r.endedAt);
    if (at == null || now - at > windowMs) continue;
    const bad = r.state !== 'done';
    out.push(makeItem({
      kind: 'ended',
      cls: bad ? 'stopped' : 'info',
      subject: `Work run ${r.id}`,
      since: at,
      facts: [`"${r.title}" ${RUN_WORDS[r.state]} ${span(now - at)} ago`, r.from ? `added by another program (the Work token "${r.from}")` : null, r.project ? `project ${r.project}` : null, r.reason ? `reason: ${r.reason}` : null],
      acts: [act('open', { href: '#/work/activity', label: 'Open the run' })],
      why: bad ? 'The task has no result yet; see why it ended.' : 'It has a result to read.',
      target: { run: r.id, ...(r.mission === true ? { mission: true } : {}) },
    }));
  }
  return out;
}
