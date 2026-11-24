// A repository of the workspace that is behind its upstream, ahead of it, or holds work that exists only on this
// computer (uncommitted changes, or a branch without an upstream). Git state is from the last fetch only, and the
// item says so: a look never fetches.
//
// Reads board.repos[]: { name, path, branch, upstream, behind, ahead, dirty, fetchedAt }.

import { act, makeItem } from '../item.mjs';
import { clock, ms } from './util.mjs';

const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

export function detectRepo(board, { now = Date.now() } = {}) {
  const out = [];
  for (const r of board.repos ?? []) {
    const behind = n(r.behind);
    const ahead = n(r.ahead);
    const dirty = n(r.dirty);
    const noUpstream = !!r.branch && !r.upstream;
    if (!behind && !ahead && !dirty && !noUpstream) continue;
    const facts = [`branch ${r.branch || '(detached)'}${r.upstream ? ` → ${r.upstream}` : ''}`];
    // One line for the counts, in plain words: a weak model reads one line as easily as three, and so does a person.
    const counts = [];
    if (behind) counts.push(`${behind} newer commit${behind > 1 ? 's' : ''} on the git server, not here yet`);
    if (ahead) counts.push(`${ahead} commit${ahead > 1 ? 's' : ''} here not yet sent to the git server`);
    if (dirty) counts.push(`${dirty} changed file${dirty > 1 ? 's' : ''} not committed`);
    if (counts.length) facts.push(counts.join(', '));
    if (noUpstream) facts.push('the branch is not on the git server: it exists only here');
    facts.push(r.fetchedAt ? `as of the last fetch at ${clock(r.fetchedAt, now)}` : 'never fetched here');
    const onlyHere = ahead > 0 || dirty > 0 || noUpstream;
    const href = `#/workspace/project/${encodeURIComponent(r.project || r.name)}`;
    const acts = [];
    let recommended = 'open';
    let why;
    if (behind && !ahead && !dirty && r.upstream) {
      acts.push('sync');
      recommended = 'sync';
      why = 'Newer work of others is on the git server; bringing it here changes nothing of yours.';
    } else if (ahead && !behind && r.upstream) {
      acts.push('push');
      recommended = 'push';
      why = 'These commits exist only on this computer until you send them to the git server.';
    } else {
      why = onlyHere ? 'Work here exists nowhere else; commit or push it from the project.' : 'Look at it in the project.';
    }
    acts.push(act('open', { href, label: 'Open the project' }));
    out.push(makeItem({
      kind: 'repo',
      // Uncommitted changes, unpushed commits and a new branch are how work in progress looks: the item says that the
      // work is only here, but it ranks below stopped work and what waits for the owner, which cannot wait.
      cls: 'info',
      subject: `repository ${r.name}`,
      since: ms(r.fetchedAt),
      // The counts and branches decide the rev: a fetch that brings nothing new (a new fetch time) is the same item.
      state: [behind, ahead, dirty, noUpstream, r.branch || null, r.upstream || null, !!r.fetchedAt],
      facts,
      acts,
      recommended,
      why,
      target: { path: r.path, branch: r.branch },
    }));
  }
  return out;
}
