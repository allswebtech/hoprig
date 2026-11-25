// How setup and doctor talk to the user: one line per finding, a mark in front, and questions that respect
// --yes (take the default without asking) and --dry-run (ask nothing, change nothing, say what would happen).
import { ask } from '../menu.mjs';

const tty = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
export const dim = (s) => (tty() ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s) => (tty() ? `\x1b[1m${s}\x1b[0m` : s);
const color = (code, s) => (tty() ? `\x1b[${code}m${s}\x1b[0m` : s);

/** ok ✓, fail ✗, warn !, info · */
export const MARKS = { ok: '✓', fail: '✗', warn: '!', info: '·' };
export function mark(status) {
  const m = MARKS[status] || '·';
  if (status === 'ok') return color(32, m);
  if (status === 'fail') return color(31, m);
  if (status === 'warn') return color(33, m);
  return dim(m);
}

/**
 * The context every setup step gets. `write` is where text goes (tests collect it); `askLine` asks one question
 * (tests answer it). `interactive` is false when there is no terminal to ask in.
 */
export function makeUi({ yes = false, dryRun = false, interactive, write, askLine } = {}) {
  const w = write || ((s) => process.stdout.write(s));
  const ui = {
    yes,
    dryRun,
    interactive: interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY),
    out: (s = '') => w(s + '\n'),
    ask: askLine || ask,
  };

  /** A yes/no question. Resolves to true only when the change may go ahead. */
  ui.confirm = async (question, def = true) => {
    if (ui.dryRun) {
      ui.out(`  ${dim(`(dry run) would ask: ${question} — nothing is changed`)}`);
      return false;
    }
    if (ui.yes) {
      ui.out(`  ${question} ${dim(def ? 'yes (--yes)' : 'no (--yes keeps the default)')}`);
      return def;
    }
    if (!ui.interactive) {
      ui.out(`  ${question} ${dim('skipped: no terminal to answer in (run it in a terminal, or add --yes to accept the defaults)')}`);
      return false;
    }
    for (;;) {
      const a = await ui.ask(`  ${question} ${def ? '(Y/n)' : '(y/N)'} `);
      if (a === null) return false;
      if (a === '') return def;
      if (/^y(es)?$/i.test(a)) return true;
      if (/^n(o)?$/i.test(a)) return false;
      ui.out('  Please answer y or n.');
    }
  };

  /**
   * Pick one of `options` ([{ key, label }]). Resolves to a key, or null (dry run, no terminal, cancelled).
   * --yes takes `def`.
   */
  ui.choose = async (question, options, def) => {
    if (ui.yes && !ui.dryRun) return def; // the caller prints what was chosen
    ui.out(`  ${question}`);
    for (const o of options) ui.out(`    ${bold(o.key)}  ${o.label}${o.key === def ? dim('  (default)') : ''}`);
    if (ui.dryRun) {
      ui.out(`  ${dim('(dry run) nothing is chosen or changed')}`);
      return null;
    }
    if (!ui.interactive) {
      ui.out(`  ${dim('skipped: no terminal to answer in (add --yes to accept the default)')}`);
      return null;
    }
    for (;;) {
      const a = await ui.ask('  > ');
      if (a === null) return null;
      if (a === '') return def;
      const hit = options.find((o) => o.key === a.toLowerCase());
      if (hit) return hit.key;
      ui.out(`  "${a}" is not one of the choices.`);
    }
  };

  ui.line = (status, text) => ui.out(`  ${mark(status)} ${text}`);
  ui.note = (text) => ui.out(`  ${dim(text)}`);
  return ui;
}

