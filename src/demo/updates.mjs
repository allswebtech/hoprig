// Settings → Updates in the demo: sample versions, and an "update" that only prints a line. Nothing here looks at
// the real computer or asks a server (the demo must never show or change the owner's own installs).
import { ALL_TOOLS, TOOL_IDS } from '../codetools/index.mjs';

const say = (id, version) => async ({ onLine = () => {} } = {}) => {
  onLine(`(demo) ${id} would be updated here; nothing is installed in the demo`);
  return { ok: true, version, output: '' };
};

const item = (id, title, whenRunning, info, o = {}) => ({
  id, title, whenRunning, installable: !!o.installable,
  info: async () => info,
  update: say(id, info.latest),
  blocked: () => o.blocked || null,
  autoOk: () => o.autoOk !== false,
});

/** The rows of the page: a coding tool's only while this version offers it (src/codetools/index.mjs). */
export function demoUpdateItems() {
  const shown = (i) => !ALL_TOOLS.some((t) => t.id === i.id) || TOOL_IDS.includes(i.id);
  return [
    item('hoprig', 'Hoprig', 'The new version is used after the dashboard restarts: sessions kept by tmux go on through the restart, sessions in the built-in terminals end then (their conversations can be continued). From a git checkout Hoprig never updates by itself.',
      { installed: '0.1.0', latest: '0.1.0', method: 'npm', updateAvailable: false, canUpdate: true }),
    item('claude', 'Claude Code', 'Running sessions keep the version they started with and use the new one when they start again. Automatic updates wait until no Claude Code session is working.',
      { installed: '2.1.330', latest: '2.1.332', method: 'official installer', updateAvailable: true, canUpdate: true }),
    item('codex', 'Codex', 'Close its sessions first: the update replaces the program\'s files. Automatic updates wait until no Codex session is open.',
      { installed: '0.169.0', latest: '0.170.1', method: "Hoprig's tools folder", updateAvailable: true, canUpdate: true, note: 'Installs 0.169.0 at first, the version this Hoprig is tested with.' }),
    item('opencode', 'OpenCode', 'Close its sessions first: the update replaces the program\'s files. Automatic updates wait until no OpenCode session is open.',
      { installed: null, latest: '2.3.0', method: "Hoprig's tools folder", updateAvailable: false, canUpdate: true, note: 'Installs 2.3.0 at first, the version this Hoprig is tested with.' }, { installable: true }),
    item('cloudflared', 'Tunnel helper (cloudflared)', 'Turn the public link off first: a Temporary link comes back with a new address. Automatic updates wait until the public link is off.',
      { installed: '2026.10.1', latest: '2026.10.1', method: "Hoprig's add-ons folder", updateAvailable: false, canUpdate: true }),
  ].filter(shown);
}
