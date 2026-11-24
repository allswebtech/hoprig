// Learning here (docs/FIELD-REPORTS.md, "What this computer learns"): a trouble of the same class that came up twice
// for the same command kind on this computer is shown once on Home, with what the product knows to do about it. Only
// reports are read, nothing is changed: Dismiss hides it for that class until it comes up again, and "Make a skill
// draft of this" makes a draft (wayround.mjs) that waits for the owner's Install like every learned skill.
import { MIN_NODE_TEXT } from '../nodefloor.mjs';
import { CLASSES } from './shape.mjs';
import { listReports } from './report.mjs';
import { readFieldState } from './settings.mjs';

export const TWICE = 2;

// Plain words of each class, and what the product knows to do about it: a command (a doctor fix or a setup step), a
// setting of the page, or a section of the docs. One entry per class but "none".
export const KNOWN = Object.freeze({
  network: { words: 'a connection to another server did not get through', help: 'Check this computer\'s internet connection, then run it again. "hoprig doctor --offline" checks everything else without one.', command: 'hoprig doctor --offline' },
  timeout: { words: 'something took too long and was stopped', help: 'Run it again when the network or the computer is less busy; "hoprig doctor" says if something else is wrong.', command: 'hoprig doctor' },
  'not-found': { words: 'a file, folder or program it needed was not there', help: '"hoprig doctor" lists what is missing and the command that brings each back.', command: 'hoprig doctor' },
  permission: { words: 'it was not allowed to read or write a file or folder', help: '"hoprig doctor" checks Hoprig\'s own folders; a folder of yours needs its owner set back to your account.', command: 'hoprig doctor' },
  'disk-full': { words: 'the disk was full', help: 'Make room on the disk (old builds, caches, downloads), then run it again.', command: null },
  'port-in-use': { words: 'the dashboard\'s port was taken by another program', help: 'Stop the other program, or start the dashboard on another port: hoprig serve --port 7533.', command: 'hoprig doctor' },
  'missing-program': { words: 'a program it needed is not installed', help: '"hoprig setup" installs what is missing, step by step.', command: 'hoprig setup' },
  'program-failed': { words: 'a program it ran ended with an error', help: 'Run "hoprig doctor": it names what is broken and how to fix it.', command: 'hoprig doctor' },
  'install-failed': { words: 'an install did not finish', help: '"hoprig pc setup" tries the missing parts again and shows each step.', command: 'hoprig pc setup' },
  'build-tools': { words: 'build tools were missing for a part that has to be built here', help: '"hoprig doctor" shows the one command that installs them on this system.', command: 'hoprig doctor' },
  'node-too-old': { words: 'this Node.js is older than Hoprig needs', help: `Install Node.js ${MIN_NODE_TEXT} or newer (docs/INSTALL.md says how), then run it again.`, command: null, doc: 'docs/INSTALL.md' },
  'terminal-module': { words: 'the terminal module could not load', help: '"hoprig doctor" says why and gives the command that repairs it.', command: 'hoprig doctor' },
  'signin-needed': { words: 'a sign-in was needed', help: '"hoprig doctor" says which sign-in is missing (Claude Code, GitHub) and how to sign in.', command: 'hoprig doctor' },
  'git-auth': { words: 'git was not let into a repository', help: 'The git server asked for a sign-in this computer does not have: sign in to that server (for GitHub, "hoprig pc setup" has the step), then run it again.', command: 'hoprig pc setup', doc: 'docs/PC-SETUP.md' },
  'git-conflict': { words: 'git found changes on both sides that do not fit together', help: 'Open the project in a terminal and finish the merge; "hoprig project status" shows where it stands.', command: 'hoprig project status' },
  'git-not-clean': { words: 'a repository had changes not committed yet', help: 'Commit or put away the changes first; "hoprig project status" lists them.', command: 'hoprig project status' },
  'git-not-pushed': { words: 'a repository had commits that were not pushed', help: 'Those commits are only on this computer: "hoprig sync" puts what is safe on the git server, then run it again.', command: 'hoprig sync' },
  'folder-in-the-way': { words: 'a folder or file was in the way', help: 'Move the folder aside or give another name; docs/WORKSPACE.md says where each thing belongs.', command: null, doc: 'docs/WORKSPACE.md' },
  'config-broken': { words: 'a settings file could not be read', help: '"hoprig doctor" names the file; fix it or move it aside, and Hoprig makes a new one.', command: 'hoprig doctor' },
  'not-set-up': { words: 'a part of Hoprig was not set up yet', help: '"hoprig setup" sets up each missing part, step by step; the dashboard password alone: hoprig passwd.', command: 'hoprig setup' },
  'service-failed': { words: 'the dashboard\'s background service did not start', help: '"hoprig doctor" checks the service; "hoprig service install" sets it up again.', command: 'hoprig service install' },
  'usage-limit': { words: 'a provider reached its usage limit', help: 'Add another provider and turn on Auto mode, so work goes on under the next one: hoprig auto status.', command: 'hoprig auto status' },
  stopped: { words: 'it was stopped before it ended', help: 'Run it again; when nobody stopped it, "hoprig doctor" may say why.', command: 'hoprig doctor' },
  refused: { words: 'Hoprig refused a step to keep something safe', help: 'The command said why when it refused; run it with --dry-run to see each step first.', command: null },
  'open-to-network': { words: 'the dashboard of a server was open to the network on plain http', help: 'On a server the dashboard listens on this computer only and is reached through a tunnel or HTTPS: "hoprig setup --access local" sets it back.', command: 'hoprig setup --access local' },
  other: { words: 'something went wrong that Hoprig has no name for yet', help: 'Run "hoprig doctor": it checks everything and says what to fix.', command: 'hoprig doctor' },
});