// What is still the person's to do after set-up: each item once, with its one next step, in ONE list at the end of the
// run ("Still yours to do"). A step names it when it happens with its mark only (yours); outside set-up (hoprig pc
// setup, hoprig workspace git on their own) the step says its next step on the same line, as before.
export const TODO = {
  // Get started's Git and GitHub step (web/getstarted.js actionLabel, web/gitsetup.js openGitSetup) signs in to GitHub
  // and sets the name and e-mail on the page.
  identity: { label: 'Your name and e-mail for commits', page: 'Home → Get started → Set up git and GitHub', step: 'git config --global user.name "Your Name" && git config --global user.email you@example.com' },
  github: { label: 'Sign in to GitHub', page: 'Home → Get started → Set up git and GitHub', step: 'gh auth login' },
  // The page way first (web/getstarted.js runs the sign-in in the page, src/server/claudelogin.mjs): no terminal needed.
  claude: { label: 'Sign in to Claude Code', page: 'Home → Get started → Sign in to Claude', step: 'run claude, then type /login' },
  // Health's Gateways part turns it on with one press (web/health.js, POST /api/gatewayhost/linger, sudo -n). Where
  // this computer has no sudo the press cannot work: linger.mjs then gives no page way (page: null).
  linger: { label: 'Keep the dashboard running after you log out (lingering)', page: 'Computers → this computer → Health → Let them start after a restart', step: 'sudo loginctl enable-linger <you>' },
  // `page`: the way on the dashboard, named first as it really is (web/getstarted.js withGitStep; only its brain row's
  // Keep on GitHub makes the first commit, with a GitHub sign-in, into a new private repository); the command after it
  // is the way that stays on this computer.
  brainCommit: { label: 'The AI brain\'s first commit, once git knows your name and e-mail', page: 'Home → Get started → Git and GitHub set up, then Keep on GitHub (with a GitHub account: it also keeps the brain in a new private GitHub repository)', step: 'git -C <workspace>/ai_brain init -b main && git -C <workspace>/ai_brain add -A && git -C <workspace>/ai_brain commit -m \'Start the AI brain\'' },
  brain: { label: 'Your AI brain on a git server (its first commit there)', page: 'Home → Get started → Set up git and GitHub', step: 'hoprig workspace git' },
  restart: { label: 'Restart the dashboard, so it runs this version and its settings', step: 'hoprig service install' },
  terminal: { label: 'A new terminal, so every new program and the hoprig command are found', step: 'open a new terminal (or log in again)' },
};
const TODO_ORDER = Object.keys(TODO);

/** Set-up's closing list: from now on `yours` collects into it. */
export function collectTodo(ui) {
  ui.todos = new Map();
  ui.todoPages = new Map(); // a run's own page way for a key, when TODO's does not hold there (null: none)
  ui.todo = (key, step) => {
    if (!ui.todos.has(key)) ui.todos.set(key, step || TODO[key].step);
  };
  return ui;
}

/**
 * Something left for the person: `text` with its mark now, and `key`'s next step (or `step`) in the closing list.
 * Outside set-up the line says it at once: `alone` when given, else `text: step`.
 */
export function yours(ui, status, text, key, { step = null, alone = null, page } = {}) {
  if (ui.todo) {
    if (page !== undefined && ui.todoPages) ui.todoPages.set(key, page);
    // Marked once in a run: a later step that finds it again says nothing, and only a next step of its own (a better
    // one: GitHub's no-reply address) replaces the one kept.
    if (ui.todos.has(key)) {
      if (step) ui.todos.set(key, step);
      return;
    }
    ui.line(status, text);
    ui.todo(key, step || TODO[key].step);
  } else ui.line(status, alone ?? `${text}: ${step || TODO[key].step}`);
}

/** The closing list, once, at the very end of the run (nothing when nothing is left). */
export function closingList(ui) {
  if (!ui.todos || !ui.todos.size) return;
  ui.out();
  ui.out(`  ${bold('Still yours to do:')}`);
  for (const key of TODO_ORDER) {
    if (!ui.todos.has(key)) continue;
    const { label } = TODO[key];
    const page = ui.todoPages && ui.todoPages.has(key) ? ui.todoPages.get(key) : TODO[key].page;
    ui.out(`    · ${label}: ${page ? `On the dashboard: ${page}. Or only here, on this computer: ${ui.todos.get(key)}` : ui.todos.get(key)}`);
  }
}
