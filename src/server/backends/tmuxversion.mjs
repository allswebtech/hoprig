// Which tmux the tmux backend (./tmux.mjs) can use. Apart from it, so setup can ask without loading the terminal
// module.

/**
 * Whether the line `tmux -V` prints ("tmux 3.3a", "tmux next-3.5") names tmux 3.2 or newer. Older ones (3.0a on
 * Ubuntu 20.04, 3.1c on Debian 11) know neither `new-session -e` nor the client option `-T`: no session would
 * start. A build without a number ("tmux master") is taken as new.
 */
export function tmuxNewEnough(versionLine) {
  const m = /(\d+)\.(\d+)/.exec(String(versionLine));
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 3 || (major === 3 && minor >= 2);
}
