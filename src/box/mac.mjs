// The box on macOS: a profile for sandbox-exec, generated for one run. Deny by default, the same allow list as on
// Linux (the system's program folders read-only, the runtime of Node read-only, the caller's read and write folders),
// no network at all, signals and process information only inside the box. The text is tested on every system; whether
// it holds is decided by the self-test on a real Mac (docs/BOX.md: not yet run on one).

/**
 * The system folders read-only inside, a closed list: the programs, the libraries and the dynamic loader's cache, and
 * the time zone data. Not /Users, /Volumes, /private/var/folders (every user's temporary folders), /opt or Homebrew:
 * such a toolchain is named by the caller in `read`.
 */
export const MAC_SYSTEM = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/private/var/db/dyld', '/private/var/db/timezone'];
/**
 * Single entries read-only inside: the time zone link, and the links /etc, /var and /tmp themselves (macOS resolves a
 * path through them to /private/...; only the link is readable, never what lies behind it).
 */
export const MAC_FILES = ['/private/etc/localtime', '/etc', '/var', '/tmp'];
/** The devices: read and write the empty ones, read the random ones; never /dev/tty (no terminal of the caller's). */
const DEV_RW = ['/dev/null', '/dev/zero'];
const DEV_R = ['/dev/random', '/dev/urandom'];

/** A path as a string of the profile's language, or null when it holds a character that cannot be written plainly. */
function str(p) {
  if (typeof p !== 'string' || /[\u0000-\u001f\u007f"\\]/.test(p)) return null;
  return `"${p}"`;
}

/** Every folder above `p` ("/a/b/c" → "/", "/a", "/a/b"): their names may be looked up, nothing else in them. */
function parents(p) {
  const out = ['/'];
  const parts = p.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push('/' + parts.slice(0, i).join('/'));
  return out;
}

/**
 * The profile for `plan` (box.mjs's checked plan) with the box's own `home` and `tmp` folders (real temporary folders,
 * removed afterwards). → { text } or { why } when a path cannot be written into a profile plainly.
 */
export function macProfile(plan, { home, tmp }) {
  const write = [...plan.write, home, tmp];
  const read = [plan.runtime, ...plan.read];
  const all = [...write, ...read];
  for (const p of [...all, ...(plan.guard || [])]) if (str(p) === null) return { why: `a folder name the box cannot hold: ${JSON.stringify(p)}` };
  const sub = (list) => list.map((p) => `(subpath ${str(p)})`).join(' ');
  const lit = (list) => list.map((p) => `(literal ${str(p)})`).join(' ');
  const lookups = [...new Set([...all, ...MAC_SYSTEM].flatMap(parents))].sort();
  const lines = [
    '(version 1)',
    '(deny default)',
    // Its own processes only: it may start programs, but signal and inspect only those of its own sandbox.
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    `(allow file-read-metadata ${lit(lookups)})`,
    `(allow file-read* ${sub(MAC_SYSTEM)} ${lit(MAC_FILES)})`,
    `(allow file-read* ${lit(DEV_R)})`,
    `(allow file-read* file-write-data ${lit(DEV_RW)})`,
    `(allow file-read* ${sub(read)})`,
    `(allow file-read* file-write* ${sub(write)})`,
  ];
  // Rule 6: the git folders of the write folders are read-only (the later deny wins over the allow above).
  if (plan.guard?.length) lines.push(`(deny file-write* ${plan.guard.map((g) => `(subpath ${str(g)}) (literal ${str(g)})`).join(' ')})`);
  // No network: nothing allows it, and this says so where a reader looks.
  lines.push('(deny network*)');
  return { text: lines.join('\n') + '\n' };
}
