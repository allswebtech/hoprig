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
