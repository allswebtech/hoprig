// The words of a row of Home, Needs you (operator.js itemRow): what is wrong in plain words, with no port, process number
// or load figure, and the name of the one button. The server's own subject and facts stay as they are (they are the
// item's identity and what Tia reads); only what the owner sees is said here.
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ran = (it) => /running for (.+)$/.exec(it.facts?.[0] || '')?.[1] || '';

/** { title, line, labels }: `labels` renames a step by its id (the button's own words), for this row only. */
export function plainRow(it) {
  const subject = String(it.subject || '');
  const first = it.facts?.[0] || '';
  const own = { title: subject, line: first, labels: {} };
  if (it.kind === 'provider' && subject.startsWith('provider ')) {
    const name = subject.slice('provider '.length).replace(/\s*\([^)]*\)\s*$/, '');
    if (/sign-in is gone/.test(first)) return { title: `Your ${name} is signed out`, line: 'New sessions on it cannot start.', labels: { open: 'Sign in' } };
    return { ...own, title: `${cap(name)} is at its limit` };
  }
  if (it.kind === 'provider' && subject.startsWith('gateway ')) return { ...own, title: 'The gateway is not running', line: cap(first.replace(/\s*on port \d+/, '')) };
  // A run that failed (unknown.mjs) or ended badly (ended.mjs) is named for what it is, not by its run number; a task that
  // failed twice, not by its id.
  if ((it.kind === 'unknown' || it.kind === 'ended') && /^Work run /.test(subject)) return { ...own, title: 'A task run did not finish' };
  if (it.kind === 'unknown' && /^task \S+$/.test(subject)) return { ...own, title: 'A task failed twice' };
  if (it.kind === 'leftover') {
    const span = ran(it);
    const after = span ? ` It has run for ${span}.` : '';
    if (subject.startsWith('dashboard ')) return { title: 'Another dashboard is running on this computer', line: `Nothing uses it.${after}`, labels: { end: 'End it' } };
    return { title: 'A leftover terminal is using memory', line: `Nothing is attached to it.${after}`, labels: { end: 'End it' } };
  }
  if (it.kind === 'machine') {
    const look = { open: 'See what is busy' };
    if (subject === 'load') return { title: 'This computer is very busy', line: 'Everything runs slower until it calms down.', labels: look };
    if (subject === 'memory') {
      const m = /^(.+?) of (.+?) available/.exec(first);
      return { title: 'This computer is low on memory', line: m ? `Only ${m[1]} of ${m[2]} is free.` : first, labels: look };
    }
    if (subject === 'the temporary folder' || subject.startsWith('disk ')) {
      const place = subject.startsWith('disk ') ? `The disk ${subject.slice(5)}` : 'The temporary folder';
      return { title: `${place} is almost full`, line: it.facts?.[1] ? `${cap(it.facts[1])}.` : 'Free some room before work fails.', labels: { open: 'See what takes room' } };
    }
  }
  return own;
}
