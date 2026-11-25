// The lowest Node.js Hoprig supports, in one place: 24.13.1, a long-term-support release of Node 24 ("Krypton").
// The guard every start of the command makes (src/nodeguard.mjs), doctor's line, the test runner, the installers and
// the package's "engines" all say this one version.
//
// Why 24: Node 22 is no longer supported (fewer versions to test, and the public test runs end sooner); Node 20 is
// past its end of life and aborts when the terminal it runs in is closed under it. Why 24.13.1 and not 24.0: on every
// release of 24 before it, fs.rmSync of a link to a folder throws "Path is a directory" instead of removing the link
// (seen on 24.0.0, 24.1.0, 24.5.0, 24.11.0 and 24.13.0; 24.13.1 removes it, as 22 and 26 do).
// No imports: src/nodeguard.mjs loads this before anything else of Hoprig.

export const MIN_NODE = '24.13.1';
/** The floor as a person reads it: "24.13.1" (a ".0" at the end is left out). */
export const MIN_NODE_TEXT = MIN_NODE.replace(/\.0$/, '');
export const MIN_NODE_MAJOR = Number(MIN_NODE.split('.')[0]);

/** The one line that installs the newest long-term Node.js (and Hoprig with it): the installer of that system. */
export function installLine(platform = process.platform) {
  return platform === 'win32'
    ? 'irm https://raw.githubusercontent.com/allswebtech/hoprig/main/install.ps1 | iex'
    : 'curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh';
}

/** True when `version` ("24.13.1" or "v24.13.1") is older than MIN_NODE, or cannot be read (never taken for new enough). */
export function belowFloor(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return true;
  const [a, b, c] = m.slice(1).map(Number);
  const [x, y, z] = MIN_NODE.split('.').map(Number);
  return a !== x ? a < x : b !== y ? b < y : c < z;
}
