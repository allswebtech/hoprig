// `hoprig chat [folder]`: coding in a chat from the command line. It prints the dashboard address that opens a chat
// in the folder (the page's New session does the same with one tap: web/newsession.js, "#/new?dir=…"), and opens it
// where a browser is at hand on this computer. The chat starts as the last chat in that folder ran
// (src/chat/folders.mjs). `hoprig` alone stays Claude Code in the terminal.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { linkBase } from '../machines/cli.mjs';
import { dashboardAddress } from '../machines/pairing.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';

const USAGE = 'usage: hoprig chat [folder] [--no-open]   (the folder: this one when left out)';

/** The page address that opens a chat in `dir` on the dashboard at `base`. */
export const chatAddress = (base, dir) => `${String(base).replace(/\/+$/, '')}/#/new?${new URLSearchParams({ dir })}`;

/** True when a browser can be opened on this computer for the person at this terminal. */
export function browserAtHand(env = process.env, platform = process.platform, tty = !!process.stdout.isTTY) {
  if (!tty || env.SSH_CONNECTION || env.SSH_TTY) return false; // over ssh the browser would open on the far screen
  if (platform === 'darwin' || platform === 'win32') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false; // no opener: the address is printed
  }
}

/**
 * Entry point from the bin script. o: { cwd, running(), base(), local(), open(url), atHand(), log, err } (tests).
 * Returns an exit code.
 */
export async function main(args = [], o = {}) {
  const log = o.log || ((s) => console.log(s));
  const err = o.err || ((s) => console.error(s));
  const rest = args.filter((a) => a !== '--no-open');
  if (rest.some((a) => a === '-h' || a === '--help')) {
    log(USAGE);
    return 0;
  }
  if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) {
    err(USAGE);
    return 2;
  }
  const dir = path.resolve(o.cwd || process.cwd(), rest[0] || '.');
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    /* missing */
  }
  if (!isDir) {
    err(`hoprig chat: there is no folder ${dir}`);
    return 2;
  }
  const running = (o.running || runningDashboard)();
  if (!running) {
    err('hoprig chat: the dashboard is not running. Start it with "hoprig serve" (or "hoprig service install" to keep it running), then try again.');
    return 1;
  }
  const address = chatAddress((o.base || (() => linkBase().url))(), dir);
  log(`A chat in ${dir}:\n\n  ${address}\n`);
  log('It opens set up as your last chat in that folder. The folder must be inside the folders the dashboard allows (Settings).');
  const atHand = o.atHand ? o.atHand() : browserAtHand();
  if (!args.includes('--no-open') && atHand) {
    const local = o.local ? o.local() : (() => {
      const { host, port } = dashboardAddress(undefined, running);
      return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    })();
    if ((o.open || openBrowser)(chatAddress(local, dir))) log('Opened in your browser.');
  }
  return 0;
}
