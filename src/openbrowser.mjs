// Open an address in this computer's default browser. One place for `hoprig chat`, `hoprig link --open` and the first
// run of `hoprig setup`. Returns true when an opener was started (not whether the browser then showed it).
//
// Windows: rundll32 hands the address to the default browser as one argument; "cmd /c start" would split it at & and
// Node's quoting of an empty title does not survive cmd. macOS: open. Elsewhere: xdg-open.
import { spawn } from 'node:child_process';

/** The opener's program and arguments for `url` on `platform`. */
export function openerFor(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url, { platform = process.platform, env = process.env, run = spawn } = {}) {
  const [cmd, args] = openerFor(url, platform);
  try {
    const child = run(cmd, args, { stdio: 'ignore', detached: true, env });
    if (child && typeof child.on === 'function') child.on('error', () => {}); // no opener (a server): the address is printed
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false; // no opener: the address is printed
  }
}

/** The words around a one-time sign-in link that was opened for the person: what happened, and the way out. */
export const openedLines = (url, minutes = 15) => [
  'Opening Hoprig in your browser...',
  `Did it not open? Open this link (it works once, for ${minutes} minutes):`,
  `  ${url}`,
];
