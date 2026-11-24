// A file dropped or pasted on a session's terminal: what the page types once the file is on the session's computer.
// Plain functions, nothing touches the page when this file loads: session.js uses them, and a test imports them.

// What a shell takes as it is; anything else (a space, a quote, a non-ASCII letter) puts the path in quotes.
const PLAIN = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** One path for a shell, as a terminal types it on a drop: as it is when it needs nothing, else in single quotes. */
export function shellWord(p) {
  const s = String(p);
  if (s && PLAIN.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What is typed for the saved files: each path, one space between, one space at the end, no Enter ('' for none). */
export function typedPaths(paths) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  return list.length ? `${list.map(shellWord).join(' ')} ` : '';
}

/**
 * The files a drop or a paste carries (`dt`: its DataTransfer), [] when it carries none (plain text, a link). A
 * copied picture comes as an item of kind "file" (often named image.png); a file also listed in dt.files once.
 */
export function filesOf(dt) {
  if (!dt) return [];
  const out = [...(dt.files || [])];
  for (const it of [...(dt.items || [])]) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile && it.getAsFile();
    if (f && !out.some((o) => o.name === f.name && o.size === f.size && o.type === f.type)) out.push(f);
  }
  return out;
}

/**
 * The files a paste carries. A copy from a document or a spreadsheet holds its text, its HTML and often a picture of
 * itself: that is text, pasted as before. Else the files win (a screenshot, a copied picture or file).
 */
export function pastedFiles(dt) {
  if (!dt) return [];
  const types = [...(dt.types || [])];
  if (types.includes('text/plain') && types.includes('text/html') && dt.getData('text/plain')) return [];
  return filesOf(dt);
}

/**
 * The pictures in the clipboard, read by the page itself (`clip`: navigator.clipboard; the browser asks the person
 * once). [] when there is none, the browser cannot, or the person said no. For Ctrl+V on a Mac, where the browser
 * pastes on Cmd+V only and Ctrl+V is the coding tool's own key for a picture in the clipboard.
 */
export async function clipboardPictures(clip) {
  if (!clip || typeof clip.read !== 'function') return [];
  const out = [];
  try {
    for (const item of await clip.read()) {
      const type = [...(item.types || [])].find((t) => typeof t === 'string' && t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      out.push(new File([blob], `image.${type.slice(6).replace(/[^a-z0-9]/gi, '') || 'png'}`, { type }));
    }
  } catch {
    return []; // refused, or nothing readable
  }
  return out;
}

/** Whether a drag carries files (while it is over the page only the kinds are known, not the files). */
export const dragHasFiles = (dt) => !!dt && [...(dt.types || [])].includes('Files');

/** The one plain sentence for an upload that failed: `status` the HTTP status (0: no answer), `error` the server's. */
export function failWords(name, status, error) {
  const why = status === 0 ? 'there is no connection to the dashboard'
    : status === 413 ? String(error || 'the file is too large')
      : status === 404 ? 'the session has ended'
        : status === 401 ? 'you are logged out'
          : String(error || `the dashboard answered ${status}`);
  return `${name} was not sent: ${why}.`;
}
