// What a terminal the dashboard starts runs (src/server/deck.mjs terminal, respawn, shell): nothing from outside is
// typed into its shell. The launcher's words (the folder, the provider, a first message) go in a launch file
// (src/launchfile.mjs); the typed line holds the launcher's own command, the file's path and the start mark, each word
// on the short list of ./backends/shell.mjs.
import { LAUNCH_FLAG, launchDir, writeLaunch } from '../launchfile.mjs';
import { assertTypable } from './backends/shell.mjs';

/**
 * A terminal session cannot live in a folder whose name holds a line break: tmux lists its terminals one per line, and
 * the terminal would be lost from the list. Every other character of a folder's name is carried whole (it is never
 * typed; tmux gets it escaped: ./backends/tmux.mjs tmuxDir). 400, so the page shows the sentence and the assistant gets
 * it as a tool error. Every start checks it: a new terminal, a plain shell, a move or a restart in place.
 */
export function assertFolder(dir) {
  if (/[\r\n]/.test(String(dir))) {
    throw Object.assign(new Error(`A terminal session cannot start in this folder: its name holds a line break (${JSON.stringify(String(dir))}). Rename the folder, then start the session again`), { status: 400 });
  }
}

/**
 * What a terminal runs for `argv` in `dir`, as { argv, file }: the launcher's own command (`launcher`) with a launch
 * file in place of its words, so nothing of them, nor the folder, is typed into a shell. Refused plainly (400) before
 * anything is written when the launcher's own command or the state folder cannot be typed. A command that is not the
 * launcher (a plain program of ours) is typed only when each of its words may be. `argv` null: a plain shell.
 */
export function startCommand({ launcher, dir, argv, mark = null, platform = process.platform }) {
  if (!argv) return { argv: null, file: null };
  const ours = argv.length >= launcher.length && launcher.every((w, i) => argv[i] === w);
  const extra = mark ? [mark] : [];
  if (!ours) {
    assertTypable([...argv, ...extra], platform);
    return { argv, file: null };
  }
  assertTypable([...launcher, LAUNCH_FLAG, launchDir(), ...extra], platform);
  const file = writeLaunch({ cwd: dir, argv: argv.slice(launcher.length) });
  return { argv: [...launcher, LAUNCH_FLAG, file], file };
}