export const KIND_WORDS = Object.freeze({
  setup: 'hoprig setup', 'server-setup': 'hoprig setup on a server', 'pc-setup': 'hoprig pc setup', kit: 'a kit\'s install', get: 'hoprig get', adopt: 'hoprig adopt',
  drop: 'hoprig drop', 'go-live': 'an update of Hoprig', start: 'starting a session', doctor: 'hoprig doctor',
});

export const keyOf = (kind, cls) => `${kind}:${cls}`;

// Where one kind of work knows better than its class: the class's words stay, the help is this kind's own.
export const KIND_KNOWN = Object.freeze({
  // drop finds a project in the workspace map: no map, or a name it does not have (doctor does not check either).
  'drop:not-found': { help: 'drop takes a project of the workspace map: "hoprig workspace map" makes the map, and "hoprig workspace status" lists the names it has.', command: 'hoprig workspace status' },
  // A clone git could not make: a name or address that leads nowhere, or a server that is down (doctor checks neither).
  'get:program-failed': { help: 'git could not clone it: check the name or the address ("hoprig get --list" lists the workspace map\'s), then run it again.', command: 'hoprig get --list' },
});

/** What the product knows for this kind of work and class: { words, help, command, doc }. */
export function knownFor(kind, cls) {
  const k = KNOWN[cls];
  const own = KIND_KNOWN[keyOf(kind, cls)];
  return own ? { ...k, ...own } : k;
}

/** A skill draft is offered only where the product's own words teach something: never for "other". */
export const draftable = (cls) => cls !== 'other';

/**
 * The troubles that came up TWICE or more for the same command kind on this computer and are not dismissed (or came
 * up again since): [{ key, kind, class, count, last, words, help, command, doc, draft }], newest first.
 */
export function twiceLines({ reports = listReports().reports, state = readFieldState() } = {}) {
  const by = new Map();
  for (const { report: r } of reports) {
    if (r.outcome !== 'failed' || r.class === 'none' || !CLASSES.includes(r.class)) continue;
    const k = keyOf(r.kind, r.class);
    const g = by.get(k) || { key: k, kind: r.kind, class: r.class, count: 0, last: '' };
    g.count++;
    if (r.time > g.last) g.last = r.time;
    by.set(k, g);
  }
  const out = [];
  for (const g of by.values()) {
    if (g.count < TWICE) continue;
    const gone = state.dismissed[g.key];
    if (gone && g.last <= gone) continue; // dismissed, and it has not come up since
    const known = knownFor(g.kind, g.class);
    out.push({ ...g, kindWords: KIND_WORDS[g.kind], words: known.words, help: known.help, command: known.command || null, doc: known.doc || null, draft: draftable(g.class) });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last));
}
